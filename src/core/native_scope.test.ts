import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { kiloCheckHooks } from "./kilo_protocol";
import { NativeScopeTracker, nativeScopeProblem, scopePathProblem, scopeEvidenceProblem, SCOPE_DENIED } from "./native_scope";
import { buildInvocation } from "./invocation";
import { createAutonomousGraph, validateGraphDocument } from "./graph";
import { SessionState } from "../shared/domain";

async function workspace(t:{after(fn:()=>Promise<unknown>):unknown}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"native scope-")),target=path.join(root,"target"),outside=path.join(root,"outside");
  await fs.mkdir(target);await fs.mkdir(outside);await fs.writeFile(path.join(target,"inside.txt"),"inside");await fs.writeFile(path.join(outside,"sentinel.txt"),"untouched");
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return{root,target,outside};
}
test("native read/glob/grep and literal shell inspection reject parent, home and sibling paths BEFORE execution",async t=>{
 const{target,outside}=await workspace(t),hooks=kiloCheckHooks({cwd:target,commands:[],scopeRoots:[target]});let executed=0;
 const invoke=async(tool:string,args:Record<string,unknown>)=>{await hooks["tool.execute.before"]({tool},{args});executed++;};
 for(const[tool,args]of [
  ["glob",{path:path.dirname(target),pattern:"**/*"}],["glob",{path:"~/.config/kilo",pattern:"**/*"}],
  ["read",{filePath:path.join(outside,"sentinel.txt")}],["read",{filePath:"../outside/sentinel.txt"}],
  ["grep",{path:outside,pattern:"secret"}],["glob",{pattern:outside+"/**/*"}],
  ["glob",{path:target,pattern:"**/../outside/*"}],["bash",{command:`ls '${outside}'`}],
  ["bash",{command:"ls \"$HOME\""}],["bash",{command:"cat ../outside/sentinel.txt"}],
 ]as Array<[string,Record<string,unknown>]>)await assert.rejects(invoke(tool,args),/AGENT_GRAPH_SCOPE_DENIED/);
 assert.equal(executed,0);
 for(const[tool,args]of [["glob",{pattern:"**/*"}],["grep",{pattern:"/not/a/filesystem/path|403"}],["read",{filePath:"inside.txt"}],["bash",{command:"ls -la && cat inside.txt"}]]as Array<[string,Record<string,unknown>]>)await invoke(tool,args);
 assert.equal(executed,4);assert.equal(await fs.readFile(path.join(outside,"sentinel.txt"),"utf8"),"untouched");
 assert.equal(nativeScopeProblem("glob",{path:outside,pattern:"*"},target,[target,outside]),null,"explicitly approved roots remain usable");
 assert.ok(scopePathProblem(path.join(target+"-other","x"),target,[target]));
 assert.equal(scopePathProblem("C:\\work space\\game\\inside.txt","C:\\work space\\game",["C:\\work space\\game"]),null);
 assert.ok(scopePathProblem("C:\\work space\\game-other","C:\\work space\\game",["C:\\work space\\game"]));
});
test("explicit and recursive symlink escapes are denied while approved and internal links remain usable",async t=>{
 const{target,outside}=await workspace(t),nested=path.join(target,"nested");await fs.mkdir(nested);
 await fs.symlink(outside,path.join(nested,"escape"),process.platform==="win32"?"junction":"dir");
 assert.match(nativeScopeProblem("read",{filePath:path.join(nested,"escape/sentinel.txt")},target,[target])!,/symlink/);
 assert.match(nativeScopeProblem("glob",{pattern:"**/*"},target,[target])!,/link outside/);
 assert.match(nativeScopeProblem("grep",{pattern:"sentinel"},target,[target])!,/link outside/);
 assert.equal(nativeScopeProblem("glob",{pattern:"**/*"},target,[target,outside]),null);
 await fs.rm(path.join(nested,"escape"));await fs.symlink(nested,path.join(target,"internal"),process.platform==="win32"?"junction":"dir");
 assert.equal(nativeScopeProblem("glob",{pattern:"**/*"},target,[target]),null);
 assert.equal(nativeScopeProblem("read",{filePath:path.join(target,"new/output.json")},target,[target]),null,"new in-target files use their real parent boundary");
});
test("scope evidence retains denied versus actual accesses after bounded record eviction and blocks missing proof",async t=>{
 const{target,outside}=await workspace(t),tracker=new NativeScopeTracker(target,[target]);
 const event=(id:string,status:string,error?:string)=>({type:"tool_use",part:{id,tool:"glob",state:{status,input:{path:outside,pattern:"*"},...(error?{error}:{})}}});
 tracker.observe({type:"text",part:{text:SCOPE_DENIED}});
 for(let i=0;i<100;i++)tracker.observe(event("denied"+i,"error",SCOPE_DENIED+" blocked BEFORE execution"));
 assert.equal(tracker.audit.blockedCalls,100);assert.equal(tracker.audit.blocked.length,64);assert.equal(tracker.audit.outsideCalls,0);
 tracker.observe(event("escaped","completed"));tracker.observe(event("pending","running"));tracker.finish();
 assert.equal(tracker.audit.outsideCalls,1);assert.equal(tracker.audit.unresolvedCalls,1);
 const state={graph:createAutonomousGraph(),targetProjectPath:target,bindings:{planning:{connectionId:"kilo"}},connections:[{id:"kilo",type:"kilo"}],visits:[{nodeId:"planning",attempts:[{scopeAudit:tracker.audit}]}]}as unknown as SessionState;
 assert.match(scopeEvidenceProblem(state)!,/대상 밖/);delete state.visits[0]!.attempts[0]!.scopeAudit;assert.match(scopeEvidenceProblem(state)!,/증거/);
 delete state.graph.automation!.targetScopeGuard;assert.equal(scopeEvidenceProblem(state),null,"absent historical policy preserves compatibility");
});
test("all Kilo roles load invocation-local scope hooks, default-deny outside roots and preserve readonly/native settings",async t=>{
 const{target,outside}=await workspace(t),graph=createAutonomousGraph(),old=process.env.KILO_CONFIG_CONTENT;
 process.env.KILO_CONFIG_CONTENT=JSON.stringify({plugin:["kept-plugin"],permission:{read:{"*.env":"deny"}},model:"kept-model"});
 t.after(()=>{if(old===undefined)delete process.env.KILO_CONFIG_CONTENT;else process.env.KILO_CONFIG_CONTENT=old;});
 const connection={id:"kilo",label:"fixture",type:"kilo"as const,binary:path.resolve(__dirname,"../../../test/fixture_cli.cjs")};
 for(const node of graph.nodes){
  const invocation=await buildInvocation(connection,{connectionId:"kilo",modelId:"fixture-model"},node,{prompt:"scoped",cwd:target,fullAccess:false,allowedPaths:[outside],scopeRoots:[target,outside]});
  const config=JSON.parse(invocation.env.KILO_CONFIG_CONTENT!),protocol=JSON.parse(invocation.env.AGENT_GRAPH_KILO_CHECKS!);
  assert.equal(config.permission.external_directory["*"],"deny");assert.deepEqual(config.permission.read,{"*.env":"deny"});assert.equal(config.model,"kept-model");assert.ok(config.plugin.includes("kept-plugin"));assert.ok(config.plugin.some((p:string)=>p.endsWith("kilo_protocol_plugin.js")));assert.deepEqual(protocol.scopeRoots,[target,outside]);
  if(["planning","review","approval","interrupt"].includes(node.type))assert.equal(config.permission.bash,"deny");
 }
 assert.equal(validateGraphDocument(graph).automation!.targetScopeGuard,true);
 assert.throws(()=>validateGraphDocument({...graph,automation:{...graph.automation,targetScopeGuard:"yes"}}));
});
