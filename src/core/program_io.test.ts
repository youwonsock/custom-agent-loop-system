import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { prepareProgramIo, wrapProgramCommand, unwrapProgramCommand, ProgramIoTracker, ProgramIoPolicy, programIoEvidenceProblem, IO_UNAVAILABLE } from "./program_io";
import { kiloCheckHooks } from "./kilo_protocol";
import { InspectionTracker } from "./inspection_evidence";
import { CommandTracker } from "./verification_evidence";
import { SessionState } from "../shared/domain";
import { createAutonomousGraph, validateGraphDocument } from "./graph";
import { ProcessSupervisor } from "./process_supervisor";
import { buildInvocation } from "./invocation";
import { vmRuntimeAvailable } from "./program_io_vm";

const mac=process.platform==="darwin",sq=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
async function workspace(t:{after(fn:()=>Promise<unknown>):unknown},role:"implementation"|"test"|"review"="implementation",backend:"macos-seatbelt"|"apple-container-vm"="macos-seatbelt"){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),"program io-")),target=path.join(root,"target"),outside=path.join(root,"outside");await fsp.mkdir(target);await fsp.mkdir(outside);await fsp.writeFile(path.join(outside,"sentinel.txt"),"unchanged");await fsp.writeFile(path.join(target,"inside.txt"),"inside");
  await fsp.writeFile(path.join(target,"frozen.txt"),"frozen");t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const policy=prepareProgramIo({cwd:target,directory:path.join(root,"broker"),testRole:role==="test",readOnly:role==="review",protectedFiles:["frozen.txt"],backend});
  return{root,target,outside,policy};
}
function run(command:string,policy:ProgramIoPolicy){
  const wrapped=wrapProgramCommand(command,policy),words=unwrapProgramCommand(wrapped,policy);assert.equal(words?.command,command);
  const child=spawnSync("/bin/sh",["-c",wrapped],{cwd:policy.cwd,env:{...process.env,AGENT_GRAPH_PROGRAM_IO:JSON.stringify(policy)},encoding:"utf8",timeout:20000,maxBuffer:2*1024*1024});
  const event={type:"tool_use",part:{id:words!.id,tool:"bash",state:{status:"completed",input:{command:wrapped},metadata:{exit:child.status},output:child.stdout}}};
  return{child,event,wrapped};
}
test("kernel confinement blocks direct, child, symlink, hardlink, listing, stat and outside writes without exposing host secrets",{skip:!mac},async t=>{
  const{policy,outside,target}=await workspace(t);
  const code=`const f=require('node:fs'),c=require('node:child_process'),out=${JSON.stringify(outside)};let denied=0;for(const fn of [()=>f.readFileSync(out+'/sentinel.txt'),()=>f.writeFileSync(out+'/sentinel.txt','bad'),()=>f.readdirSync(out),()=>f.statSync(out+'/sentinel.txt'),()=>f.linkSync(out+'/sentinel.txt','link'),()=>{f.symlinkSync(out,'escape');f.readFileSync('escape/sentinel.txt')},()=>f.linkSync(${JSON.stringify(policy.runner)},'runtime-link'),()=>f.writeFileSync('frozen.txt','bad')]){try{fn()}catch(e){if(['EPERM','EACCES'].includes(e.code))denied++}}const r=c.spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync(process.argv[1]);process.exit(7)}catch(e){process.exit(e.code==='EPERM'?0:8)}",out+'/sentinel.txt']);f.writeFileSync('inside-ok.txt','yes');console.log(JSON.stringify({denied,child:r.status,secret:!!process.env.AGENT_GRAPH_PROGRAM_IO||!!process.env.AGENT_GRAPH_TEST_SECRET,home:process.env.HOME,tmp:process.env.TMPDIR}));`;
  const old=process.env.AGENT_GRAPH_TEST_SECRET;process.env.AGENT_GRAPH_TEST_SECRET="must-never-reach-program";
  let result;try{result=run("node -e "+sq(code),policy);}finally{if(old===undefined)delete process.env.AGENT_GRAPH_TEST_SECRET;else process.env.AGENT_GRAPH_TEST_SECRET=old;}
  assert.equal(result.child.status,0,result.child.stderr);const data=JSON.parse(result.child.stdout);assert.equal(data.denied,8);assert.equal(data.child,0);assert.equal(data.secret,false);assert.ok(data.home.startsWith(fs.realpathSync(target)));assert.ok(data.tmp.startsWith(fs.realpathSync(target)));assert.equal(fs.readFileSync(path.join(outside,"sentinel.txt"),"utf8"),"unchanged");assert.equal(fs.readFileSync(path.join(target,"frozen.txt"),"utf8"),"frozen");
  const tracker=new ProgramIoTracker(policy);tracker.normalize(result.event);const audit=tracker.finish();assert.equal(audit.completedCommands,1);assert.equal(audit.invalidReceipts,0);assert.equal(audit.unresolvedCommands,0);assert.equal(audit.commands[0]!.processGroupStopped,true);
});
test("test and review kernel profiles prevent product writes while preserving scratch, exact exit codes and read evidence",{skip:!mac},async t=>{
  for(const role of ["test","review"]as const){
    const{policy,target}=await workspace(t,role);const code="try{require('node:fs').writeFileSync('inside.txt','bad');process.exit(9)}catch(e){console.log(e.code)}";
    const result=run("node -e "+sq(code),policy);assert.equal(result.child.status,0,result.child.stderr);assert.match(result.child.stdout,/EPERM/);assert.equal(fs.readFileSync(path.join(target,"inside.txt"),"utf8"),"inside");
    const cat=run("cat inside.txt",policy);assert.equal(cat.child.status,0,cat.child.stderr);const tracker=new ProgramIoTracker(policy);const inspections=new InspectionTracker(target);inspections.observe(tracker.normalize(cat.event));assert.deepEqual(inspections.files,["inside.txt"]);
  }
});
test("signed broker receipts reject modified/replayed/unwrapped evidence and preserve failing registered checks",{skip:!mac},async t=>{
  const{policy}=await workspace(t);const command="node --test verification/check.test.cjs";fs.mkdirSync(path.join(policy.cwd,"verification"),{recursive:true});fs.writeFileSync(path.join(policy.cwd,"verification/check.test.cjs"),"require('node:test')('failure',()=>require('node:assert').equal(1,2));");
  const result=run(command,policy);assert.equal(result.child.status,1,result.child.stderr);const tracker=new ProgramIoTracker(policy),commands=new CommandTracker(policy.cwd,true);commands.observe(tracker.normalize(result.event));assert.equal(commands.receipts[0]!.exitCode,1);assert.equal(commands.receipts[0]!.command,command);assert.equal(tracker.finish().completedCommands,1);
  assert.equal(unwrapProgramCommand(result.wrapped.replace(/.$/,"X"),policy),null);
  const unwrapped=new ProgramIoTracker(policy);unwrapped.normalize({...result.event,part:{...result.event.part,state:{...result.event.part.state,input:{command}}}});assert.equal(unwrapped.finish().unwrappedCommands,1);
  fs.appendFileSync(path.join(policy.directory,"receipts.jsonl"),'{"data":{"type":"end"},"signature":"forged"}\n');assert.ok(tracker.finish().invalidReceipts);
});
test("isolated hooks disable alternate tool hosts and retain strict test/readonly command policies",{skip:!mac},async t=>{
  const{policy,target}=await workspace(t);const hooks=kiloCheckHooks({cwd:target,commands:["npm test"],scopeRoots:[target],programIo:policy,testSourcesReadOnly:true});
  for(const tool of ["read","write","glob","task","mcp_read","lsp"])await assert.rejects(hooks['tool.execute.before']({tool},{args:{filePath:path.join(target,"inside.txt")}}),/IO_UNAVAILABLE/);
  await assert.rejects(hooks['tool.execute.before']({tool:'bash'},{args:{command:'node -e "0"'}}),/TEST_POLICY/);
  const output={args:{command:"npm test"}};await hooks['tool.execute.before']({tool:'bash'},output);assert.equal(unwrapProgramCommand(output.args.command,policy)!.command,"npm test");
  const readonly=kiloCheckHooks({cwd:target,commands:[],scopeRoots:[target],programIo:policy,readOnlyRole:true});await assert.rejects(readonly['tool.execute.before']({tool:'bash'},{args:{command:'mkdir -p verification'}}),/IO_UNAVAILABLE/);
});
test("signed after-hook evidence authenticates CLI versions retaining original tool inputs",{skip:!mac},async t=>{
 const{policy,target}=await workspace(t);const hooks=kiloCheckHooks({cwd:target,commands:[],scopeRoots:[target],programIo:policy});
 const original="cat inside.txt",output={args:{command:original}};await hooks['tool.execute.before']({tool:'bash'},output);
 const child=spawnSync('/bin/sh',['-c',output.args.command],{cwd:target,env:{...process.env,AGENT_GRAPH_PROGRAM_IO:JSON.stringify(policy)},encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const result:{metadata?:Record<string,unknown>}={metadata:{exit:child.status}};await hooks['tool.execute.after']!({tool:'bash',args:output.args},result);
 const event={type:'tool_use',part:{tool:'bash',state:{status:'completed',input:{command:original},metadata:result.metadata}}};
 const tracker=new ProgramIoTracker(policy);assert.equal((tracker.normalize(event).part as any).state.input.command,original);assert.equal(tracker.finish().completedCommands,1);assert.equal(tracker.finish().unwrappedCommands,0);
 const forged=new ProgramIoTracker(policy);forged.normalize({...event,part:{...event.part,state:{...event.part.state,input:{command:'cat outside.txt'}}}});assert.equal(forged.finish().unwrappedCommands,1);
});
test("missing isolation proof blocks success and absent legacy policy preserves compatibility",()=>{
 const s={graph:createAutonomousGraph(),targetProjectPath:"target",bindings:{planning:{connectionId:"kilo"}},connections:[{id:"kilo",type:"kilo"}],visits:[{nodeId:"planning",attempts:[{}]}]}as unknown as SessionState;
 assert.ok(programIoEvidenceProblem(s));delete s.graph.automation!.programIoGuard;assert.equal(programIoEvidenceProblem(s),null);
 const g=createAutonomousGraph();assert.equal(validateGraphDocument(g).automation!.programIoGuard,true);assert.throws(()=>validateGraphDocument({...g,automation:{...g.automation,targetScopeGuard:false}}));
 if(!mac)assert.throws(()=>prepareProgramIo({cwd:".",directory:"unused",testRole:false,readOnly:false}),new RegExp(IO_UNAVAILABLE.replace(/[\[\]]/g,"\\$&")));
});
test("native supervisor authenticates wrapped command exits and inspection evidence before the success gate",{skip:!mac},async t=>{
 const{policy,root,target}=await workspace(t);fs.mkdirSync(path.join(target,"verification"),{recursive:true});fs.writeFileSync(path.join(target,"verification/real.test.cjs"),"require('node:test')('real assertion',()=>require('node:assert').equal(2+2,4));");
 const script=path.join(root,"native-fixture.cjs");fs.writeFileSync(script,`const{wrapProgramCommand}=require(${JSON.stringify(path.join(__dirname,"program_io.js"))});const c=require('node:child_process'),p=JSON.parse(process.env.AGENT_GRAPH_PROGRAM_IO);let id=0;for(const original of ['cat inside.txt','node --test verification/real.test.cjs']){const command=wrapProgramCommand(original,p),r=c.spawnSync('/bin/sh',['-c',command],{cwd:p.cwd,env:process.env,encoding:'utf8'});console.log(JSON.stringify({type:'tool_use',part:{id:String(++id),tool:'bash',state:{status:'completed',input:{command},metadata:{exit:r.status},output:r.stdout+r.stderr}}}));}console.log(JSON.stringify({type:'text',part:{text:'[PHASE_DONE]'}}));`);
 const result=await new ProcessSupervisor().run({binary:process.execPath,args:[script],transport:"pipe",cwd:target,env:{...Object.fromEntries(Object.entries(process.env).filter((v):v is[string,string]=>typeof v[1]==="string")),AGENT_GRAPH_PROGRAM_IO:JSON.stringify(policy)},programIoPolicy:policy,scopeRoots:[target],cols:200,rows:40,useConpty:false,transportTimeoutMs:3000,idleTimeoutMs:5000,toolTimeoutMs:5000,phaseTimeoutMs:20000,terminationGraceMs:500,killTimeoutMs:500,maxInMemoryOutputBytes:1024*1024,rawLogPath:path.join(root,"native.log"),interactionWhitelist:[],destructivePrompts:[],sensitiveValues:[policy.privateKey]});
 assert.equal(result.outcome,"succeeded",result.failureMessage??result.output);assert.equal(result.evidence.programIoAudit!.completedCommands,2);assert.equal(result.evidence.programIoAudit!.invalidReceipts,0);assert.equal(result.evidence.commands[0]!.exitCode,0);assert.equal(result.evidence.commands[0]!.command,"node --test verification/real.test.cjs");assert.ok(result.evidence.readFiles!.includes("inside.txt"));assert.ok(!fs.readFileSync(path.join(root,"native.log"),"utf8").includes(policy.privateKey));
});
test("strong invocation isolates provider configuration and exposes only sandboxed bash without changing legacy invocations",{skip:!mac},async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),"io invocation-"));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const target=path.join(root,"target");await fsp.mkdir(target);const graph=createAutonomousGraph();
 const build=()=>buildInvocation({id:"kilo",label:"fixture",type:"kilo",binary:path.resolve(__dirname,"../../../test/fixture_cli.cjs")},{connectionId:"kilo",modelId:"fixture-model"},graph.nodes.find(n=>n.type==="review")!,{prompt:"inspect",cwd:target,fullAccess:false,allowedPaths:[],scopeRoots:[target],programIoGuard:{directory:path.join(root,"broker"),protectedFiles:[],expiresAt:Date.now()+60000}});
 if(!vmRuntimeAvailable()){await assert.rejects(build(),/IO_UNAVAILABLE/);return;}
 const result=await build();
 const config=JSON.parse(result.env.KILO_CONFIG_CONTENT!),protocol=JSON.parse(result.env.AGENT_GRAPH_KILO_CHECKS!);assert.equal(config.permission.bash,"allow");assert.equal(config.permission["*"],"deny");assert.equal(config.tools.read,false);assert.equal(config.tools.bash,true);assert.equal(config.snapshot,false);assert.equal(config.lsp,false);assert.equal(config.formatter,false);assert.deepEqual(config.mcp,{});assert.equal(config.plugin.length,1);assert.equal(protocol.readOnlyRole,true);assert.ok(result.env.HOME!.startsWith(root));assert.equal(result.env.KILO_DISABLE_PROJECT_CONFIG,"true");assert.equal(result.env.NODE_OPTIONS,"");assert.ok(result.programIoPolicy!.preflightPassed);
});
test("isolated VM programs cannot use host loopback services as filesystem delegates",{skip:!mac||!vmRuntimeAvailable()},async t=>{
 const{policy}=await workspace(t,"implementation","apple-container-vm");const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert.ok(address&&typeof address!=="string");
 const code=`const s=require('node:net').connect({host:'127.0.0.1',port:${address.port}});s.on('connect',()=>process.exit(9));s.on('error',e=>{console.log(e.code);process.exit(['EPERM','EACCES','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(e.code)?0:8)});setTimeout(()=>process.exit(7),2000);`;
 const result=run("node -e "+sq(code),policy);assert.equal(result.child.status,0,result.child.stderr);const tracker=new ProgramIoTracker(policy);tracker.normalize(result.event);assert.equal(tracker.finish().commands[0]!.containerRemoved,true);
});
test("VM boundary blocks host files, guest outside writes, and detached processes are destroyed before command acceptance",{skip:!mac||!vmRuntimeAvailable()},async t=>{
 const{policy,outside,target}=await workspace(t,"implementation","apple-container-vm");
 const code=`const f=require('node:fs'),c=require('node:child_process'),p=${JSON.stringify(path.join(outside,"sentinel.txt"))};let denied=0;for(const fn of [()=>f.readFileSync(p),()=>f.writeFileSync(p,'bad'),()=>f.readdirSync(${JSON.stringify(outside)}),()=>f.statSync(p),()=>f.writeFileSync('/tmp/agent-outside.txt','bad'),()=>f.writeFileSync('frozen.txt','bad')])try{fn()}catch(e){if(['EPERM','EACCES','ENOENT','EROFS'].includes(e.code))denied++}const q=c.spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync(process.argv[1]);process.exit(9)}catch(e){process.exit(e.code==='ENOENT'?0:8)}",p]);const bg=c.spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('late-write.txt','bad'),2000)"],{detached:true,stdio:'ignore'});bg.unref();console.log(JSON.stringify({denied,child:q.status,secret:!!process.env.AGENT_GRAPH_PROGRAM_IO}));`;
 const result=run("node -e "+sq(code),policy);assert.equal(result.child.status,0,result.child.stderr);assert.deepEqual(JSON.parse(result.child.stdout),{denied:6,child:0,secret:false});assert.equal(fs.readFileSync(path.join(outside,"sentinel.txt"),"utf8"),"unchanged");assert.equal(fs.readFileSync(path.join(target,"frozen.txt"),"utf8"),"frozen");
 const tracker=new ProgramIoTracker(policy);tracker.normalize(result.event);assert.equal(tracker.finish().commands[0]!.containerRemoved,true);await new Promise(resolve=>setTimeout(resolve,2200));assert.equal(fs.existsSync(path.join(target,"late-write.txt")),false);
});
test("VM Test and review mounts preserve product files while permitting owned verification scratch",{skip:!mac||!vmRuntimeAvailable()},async t=>{
 for(const role of ["test","review"]as const){
  const{policy,target}=await workspace(t,role,"apple-container-vm");const result=run("node -e "+sq("try{require('node:fs').writeFileSync('inside.txt','bad');process.exit(9)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e;console.log('readonly')}"),policy);assert.equal(result.child.status,0,result.child.stderr);assert.equal(result.child.stdout.trim(),"readonly");assert.equal(fs.readFileSync(path.join(target,"inside.txt"),"utf8"),"inside");
 }
});
test("controller cleans only an orphaned policy VM and retains invalid completion evidence",{skip:!mac||!vmRuntimeAvailable()},async t=>{
 const{policy}=await workspace(t,"implementation","apple-container-vm");const name=`agio-${policy.id.slice(0,16)}-orphan-fixture`;
 const child=spawnSync(policy.vm!.binary,['run','--detach','--name',name,'--network','none','--read-only','--progress','none',policy.vm!.image,'sleep','60'],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);
 const tracker=new ProgramIoTracker(policy);assert.equal(tracker.finish().invalidReceipts,1);
 const list=spawnSync(policy.vm!.binary,['list','--all','--format','json'],{encoding:'utf8'});assert.equal(list.status,0,list.stderr);assert.ok(!JSON.parse(list.stdout).some((item:{id?:string;configuration?:{id?:string}})=>(item.id??item.configuration?.id)===name));
});
