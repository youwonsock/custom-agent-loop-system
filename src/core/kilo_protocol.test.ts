import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { registeredCheckCommand, kiloCheckHooks } from "./kilo_protocol";
import { CommandTracker, isVerificationCommand } from "./verification_evidence";
import { buildInvocation } from "./invocation";
import { createAutonomousGraph } from "./graph";
import plugin = require("./kilo_protocol_plugin");

const cwd = "/owned/project with spaces";
const nodeCommand = "npm test > verification/model-tests.txt 2>&1";
const engineCommand = "node tests/acceptance/verify-engine.mjs . verification/acceptance-engine.json";
const protocol = {cwd, commands: [nodeCommand, engineCommand]};

test("packaged CommonJS native plugin exposes the Kilo server entry directly and fails closed without a protocol", async t => {
  const original=process.env.AGENT_GRAPH_KILO_CHECKS;
  t.after(()=>{if(original===undefined)delete process.env.AGENT_GRAPH_KILO_CHECKS;else process.env.AGENT_GRAPH_KILO_CHECKS=original;});
  assert.equal(plugin.id,"agent-graph-check-protocol");assert.equal(typeof plugin.server,"function");
  delete process.env.AGENT_GRAPH_KILO_CHECKS;
  await assert.rejects(plugin.server(),/protocol is missing/);
  process.env.AGENT_GRAPH_KILO_CHECKS=JSON.stringify(protocol);
  const hooks=await plugin.server(),output={args:{command:"npm test | tail -20"}};
  await hooks["tool.execute.before"]({tool:"bash"},output);
  assert.equal(output.args.command,nodeCommand);
});

test("registered native checks drop only known display wrappers before permission and execution", () => {
  for (const command of [
    "npm test 2>&1 | tail -20", "npm test | head -n 40", "npm test | tail",
    `cd '${cwd}' && npm test 2>&1 | tail -30`,
    "npm test | grep -E '\"allPassed\"|\"error\"' | head -20",
    'npm test > verification/model-tests.txt 2>&1; echo "exit: $?"',
  ]) assert.equal(registeredCheckCommand(command, protocol), nodeCommand, command);
  assert.equal(registeredCheckCommand(engineCommand + " 2>&1 | tail -20", protocol), engineCommand);
  for (const command of ["npm test", nodeCommand, "node unknown.mjs | tail -20", "cd /another && npm test | tail -20", "npm test -- --extra | tail -20", "npm test && node tests/verify-other.mjs | tail -20"])
    assert.equal(registeredCheckCommand(command, protocol), command);
  for (const suffix of [" | tail -20; exit 0", " ; exit 0", " || true", " | tee result.txt", " | head $(touch bypass)"])
    assert.throws(() => registeredCheckCommand("npm test" + suffix, protocol), /standalone foreground/);
  assert.equal(isVerificationCommand("npm test | tail -20"), false, "receipt gate remains strict");
});

test("native hook execution preserves the actual nonzero test exit code as evidence", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-check-exit-"));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  await fs.mkdir(path.join(root,"tests"));
  await fs.writeFile(path.join(root,"tests/verify-failure.cjs"), "process.stdout.write('assertion failed\\n'); process.exit(23);\n");
  const command = "node tests/verify-failure.cjs";
  const hooks = kiloCheckHooks({cwd:root, commands:[command]});
  const output = {args:{command:command + " 2>&1 | tail -20"}};
  await hooks["tool.execute.before"]({tool:"bash"}, output);
  assert.equal(output.args.command, command);
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d","/s","/c",output.args.command] : ["-c",output.args.command];
  const result = spawnSync(shell, args, {cwd:root, encoding:"utf8", env:{...process.env, PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH}});
  assert.equal(result.status,23); assert.match(result.stdout,/assertion failed/);
  const tracker = new CommandTracker(root);
  tracker.observe({type:"tool_use",part:{callID:"observed-failure",tool:"bash",state:{status:"completed",input:output.args,metadata:{exit:result.status},output:result.stdout}}});
  assert.equal(tracker.receipts.length,1); assert.equal(tracker.receipts[0]!.exitCode,23);
  const unrelated = {args:{command:"npm test | tail -20"}};
  await hooks["tool.execute.before"]({tool:"read"},unrelated);
  assert.equal(unrelated.args.command,"npm test | tail -20");
});

test("Kilo guards are invocation-local and preserve native permission and plugin configuration", async t => {
  const original=process.env.KILO_CONFIG_CONTENT;
  t.after(()=>{ if(original===undefined)delete process.env.KILO_CONFIG_CONTENT;else process.env.KILO_CONFIG_CONTENT=original; });
  process.env.KILO_CONFIG_CONTENT=JSON.stringify({plugin:["existing-plugin"],permission:{bash:"ask",webfetch:"deny"},tools:{custom:false}});
  const graph=createAutonomousGraph(),binding={connectionId:"k",modelId:"kilo/kilo-auto/free"},connection={id:"k",type:"kilo" as const,label:"Kilo",binary:process.execPath};
  for(const type of ["implementation","test","review"] as const){
    const invocation=await buildInvocation(connection,binding,graph.nodes.find(n=>n.type===type)!,{prompt:"goal",cwd,fullAccess:false,allowedPaths:[],verificationCommands:protocol.commands,disableWrite:true});
    const config=JSON.parse(invocation.env.KILO_CONFIG_CONTENT!);
    assert.equal(config.permission.bash,type==="review"?"deny":"ask");assert.equal(config.permission.webfetch,"deny");
    assert.equal(config.plugin[0],"existing-plugin");
    if(type==="review"){
      assert.equal(config.plugin.length,1); assert.equal(invocation.env.AGENT_GRAPH_KILO_CHECKS,undefined);
      assert.equal(config.tools.write,undefined); assert.equal(config.permission.edit,"deny");
    }else{
      assert.equal(config.plugin.length,2);assert.match(config.plugin[1],/kilo_protocol_plugin\.js$/);
      assert.deepEqual(JSON.parse(invocation.env.AGENT_GRAPH_KILO_CHECKS!),protocol);
      assert.equal(config.tools.write,false);assert.equal(config.tools.custom,false);
      assert.match(invocation.args.at(-1)!,/write tool is disabled/);
    }
  }
  assert.equal(process.env.KILO_CONFIG_CONTENT,JSON.stringify({plugin:["existing-plugin"],permission:{bash:"ask",webfetch:"deny"},tools:{custom:false}}));
});
