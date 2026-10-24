import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testCommandAllowed, testSources, sourceDifference, testPolicyEvent, failedRegisteredCheck, TEST_POLICY } from "./test_source_guard";
import { kiloCheckHooks } from "./kilo_protocol";
import { CommandTracker, visitCommands } from "./verification_evidence";
import { NodeVisit } from "../shared/domain";
import { MutationTracker } from "./event_evidence";

test("test native pre-hook prevents source writes and arbitrary code without changing failed-check exit semantics",async()=>{
 const cwd=path.resolve("owned target"),commands=["npm test > verification/model-tests.txt 2>&1","node tests/verify-engine.mjs"];
 const hooks=kiloCheckHooks({cwd,commands,testSourcesReadOnly:true});
 for(const tool of ["write","edit","apply_patch"])await assert.rejects(hooks["tool.execute.before"]({tool},{args:{filePath:"app.mjs",content:"broken"}}),/AGENT_GRAPH_TEST_POLICY/);
 for(const command of ["cat > app.mjs <<'EOF'\nbroken\nEOF","node -e 'repair()'","npm test > app.mjs","cd /other && npm test","python repair.py","rg --pre touch pattern ."])
   await assert.rejects(hooks["tool.execute.before"]({tool:"bash"},{args:{command}}),/AGENT_GRAPH_TEST_POLICY/);
 for(const command of [commands[0]!,"npm test","mkdir -p verification","cat app.mjs | head -30",`cd '${cwd}' && node tests/verify-engine.mjs`])assert.equal(testCommandAllowed(command,cwd,commands),true,command);
 const output={args:{command:"npm test 2>&1 | tail -30"}};await hooks["tool.execute.before"]({tool:"bash"},output);assert.equal(output.args.command,commands[0]);
 const e={type:"tool_use",part:{id:"blocked",tool:"write",state:{status:"error",input:{filePath:"app.mjs"},error:`Error: ${TEST_POLICY} blocked before execution`}}};
 const mutations=new MutationTracker();mutations.observe(e);assert.equal(mutations.finish(),false,"prevented writes are not claimed as actual source mutations");assert.ok(testPolicyEvent(e));assert.equal(testPolicyEvent({type:"text",part:{text:TEST_POLICY}}),null);
});
test("output-only preparation keeps native receipts while source invalidation discards them for proof",()=>{
 const t=new CommandTracker(path.resolve("target"),true);
 t.observe({type:"item.completed",item:{id:"check",type:"command_execution",command:"node tests/verify-engine.mjs",exit_code:0}});
 t.observe({type:"tool_use",part:{id:"logs",tool:"bash",state:{status:"completed",input:{command:"mkdir -p verification"},metadata:{exit:0}}}});
 assert.equal(t.receipts.length,1);
 const visit={attempts:[{commands:t.receipts,verificationInvalidation:{at:"now",reason:"source edit",files:["app.mjs"]}}]}as unknown as NodeVisit;
 assert.deepEqual(visitCommands(visit),[]);
 assert.equal(failedRegisteredCheck([{id:"x",command:"npm test",exitCode:1,environmentError:null}],"",["npm test"])!.exitCode,1);
 assert.equal(failedRegisteredCheck([{id:"x",command:"npm test",exitCode:1,environmentError:"listen EPERM"}],"",["npm test"]),undefined,"environment restrictions keep their existing gate");
});
test("source guard includes authored tests/package and ignores verification output; edits and deletion invalidate",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"test-source-guard-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,"test"));await fs.mkdir(path.join(root,"verification"));await fs.writeFile(path.join(root,"app.mjs"),"app");await fs.writeFile(path.join(root,"package.json"),"{}");await fs.writeFile(path.join(root,"test/own.test.mjs"),"assert");
 const before=await testSources(root);await fs.writeFile(path.join(root,"verification/report.json"),"{}");assert.deepEqual(sourceDifference(before,await testSources(root)),[]);
 await fs.writeFile(path.join(root,"test/own.test.mjs"),"weakened");await fs.rm(path.join(root,"app.mjs"));assert.deepEqual(sourceDifference(before,await testSources(root)).sort(),["app.mjs","test/own.test.mjs"]);
});
