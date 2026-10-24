import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { NodeTestPolicy, NodeTestProof, VerificationManifest } from "../shared/domain";
import { inside, sourceHashes } from "./verification_sources";
import { nodeTestScript, nodeTestProofProblem, validateNodeTestPolicy, nodeTestPolicyDigest } from "./node_test_policy";
import { atomicWriteJsonFile, checkProcessLiveness, delay } from "./resilience";
import { terminateProcessTreeBounded } from "./process_lifecycle";
import { StreamingRedactor } from "./process_output";

const sha = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
const same = (a: Record<string,string>, b: Record<string,string>): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
export interface NodeCaseResult {
  name: string; file: string; passed: boolean; skip: boolean; todo: boolean;
  errors: Array<{code:string;message:string}>;
}
export interface NodeJob {
  pid: number | null; stopped: boolean; error: string | null;
  summary?: {success:boolean;counts:{tests:number;passed:number;failed:number;skipped:number;cancelled:number;todo:number}};
  cases: NodeCaseResult[];
}
export interface NodeTestReport {
  version: 1; runId: string; startedAt: string; endedAt: string;
  allPassed: boolean; processesStopped: boolean; workspacesRemoved: boolean;
  policyDigest: string; sourceHashes: Record<string,string>; excludedSuppliedFiles: string[];
  error: string | null; workers: Array<{pid:number;stopped:boolean}>;
  scopes: Array<{
    id:string;file:string;status:"passed"|"failed"|"not_run";baseline?:NodeJob;
    challenges:Array<{id:string;status:"passed"|"failed"|"not_run";control?:NodeJob;mutant?:NodeJob;killedBy:string[];error?:string}>;
  }>;
}
const passing = (job: NodeJob): boolean => job.stopped && !job.error && job.summary?.success === true && job.summary.counts.tests > 0 && [job.summary.counts.failed,job.summary.counts.skipped,job.summary.counts.cancelled,job.summary.counts.todo].every(n=>n===0);
function baselineProblem(job: NodeJob, scope: NodeTestPolicy["scopes"][number]): string | null {
  if (!passing(job)) return job.error ?? "Authored Node suite failed, skipped, cancelled, leaked or ran no tests.";
  for (const name of scope.cases) {
    const cases = job.cases.filter(c=>c.name===name && typeof c.file==="string" && c.file.replace(/\\/g,"/").endsWith("/"+scope.file) && c.passed && !c.skip && !c.todo);
    if (cases.length!==1) return `Required authored test must pass exactly once: ${name}`;
  }
  return null;
}
function groupAlive(pid: number): boolean {
  try { process.kill(-pid,0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function runJob(root:string,file:string,out:string,signal:AbortSignal):Promise<NodeJob> {
  signal.throwIfAborted();
  const result: NodeJob = {pid:null,stopped:true,error:null,cases:[]};
  const output = path.join(out,"node-result.json"), log = await fs.open(path.join(out,"node-output.log"),"w");
  const secrets = Object.entries(process.env).filter(([k,v])=>/key|token|secret|password/i.test(k)&&v&&v.length>=4).map(([,v])=>v!);
  const redactors = [new StreamingRedactor(secrets),new StreamingRedactor(secrets)];
  let writes=Promise.resolve(), bytes=0;
  const record=(text:string,index:number)=>{const clean=redactors[index]!.push(text);if(bytes+Buffer.byteLength(clean)>1024*1024)return;bytes+=Buffer.byteLength(clean);writes=writes.then(()=>log.writeFile(clean));};
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,[path.join(__dirname,"node_test_worker.js"),file,output],{cwd:root,env,stdio:["ignore","pipe","pipe"],detached:process.platform!=="win32",windowsHide:true});
  child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
  const closed=new Promise<void>(resolve=>{child.once("close",()=>resolve());child.once("error",error=>{result.error=error.message;resolve();});});
  child.stdout.on("data",chunk=>record(chunk.toString(),0));child.stderr.on("data",chunk=>record(chunk.toString(),1));
  result.pid=child.pid??null;result.stopped=!child.pid;
  try {
    const deadline=Date.now()+20_000;
    for (;;) {
      signal.throwIfAborted();
      try {
        if((await fs.stat(output)).size>4*1024*1024)throw Error("Node worker result limit exceeded.");
        const raw=await fs.readFile(output,"utf8"),redactor=new StreamingRedactor(secrets);
        const data=JSON.parse(redactor.push(raw)+redactor.flush());
        if(data.version!==1||!Array.isArray(data.cases)||!data.summary)throw Error("Invalid worker result");
        result.summary=data.summary;result.cases=data.cases;break;
      } catch(error) {
        if((error as NodeJS.ErrnoException).code!=="ENOENT" && !(error instanceof SyntaxError))throw error;
      }
      if(result.error||child.exitCode!==null||child.signalCode)throw Error(result.error??"Node worker exited without authoritative results.");
      if(Date.now()>deadline)throw Error("Authored Node suite timed out; timeouts never count as mutation kills.");
      await delay(20);
    }
  } catch(error) { result.error=error instanceof Error?error.message:String(error); }
  finally {
    if(child.pid){
      if(process.platform==="win32")await terminateProcessTreeBounded(child.pid,2000);
      else { try{process.kill(-child.pid,"SIGTERM");}catch{} }
      await Promise.race([closed,delay(2000)]);
      if(process.platform!=="win32"&&groupAlive(child.pid)){
        try{process.kill(-child.pid,"SIGKILL");}catch{}
        for(let n=0;n<40&&groupAlive(child.pid);n++)await delay(25);
      }
      result.stopped=checkProcessLiveness(child.pid)==="dead"&&(process.platform==="win32"||!groupAlive(child.pid));
      if(!result.stopped)result.error="Node test process tree cleanup could not be verified.";
    }
    for(const redactor of redactors){const tail=redactor.flush();writes=writes.then(()=>log.writeFile(tail));}
    await writes;await log.close();
  }
  return result;
}

/** Runs only as a native-approved CLI command; original project tests are never edited. */
export async function runNodeTestVerification(options:{target:string;manifest:VerificationManifest;signal?:AbortSignal;timeoutMs?:number}):Promise<NodeTestReport> {
  const root=await fs.realpath(options.target),policy=validateNodeTestPolicy(options.manifest.nodeTests,options.manifest);
  const output=await inside(root,"verification/node-tests",true),runId=randomUUID(),out=await inside(root,path.join(output,runId),true);
  const controller=new AbortController(),abort=()=>controller.abort(options.signal?.reason);options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(Error("Own Node verification total timeout")),Math.min(options.timeoutMs??180000,180000));timer.unref();
  const report:NodeTestReport={version:1,runId,startedAt:new Date().toISOString(),endedAt:"",allPassed:false,processesStopped:true,workspacesRemoved:true,policyDigest:nodeTestPolicyDigest(policy),sourceHashes:{},excludedSuppliedFiles:options.manifest.protectedFiles,error:null,workers:[],scopes:policy.scopes.map(s=>({id:s.id,file:s.file,status:"not_run",challenges:s.challenges.map(c=>({id:c.id,status:"not_run",killedBy:[]}))}))};
  let counter=0;
  const workspaces:string[]=[];
  const job=async(scope:NodeTestPolicy["scopes"][number],challenge?:NodeTestPolicy["scopes"][number]["challenges"][number],enabled=false):Promise<NodeJob>=>{
    controller.signal.throwIfAborted();
    const folder=await inside(root,path.join(out,String(++counter).padStart(3,"0")),true),work=await inside(root,path.join(folder,"work"),true);workspaces.push(work);
    for(const file of Object.keys(report.sourceHashes)){
      controller.signal.throwIfAborted();
      if(options.manifest.protectedFiles.includes(file)||file===".agent-graph/verification.json")continue;
      const destination=path.join(work,file);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(await inside(root,file),destination);
    }
    if(challenge){
      const before=await sourceHashes(work,path.join(work,"verification"));
      const adapterFile=await inside(root,challenge.adapter);
      // Preserve native ESM import under this CommonJS package.
      const adapter=await (new Function("url","return import(url)") as (url:string)=>Promise<{mutate:(input:{root:string;enabled:boolean;id:string})=>Promise<Record<string,string>>}>)(require("node:url").pathToFileURL(adapterFile).href);
      const replacements=await adapter.mutate({root:work,enabled,id:challenge.id});
      if(!replacements||typeof replacements!=="object"||Array.isArray(replacements)||!Object.keys(replacements).length||Object.keys(replacements).some(file=>!challenge.targets.includes(file))||Object.values(replacements).some(content=>typeof content!=="string"||Buffer.byteLength(content)>1024*1024))throw Error("Mutation adapter must return only declared production replacements.");
      for(const[file,content]of Object.entries(replacements)){
        const destination=path.resolve(work,file);await inside(work,path.dirname(destination),true);
        if((await fs.lstat(destination).catch(()=>null))?.isSymbolicLink())throw Error("Mutation targets cannot be symlinks.");
        await fs.writeFile(destination,content);
      }
      const after=await sourceHashes(work,path.join(work,"verification"));
      if([...new Set([...Object.keys(before),...Object.keys(after)])].some(file=>before[file]!==after[file]&&!challenge.targets.includes(file)))throw Error("Mutation adapter modified undeclared files or authored tests.");
    }
    const inputs=await sourceHashes(work,path.join(work,"verification"));
    const result=await runJob(work,path.join(work,scope.file),folder,controller.signal);
    if(!same(inputs,await sourceHashes(work,path.join(work,"verification"))))result.error="Authored tests changed production or test source while executing.";
    if(result.pid)report.workers.push({pid:result.pid,stopped:result.stopped});
    if(!result.stopped)report.processesStopped=false;
    await atomicWriteJsonFile(path.join(folder,"result.json"),result);
    if(result.stopped)await fs.rm(work,{recursive:true,force:true});
    return result;
  };
  try {
    report.sourceHashes=await sourceHashes(root,out);
    const pkg=JSON.parse(await fs.readFile(await inside(root,"package.json"),"utf8"));
    if(pkg.scripts?.test!==nodeTestScript(policy))throw Error(`npm test must run exactly the authored scope files: ${nodeTestScript(policy)}`);
    for(const scope of policy.scopes)await inside(root,scope.file);
    for(const[scopeIndex,scope]of policy.scopes.entries()){
      const item=report.scopes[scopeIndex]!;item.status="failed";item.baseline=await job(scope);
      const problem=baselineProblem(item.baseline,scope);if(problem)throw Error(`${scope.id}: ${problem}`);
      for(const[index,challenge]of scope.challenges.entries()){
        const evidence=item.challenges[index]!;evidence.status="failed";
        evidence.control=await job(scope,challenge,false);
        const controlProblem=baselineProblem(evidence.control,scope);if(controlProblem)throw Error(`${challenge.id} control: ${controlProblem}`);
        evidence.mutant=await job(scope,challenge,true);
        if(evidence.mutant.error||!evidence.mutant.stopped||!evidence.mutant.summary||evidence.mutant.summary.counts.cancelled||evidence.mutant.summary.counts.skipped||evidence.mutant.summary.counts.todo)throw Error(`${challenge.id}: invalid/unfinished mutant execution; never a kill. ${evidence.mutant.error??JSON.stringify(evidence.mutant.summary?.counts??{})}. Await assertions through rejected promises and close owned servers/handles in after/finally even when assertions fail.`);
        evidence.killedBy=[...new Set(evidence.mutant.cases.filter(c=>scope.cases.includes(c.name)&&!c.passed&&!c.skip&&!c.todo&&c.errors.some(e=>e.code==="ERR_ASSERTION")).map(c=>c.name))];
        if(evidence.mutant.summary.success||!evidence.killedBy.length){evidence.error="Required authored assertions did not detect this production defect.";throw Error(`${scope.id}/${challenge.id}: ${evidence.error}`);}
        evidence.status="passed";
      }
      item.status="passed";
    }
    if(!same(report.sourceHashes,await sourceHashes(root,out)))throw Error("Original project source/tests changed during own Node verification.");
    report.allPassed=true;
  } catch(error){report.error=error instanceof Error?error.message:String(error);}
  finally {
    clearTimeout(timer);options.signal?.removeEventListener("abort",abort);
    if(report.processesStopped){for(const work of workspaces)await fs.rm(work,{recursive:true,force:true}).catch(()=>{report.workspacesRemoved=false;});}
    else report.workspacesRemoved=false;
    report.allPassed&&=report.processesStopped&&report.workspacesRemoved;
    report.endedAt=new Date().toISOString();await atomicWriteJsonFile(path.join(out,"report.json"),report);await atomicWriteJsonFile(path.join(output,"report.json"),report);
  }
  return report;
}

/** Keep repair feedback visible even when native tools truncate a large report. */
export function summarizeNodeTestReport(report:NodeTestReport) {
  const job=(value:NodeJob|undefined)=>value?{
    stopped:value.stopped,error:value.error,counts:value.summary?.counts,
    failures:value.cases.filter(c=>!c.passed).slice(0,12).map(c=>({name:c.name,skip:c.skip,todo:c.todo,errors:c.errors.map(e=>({code:e.code,message:e.message.slice(0,200)}))})),
  }:undefined;
  return {
    version:report.version,runId:report.runId,allPassed:report.allPassed,error:report.error,
    reportFile:"verification/node-tests/report.json",processesStopped:report.processesStopped,workspacesRemoved:report.workspacesRemoved,
    scopes:report.scopes.map(s=>({id:s.id,file:s.file,status:s.status,baseline:job(s.baseline),challenges:s.challenges.map(c=>({id:c.id,status:c.status,killedBy:c.killedBy,error:c.error,control:job(c.control),mutant:job(c.mutant)}))})),
  };
}

/** Revalidate both production and authored tests before accepting a report/audit. */
export async function readNodeTestProof(target:string,policy:NodeTestPolicy):Promise<NodeTestProof> {
  const root=await fs.realpath(target),file=await inside(root,"verification/node-tests/report.json"),raw=await fs.readFile(file);
  if(raw.length>8*1024*1024)throw Error("Own Node report is too large.");
  const report=JSON.parse(raw.toString()) as NodeTestReport;
  if(report.version!==1||!report.allPassed||!report.processesStopped||!report.workspacesRemoved||report.error||report.policyDigest!==nodeTestPolicyDigest(policy)||!same(report.sourceHashes,await sourceHashes(root,path.join(root,"verification/node-tests"))))throw Error("자체 Node 검사 보고가 실패·미완료이거나 현재 소스/테스트와 일치하지 않습니다.");
  const proof:NodeTestProof={version:1,runId:report.runId,reportDigest:sha(raw),sourceHashes:report.sourceHashes,scopes:policy.scopes.map(scope=>{
    const actual=report.scopes.find(s=>s.id===scope.id);
    if(!actual||actual.file!==scope.file||actual.status!=="passed"||!actual.baseline||baselineProblem(actual.baseline,scope))throw Error(`Invalid own Node baseline: ${scope.id}`);
    for(const challenge of scope.challenges){const result=actual.challenges.find(c=>c.id===challenge.id);if(!result||result.status!=="passed"||!result.control||baselineProblem(result.control,scope)||!result.mutant||result.mutant.error||!result.mutant.stopped||!result.killedBy.some(name=>scope.cases.includes(name)))throw Error(`Invalid own Node challenge: ${challenge.id}`);}
    return {id:scope.id,file:scope.file,cases:[...scope.cases],challenges:scope.challenges.map(c=>c.id)};
  })};
  const problem=nodeTestProofProblem(policy,proof);if(problem)throw Error(problem);
  return proof;
}
