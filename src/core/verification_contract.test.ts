import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAutonomousGraph } from "./graph";
import { deriveRequirementLedger } from "./requirement_ledger";
import { CONTRACT_FILE, lockContract, contractViolation, validateManifest, validContractSnapshot, contractProofMissing } from "./verification_contract";
import { browserVerificationCommand } from "./browser_command";
import { SessionState } from "../shared/domain";
export const manifest = {version:1 as const,protectedFiles:["tests/verify-acceptance.mjs"],checks:[{id:"acceptance",command:"node tests/verify-acceptance.mjs",requirements:["REQ-001"]}]};
test("contracts require bounded safe paths, unique actual checks and complete requirement coverage",()=>{
 assert.equal(validateManifest(manifest,["REQ-001"],false).checks.length,1);
 for(const bad of [ {...manifest,protectedFiles:["../outside.js"]},{...manifest,protectedFiles:["verification/report.json"]},{...manifest,checks:[manifest.checks[0],manifest.checks[0]]},{...manifest,checks:[{...manifest.checks[0],command:"echo passed"}]},{...manifest,checks:[{...manifest.checks[0],command:"node tests/verify-acceptance.mjs || true"}]}])assert.throws(()=>validateManifest(bad,["REQ-001"],false));
 assert.throws(()=>validateManifest(manifest,["REQ-001","REQ-002"],false),/REQ-002/);
 assert.throws(()=>validateManifest(manifest,["REQ-001"],true),/browser/);
 assert.throws(()=>validateManifest({...manifest,checks:[{...manifest.checks[0],command:"npm test"}]},["REQ-001"],false),/직접/);
 const web={...manifest,protectedFiles:[...manifest.protectedFiles,".agent-graph/browser.json"],checks:[...manifest.checks,{id:"browser",command:browserVerificationCommand(),requirements:["REQ-001"]}]};
 assert.equal(validateManifest(web,["REQ-001"],true).checks.length,2);
});
test("contract snapshots pin initial files and manifest across mutations, deletion and restoration",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"verification-contract-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,".agent-graph"));await fs.mkdir(path.join(root,"tests"));
 await fs.writeFile(path.join(root,"tests/verify-acceptance.mjs"),"import assert from 'node:assert/strict'; assert.equal(1,1);\n");await fs.writeFile(path.join(root,CONTRACT_FILE),JSON.stringify(manifest));
 const state={targetProjectPath:root,graph:createAutonomousGraph(),requirements:deriveRequirementLedger("goal")}as SessionState;state.graph.automation!.browserVerification=false;
 state.verificationContract=await lockContract(state,"supplied");assert.equal(validContractSnapshot(state.verificationContract),true);assert.equal(await contractViolation(state),null);
 assert.deepEqual(contractProofMissing(state,[]),["acceptance"]);
 assert.deepEqual(contractProofMissing(state,[{id:"actual",command:manifest.checks[0].command,exitCode:0,environmentError:null}]),[]);
 assert.deepEqual(contractProofMissing(state,[{id:"actual",command:manifest.checks[0].command,exitCode:1,environmentError:null}]),["acceptance"]);
 await fs.writeFile(path.join(root,"tests/verify-acceptance.mjs"),"process.exit(0)");assert.match((await contractViolation(state))!,/변경/);
 await fs.rm(path.join(root,"tests/verify-acceptance.mjs"));assert.match((await contractViolation(state))!,/읽을/);
 const corrupted=structuredClone(state.verificationContract);corrupted.manifest!.checks[0]!.command="echo passed";assert.equal(validContractSnapshot(corrupted),false);
});

test("registered npm verification rejects failure-masking scripts, including referenced runners", async t => {
 const { verificationRunnerProblem } = await import("./verification_contract.js");
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"contract-runner-")); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const state={targetProjectPath:root,verificationContract:{status:"locked",manifest:{checks:[{command:"npm test > verification/model-tests.txt 2>&1"}]}}}as unknown as SessionState;
 for(const script of ["node --test || node --test", "node --test | cat", "node --test &", "node --test; exit 0", "npm run optional --if-present", "vitest --passWithNoTests"]){await fs.writeFile(path.join(root,"package.json"),JSON.stringify({scripts:{test:script}}));assert.match((await verificationRunnerProblem(state))!,/마스킹/,script);}
 await fs.writeFile(path.join(root,"package.json"),JSON.stringify({scripts:{test:"npm run unit",unit:"node --test || true"}}));assert.match((await verificationRunnerProblem(state))!,/마스킹/);
 for(const script of ["node --test tests/*.test.mjs", "node --test tests/engine.test.mjs && node --test tests/http.test.mjs", "node --test > verification/model-tests.txt 2>&1"]){await fs.writeFile(path.join(root,"package.json"),JSON.stringify({scripts:{test:script}}));assert.equal(await verificationRunnerProblem(state),null,script);}
});
