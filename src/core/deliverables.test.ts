import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionState, NodeVisit } from "../shared/domain";
import { createAutonomousGraph } from "./graph";
import { deriveRequirementLedger } from "./requirement_ledger";
import { deliverableProblem, deliverableInspectionProblem } from "./deliverables";
import { validateManifest, lockContract, contractViolation, validContractSnapshot } from "./verification_contract";
import { buildNodePrompt, buildRecoveryMessage } from "./prompt";

const manifest = {version:1, protectedFiles:["check.mjs"], checks:[{id:"acceptance",command:"node check.mjs",requirements:["REQ-001"]}], requiredFiles:[{path:"README.md",requirements:["REQ-001"]}]};
async function fixture(t: {after(fn:()=>Promise<unknown>):void}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deliverables-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,".agent-graph"));
  await fs.writeFile(path.join(root,"check.mjs"),"import assert from 'node:assert/strict'; assert.ok(true);\n");
  await fs.writeFile(path.join(root,".agent-graph/verification.json"),JSON.stringify(manifest));
  const graph=createAutonomousGraph();graph.automation!.browserVerification=false;
  return {root,state:{id:"test",targetProjectPath:root,goal:"Deliver README.md",graph,requirements:deriveRequirementLedger("Deliver README.md"),visits:[],additionalAllowedPaths:[],accessMode:"workspace_write"} as unknown as SessionState};
}
test("required files validate safe unique paths and mandatory requirement links without changing legacy manifests",()=>{
  assert.deepEqual(validateManifest(manifest,["REQ-001"],false).requiredFiles,manifest.requiredFiles);
  const {requiredFiles,...legacy}=manifest;assert.equal(validateManifest(legacy,["REQ-001"],false).requiredFiles,undefined);
  assert.match(deliverableInspectionProblem(validateManifest(manifest,["REQ-001"],false),[])!,/README.md/);
  assert.equal(deliverableInspectionProblem(validateManifest(manifest,["REQ-001"],false),["README.md"]),null);
  assert.equal(deliverableInspectionProblem(validateManifest(legacy,["REQ-001"],false),[]),null);
  for(const files of [[],[{path:"../README.md",requirements:["REQ-001"]}],[{path:"verification/README.md",requirements:["REQ-001"]}],[{path:"/README.md",requirements:["REQ-001"]}],[{path:"README.md",requirements:[]}],[{path:"README.md",requirements:["REQ-unknown"]}],[...requiredFiles,...requiredFiles]])assert.throws(()=>validateManifest({...manifest,requiredFiles:files},["REQ-001"],false));
});
test("missing, empty, directory and external symlink deliverables cannot hand off; repairs keep acceptance files frozen",async t=>{
  const {root,state}=await fixture(t),readme=path.join(root,"README.md");
  for(const locked of [false,true]){
    if(locked)state.verificationContract=await lockContract(state,"supplied");
    assert.match((await deliverableProblem(state))!,/README.md.*REQ-001/);
    await fs.writeFile(readme,"");assert.match((await deliverableProblem(state))!,/empty/);await fs.rm(readme);
    await fs.mkdir(readme);assert.match((await deliverableProblem(state))!,/non-regular/);await fs.rm(readme,{recursive:true});
    if(process.platform!=="win32"){
      await fs.symlink(path.join(root,".."),readme);assert.match((await deliverableProblem(state))!,/outside target/);await fs.rm(readme);
      await fs.symlink(path.join(root,"check.mjs"),readme);assert.match((await deliverableProblem(state))!,/non-regular/);await fs.rm(readme);
    }
    await fs.writeFile(readme,"Launch, rules, controls and tests\n");assert.equal(await deliverableProblem(state),null);
    if(locked){assert.equal(await contractViolation(state),null);assert.equal(validContractSnapshot(state.verificationContract),true);const changed=structuredClone(state.verificationContract!);changed.manifest!.requiredFiles=[];assert.equal(validContractSnapshot(changed),false);}
    await fs.rm(readme);
  }
});
test("legacy contracts and missing pending contracts keep their preparation path, malformed contracts fail closed",async t=>{
  const {root,state}=await fixture(t);
  await fs.rm(path.join(root,".agent-graph/verification.json"));assert.equal(await deliverableProblem(state),null);
  await fs.writeFile(path.join(root,".agent-graph/verification.json"),"{bad");assert.match((await deliverableProblem(state))!,/cannot be checked/);
  state.graph.automation!.verificationContract=false;assert.equal(await deliverableProblem(state),null);
});
test("frozen test prompts and argument recovery never authorize documentation repair; implementation receives the current failure",async t=>{
  const {state}=await fixture(t);state.verificationContract=await lockContract(state,"supplied");
  const visit={id:"current",nodeId:"test",attempts:[],verifiedCommands:[]}as unknown as NodeVisit;
  const testNode=state.graph.nodes.find(n=>n.type==="test")!;
  const prompt=buildNodePrompt(state,testNode,visit);
  assert.doesNotMatch(prompt,/You may edit tests|add missing acceptance coverage/);
  assert.match(prompt,/documentation \(including README\)/);assert.match(prompt,/REQUIRED DELIVERABLE FILES/);
  const recovery=buildRecoveryMessage("tool_arguments","unavailable write","",[],"test",true);
  assert.match(recovery,/frozen TEST/);assert.doesNotMatch(recovery,/Use the permitted bash tool.*heredocs|write\(filePath/);
  state.visits=[{id:"failed",nodeId:"test",status:"failed",completedAt:new Date().toISOString(),output:"README.md missing; REQ-001 failed",attempts:[]}as unknown as NodeVisit];
  const repair=buildNodePrompt(state,state.graph.nodes.find(n=>n.type==="implementation")!,{...visit,nodeId:"implementation"});
  assert.match(repair,/CURRENT REPAIR HANDOFF/);assert.match(repair,/README.md missing; REQ-001 failed/);assert.match(repair,/fresh complete test visit/);
});
