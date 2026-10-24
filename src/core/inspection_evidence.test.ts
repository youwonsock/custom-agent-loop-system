import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { InspectionTracker } from "./inspection_evidence";
const cwd=path.resolve("owned project"),file="test/controller.test.mjs";
test("completed native reads and exact read commands prove inspection; prose, failures and other directories do not",()=>{
 const t=new InspectionTracker(cwd);
 t.observe({type:"text",part:{text:`read ${file}`}});
 t.observe({type:"tool_use",part:{tool:"read",state:{status:"error",input:{filePath:file}}}});
 t.observe({type:"item.completed",item:{type:"command_execution",command:`cat ${file} | head`,exit_code:0}});
 t.observe({type:"item.completed",item:{type:"command_execution",command:`cat ${file}`,exit_code:1}});
 assert.deepEqual(t.files,[]);
 t.observe({type:"tool_use",part:{tool:"read",state:{status:"completed",input:{filePath:path.join(cwd,file)}}}});
 t.observe({type:"item.completed",item:{type:"command_execution",command:"Get-Content verification/node-tests/report.json",exit_code:0}});
 assert.deepEqual(t.files,[file,"verification/node-tests/report.json"]);
 t.observe({type:"tool_use",part:{tool:"read",state:{status:"completed",input:{filePath:path.resolve(cwd,"../outside")}}}});
 assert.equal(t.files.length,2);
});
test("Claude inspection requires the matching successful native Read result",()=>{
 const t=new InspectionTracker(cwd);
 t.observe({type:"assistant",message:{content:[{type:"tool_use",id:"read",name:"Read",input:{file_path:file}}]}});
 assert.deepEqual(t.files,[]);
 t.observe({type:"user",message:{content:[{type:"tool_result",tool_use_id:"read",is_error:false,content:"actual source"}]}});
 assert.deepEqual(t.files,[file]);
});
