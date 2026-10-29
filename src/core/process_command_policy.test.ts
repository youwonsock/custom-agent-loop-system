import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  broadProcessTermination,
  unscopedTerminationEvent,
  UNSCOPED_TERMINATION,
} from "./process_command_policy";
import { kiloCheckHooks, registeredCheckCommand } from "./kilo_protocol";
import { buildRecoveryMessage } from "./prompt";
test("broad termination is blocked in implementation before native execution while inspection and owned handles remain usable", async () => {
  const cwd = process.cwd(),
    hooks = kiloCheckHooks({ cwd, commands: [], guardOwnedProcesses: true });
  for (const command of [
    'pkill -f "node.*server" 2>&1 | tail -1',
    'pkill -9 -f "node.*server"',
    "killall node",
    "taskkill /F /IM node.exe",
    "Stop-Process -Name node",
    "kill $(pgrep -f server)",
    "kill -9 -1",
  ]) {
    assert.equal(broadProcessTermination(command, cwd), true, command);
    let executed = false;
    await assert.rejects(async () => {
      await hooks["tool.execute.before"](
        { tool: "bash" },
        { args: { command } },
      );
      executed = true;
    }, /UNSCOPED_TERMINATION/);
    assert.equal(executed, false);
  }
  for (const command of [
    "cat test/http.test.mjs",
    'grep "pkill" README.md | head -10',
    "node tests/verify-ui.cjs",
    "kill 12345",
    'node -e "child.kill(\"SIGTERM\")"',
  ])
    assert.equal(broadProcessTermination(command, cwd), false, command);
  assert.equal(
    unscopedTerminationEvent({
      type: "text",
      part: { text: UNSCOPED_TERMINATION },
    }),
    null,
  );
  assert.ok(
    unscopedTerminationEvent({
      type: "tool_use",
      part: { state: { status: "error", error: UNSCOPED_TERMINATION } },
    }),
  );
  assert.match(
    buildRecoveryMessage("tool_arguments", UNSCOPED_TERMINATION, "", []),
    /this task created|owned/,
  );
});
test("exact frozen Node-suite aliases execute the registered foreground command and preserve real failure status", async (t) => {
  const command = "npm test > verification/model-tests.txt 2>&1",
    alias =
      "node --test --test-concurrency=1 test/engine.test.mjs test/http.test.mjs",
    protocol = {
      cwd: process.cwd(),
      commands: [command],
      aliases: { [alias]: command },
    };
  for (const text of [
    alias,
    alias + " 2>&1 | tail -5",
    `cd '${process.cwd()}' && ${alias} | head -20`,
  ])
    assert.equal(registeredCheckCommand(text, protocol), command);
  assert.equal(
    registeredCheckCommand(alias + " --test-only | tail -5", protocol),
    alias + " --test-only | tail -5",
  );
  assert.throws(
    () => registeredCheckCommand(alias + "; exit 0", protocol),
    /standalone/,
  );
  const output = { args: { command: alias + " | tail -10" } };
  await kiloCheckHooks(protocol)["tool.execute.before"](
    { tool: "bash" },
    output,
  );
  assert.equal(output.args.command, command);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-suite-alias-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "test"));
  await fs.mkdir(path.join(root, "verification"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: alias } }),
  );
  await fs.writeFile(
    path.join(root, "test/engine.test.mjs"),
    "import test from 'node:test';import a from 'node:assert/strict';test('real assertion',()=>a.equal(1,2));",
  );
  await fs.writeFile(
    path.join(root, "test/http.test.mjs"),
    "import test from 'node:test';test('another real test',()=>{});",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : "/bin/sh",
    process.platform === "win32"
      ? ["/d", "/s", "/c", output.args.command]
      : ["-c", output.args.command],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(
    await fs.readFile(path.join(root, "verification/model-tests.txt"), "utf8"),
    /real assertion/,
  );
});
