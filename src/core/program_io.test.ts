import { VM_BINARY, isolationSupported, listVms } from "./program_io_vm";
import { nativeVmBackend, ProgramIoBackend } from "./program_io";
import { claudeVmDecision } from "./program_io_claude";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  ioSign,
  prepareProgramIo,
  wrapProgramCommand,
  unwrapProgramCommand,
  ProgramIoPolicy,
} from "./program_io";
import {
  ProgramIoTracker,
  programIoEvidenceProblem,
} from "./program_io_tracker";
import { kiloCheckHooks } from "./kilo_protocol";
import { InspectionTracker } from "./inspection_evidence";
import { CommandTracker } from "./verification_evidence";
import { ProgramIoAudit, SessionState } from "../shared/domain";
import { createAutonomousGraph, validateGraphDocument } from "./graph";
import { ProcessSupervisor } from "./process_supervisor";
import { buildInvocation } from "./invocation";
import { preExecutionDenied } from "./event_evidence";
import { ToolFailureTracker } from "./tool_failures";
import { IO_UNAVAILABLE } from "./program_io_errors";
import {
  nestedProjectProblem,
  vmCommandName,
  vmRuntimeStatus,
} from "./program_io_vm";
import { validProgramIoAudit } from "./session_schema";
import { evidenceGates } from "./runtime_gates";
import type { GateHost } from "./runtime_gates";
import { TEST_POLICY, testPolicyEvent } from "./test_source_guard";
import { sha } from "./values";

const mac = process.platform === "darwin",
  sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
// verify:vm sets AGENT_GRAPH_REQUIRE_VM so a missing or stale runtime fails instead of skipping.
const vmSkip = !isolationSupported()
  ? "not supported here"
  : process.env.AGENT_GRAPH_REQUIRE_VM === "1" || vmRuntimeStatus() === "ready"
    ? false
    : `VM runtime ${vmRuntimeStatus()}; run npm run sandbox:prepare`;
// The Seatbelt profile reads only Node's own prefix. Homebrew Node loads libuv and
// others from outside it and cannot start there. CI never skips these for that reason.
function seatbeltSkipReason(): string | false {
  if (!mac) return "macOS only";
  if (process.env.CI) return false;
  const prefix = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
  const probe = spawnSync("/usr/bin/sandbox-exec", [
    "-p",
    `(version 1)(allow default)(deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local"))(allow file-read* (subpath ${JSON.stringify(prefix)}))`,
    process.execPath,
    "-e",
    "0",
  ]);
  return probe.status === 0
    ? false
    : `Seatbelt tests need a Node that loads only from its own prefix, such as an official build: ${prefix}`;
}
const seatbeltSkip = seatbeltSkipReason();
async function workspace(
  t: { after(fn: () => Promise<unknown>): unknown },
  role: "implementation" | "test" | "review" = "implementation",
  backend: ProgramIoBackend = "macos-seatbelt",
) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "program io-")),
    target = path.join(root, "target"),
    outside = path.join(root, "outside");
  await fsp.mkdir(target);
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, "sentinel.txt"), "unchanged");
  await fsp.writeFile(path.join(target, "inside.txt"), "inside");
  await fsp.writeFile(path.join(target, "frozen.txt"), "frozen");
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const policy = prepareProgramIo({
    cwd: target,
    directory: path.join(root, "broker"),
    testRole: role === "test",
    readOnly: role === "review",
    protectedFiles: ["frozen.txt"],
    backend,
  });
  return { root, target, outside, policy };
}
function run(command: string, policy: ProgramIoPolicy) {
  const wrapped = wrapProgramCommand(command, policy),
    words = unwrapProgramCommand(wrapped, policy);
  assert.equal(words?.command, command);
  const child = spawnSync("/bin/sh", ["-c", wrapped], {
    cwd: policy.cwd,
    env: { ...process.env, AGENT_GRAPH_PROGRAM_IO: JSON.stringify(policy) },
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const event = {
    type: "tool_use",
    part: {
      id: words!.id,
      tool: "bash",
      state: {
        status: "completed",
        input: { command: wrapped },
        metadata: { exit: child.status },
        output: child.stdout,
      },
    },
  };
  return { child, event, wrapped };
}
test(
  "kernel confinement blocks direct, child, symlink, hardlink, listing, stat and outside writes without exposing host secrets",
  { skip: seatbeltSkip },
  async (t) => {
    const { policy, outside, target } = await workspace(t);
    const code = `const f=require('node:fs'),c=require('node:child_process'),out=${JSON.stringify(outside)};let denied=0;for(const fn of [()=>f.readFileSync(out+'/sentinel.txt'),()=>f.writeFileSync(out+'/sentinel.txt','bad'),()=>f.readdirSync(out),()=>f.statSync(out+'/sentinel.txt'),()=>f.linkSync(out+'/sentinel.txt','link'),()=>{f.symlinkSync(out,'escape');f.readFileSync('escape/sentinel.txt')},()=>f.linkSync(${JSON.stringify(policy.runner)},'runtime-link'),()=>f.writeFileSync('frozen.txt','bad')]){try{fn()}catch(e){if(['EPERM','EACCES'].includes(e.code))denied++}}const r=c.spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync(process.argv[1]);process.exit(7)}catch(e){process.exit(e.code==='EPERM'?0:8)}",out+'/sentinel.txt']);f.writeFileSync('inside-ok.txt','yes');console.log(JSON.stringify({denied,child:r.status,secret:!!process.env.AGENT_GRAPH_PROGRAM_IO||!!process.env.AGENT_GRAPH_TEST_SECRET,home:process.env.HOME,tmp:process.env.TMPDIR}));`;
    const old = process.env.AGENT_GRAPH_TEST_SECRET;
    process.env.AGENT_GRAPH_TEST_SECRET = "must-never-reach-program";
    let result;
    try {
      result = run("node -e " + sq(code), policy);
    } finally {
      if (old === undefined) delete process.env.AGENT_GRAPH_TEST_SECRET;
      else process.env.AGENT_GRAPH_TEST_SECRET = old;
    }
    assert.equal(result.child.status, 0, result.child.stderr);
    const data = JSON.parse(result.child.stdout);
    assert.equal(data.denied, 8);
    assert.equal(data.child, 0);
    assert.equal(data.secret, false);
    assert.ok(data.home.startsWith(fs.realpathSync(target)));
    assert.ok(data.tmp.startsWith(fs.realpathSync(target)));
    assert.equal(
      fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"),
      "unchanged",
    );
    assert.equal(
      fs.readFileSync(path.join(target, "frozen.txt"), "utf8"),
      "frozen",
    );
    const tracker = new ProgramIoTracker(policy);
    tracker.normalize(result.event);
    const audit = tracker.finish();
    assert.equal(audit.completedCommands, 1);
    assert.equal(audit.invalidReceipts, 0);
    assert.equal(audit.unresolvedCommands, 0);
    assert.equal(audit.commands[0]!.processGroupStopped, true);
  },
);
test(
  "test and review kernel profiles prevent product writes while preserving scratch, exact exit codes and read evidence",
  { skip: seatbeltSkip },
  async (t) => {
    for (const role of ["test", "review"] as const) {
      const { policy, target } = await workspace(t, role);
      const code =
        "try{require('node:fs').writeFileSync('inside.txt','bad');process.exit(9)}catch(e){console.log(e.code)}";
      const result = run("node -e " + sq(code), policy);
      assert.equal(result.child.status, 0, result.child.stderr);
      assert.match(result.child.stdout, /EPERM/);
      assert.equal(
        fs.readFileSync(path.join(target, "inside.txt"), "utf8"),
        "inside",
      );
      const cat = run("cat inside.txt", policy);
      assert.equal(cat.child.status, 0, cat.child.stderr);
      const tracker = new ProgramIoTracker(policy);
      const inspections = new InspectionTracker(target);
      inspections.observe(tracker.normalize(cat.event));
      assert.deepEqual(inspections.files, ["inside.txt"]);
    }
  },
);
test(
  "signed broker receipts reject modified/replayed/unwrapped evidence and preserve failing registered checks",
  { skip: seatbeltSkip },
  async (t) => {
    const { policy } = await workspace(t);
    const command = "node --test verification/check.test.cjs";
    fs.mkdirSync(path.join(policy.cwd, "verification"), { recursive: true });
    fs.writeFileSync(
      path.join(policy.cwd, "verification/check.test.cjs"),
      "require('node:test')('failure',()=>require('node:assert').equal(1,2));",
    );
    const result = run(command, policy);
    assert.equal(result.child.status, 1, result.child.stderr);
    const tracker = new ProgramIoTracker(policy),
      commands = new CommandTracker(policy.cwd, true);
    commands.observe(tracker.normalize(result.event));
    assert.equal(commands.receipts[0]!.exitCode, 1);
    assert.equal(commands.receipts[0]!.command, command);
    assert.equal(tracker.finish().completedCommands, 1);
    assert.equal(
      unwrapProgramCommand(result.wrapped.replace(/.$/, "X"), policy),
      null,
    );
    const unwrapped = new ProgramIoTracker(policy);
    unwrapped.normalize({
      ...result.event,
      part: {
        ...result.event.part,
        state: { ...result.event.part.state, input: { command } },
      },
    });
    assert.equal(unwrapped.finish().unwrappedCommands, 1);
    fs.appendFileSync(
      path.join(policy.directory, "receipts.jsonl"),
      '{"data":{"type":"end"},"signature":"forged"}\n',
    );
    assert.ok(tracker.finish().invalidReceipts);
  },
);
test(
  "isolated hooks disable alternate tool hosts and retain strict test/readonly command policies",
  { skip: seatbeltSkip },
  async (t) => {
    const { policy, target } = await workspace(t);
    const hooks = kiloCheckHooks({
      cwd: target,
      commands: ["npm test"],
      scopeRoots: [target],
      programIo: policy,
      testSourcesReadOnly: true,
    });
    for (const tool of ["read", "write", "glob", "task", "mcp_read", "lsp"])
      await assert.rejects(
        hooks["tool.execute.before"](
          { tool },
          { args: { filePath: path.join(target, "inside.txt") } },
        ),
        /IO_DENIED/,
      );
    await assert.rejects(
      hooks["tool.execute.before"](
        { tool: "bash" },
        { args: { command: 'node -e "0"' } },
      ),
      /TEST_POLICY/,
    );
    const output = { args: { command: "npm test" } };
    await hooks["tool.execute.before"]({ tool: "bash" }, output);
    assert.equal(
      unwrapProgramCommand(output.args.command, policy)!.command,
      "npm test",
    );
    const readonly = kiloCheckHooks({
      cwd: target,
      commands: [],
      scopeRoots: [target],
      programIo: policy,
      readOnlyRole: true,
    });
    await assert.rejects(
      readonly["tool.execute.before"](
        { tool: "bash" },
        { args: { command: "mkdir -p verification" } },
      ),
      /IO_DENIED/,
    );
    const denied = new ProgramIoTracker(policy);
    denied.normalize({
      type: "tool_use",
      part: {
        tool: "bash",
        state: {
          status: "error",
          input: { command: "mkdir -p verification" },
          error: "Error: [AGENT_GRAPH_IO_DENIED] Read-only role",
        },
      },
    });
    assert.equal(denied.finish().unwrappedCommands, 0);
    assert.equal(
      preExecutionDenied("[AGENT_GRAPH_IO_UNAVAILABLE] lost VM", {}),
      false,
    );
  },
);
test(
  "registered-check and process-name rejections remain pre-execution denials while genuine unwrapped executions fail closed",
  { skip: seatbeltSkip },
  async (t) => {
    const { policy, target } = await workspace(t);
    const check = "npm test > verification/model-tests.txt 2>&1",
      hooks = kiloCheckHooks({
        cwd: target,
        commands: [check],
        scopeRoots: [target],
        programIo: policy,
        guardOwnedProcesses: true,
      });
    const tracker = new ProgramIoTracker(policy),
      commands = new CommandTracker(target, true);
    for (const [id, command] of [
      `${check}; echo separator; tail -60 verification/model-tests.txt`,
      "pkill -f never-run-this-name",
    ].entries()) {
      let error = "";
      try {
        await hooks["tool.execute.before"](
          { tool: "bash" },
          { args: { command } },
        );
      } catch (e) {
        error = String(e);
      }
      assert.ok(preExecutionDenied(error, {}), error);
      const event = {
        type: "tool_use",
        part: {
          id: String(id),
          tool: "bash",
          state: { status: "error", input: { command }, error },
        },
      };
      commands.observe(tracker.normalize(event));
    }
    assert.equal(tracker.finish().unwrappedCommands, 0);
    assert.equal(tracker.finish().completedCommands, 0);
    assert.equal(
      commands.receipts.length,
      0,
      "denials cannot become successful check receipts",
    );
    const text =
      "Registered verification checks require a standalone foreground command; remove shell chaining and read logs separately.";
    assert.equal(
      preExecutionDenied(text, {}),
      false,
      "unmarked output is not trusted denial provenance",
    );
    tracker.normalize({
      type: "tool_use",
      part: {
        id: "unwrapped",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "node unknown-program.mjs" },
          metadata: { exit: 0 },
        },
      },
    });
    assert.equal(tracker.finish().unwrappedCommands, 1);
  },
);
test(
  "signed after-hook evidence authenticates CLI versions retaining original tool inputs",
  { skip: seatbeltSkip },
  async (t) => {
    const { policy, target } = await workspace(t);
    const hooks = kiloCheckHooks({
      cwd: target,
      commands: [],
      scopeRoots: [target],
      programIo: policy,
    });
    const original = "cat inside.txt",
      output = { args: { command: original } };
    await hooks["tool.execute.before"]({ tool: "bash" }, output);
    const wrapped = output.args.command;
    const child = spawnSync("/bin/sh", ["-c", output.args.command], {
      cwd: target,
      env: { ...process.env, AGENT_GRAPH_PROGRAM_IO: JSON.stringify(policy) },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const result: { metadata?: Record<string, unknown> } = {
      metadata: { exit: child.status },
    };
    await hooks["tool.execute.after"]!(
      { tool: "bash", args: output.args },
      result,
    );
    assert.equal(output.args.command, original);
    assert.ok(!JSON.stringify(result.metadata).includes(policy.runner));
    const event = {
      type: "tool_use",
      part: {
        tool: "bash",
        state: {
          status: "completed",
          input: { command: original },
          metadata: result.metadata,
        },
      },
    };
    const tracker = new ProgramIoTracker(policy);
    assert.equal(
      (tracker.normalize(event).part as any).state.input.command,
      original,
    );
    assert.equal(tracker.finish().completedCommands, 1);
    assert.equal(tracker.finish().unwrappedCommands, 0);
    const forged = new ProgramIoTracker(policy);
    forged.normalize({
      ...event,
      part: {
        ...event.part,
        state: { ...event.part.state, input: { command: "cat outside.txt" } },
      },
    });
    assert.equal(forged.finish().unwrappedCommands, 1);
    const nativeMessage = {
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: wrapped },
              metadata: result.metadata,
            },
          },
        ],
      },
      frame: { messages: unknown[] } = { messages: [nativeMessage] };
    await hooks["experimental.chat.messages.transform"]!({}, frame);
    assert.equal(
      (frame.messages[0] as typeof nativeMessage).parts[0]!.state.input.command,
      original,
    );
    assert.equal(
      nativeMessage.parts[0]!.state.input.command,
      wrapped,
      "raw evidence remains intact",
    );
    assert.ok(!JSON.stringify(frame).includes(policy.runner));
    await assert.rejects(
      hooks["tool.execute.before"](
        { tool: "bash" },
        { args: { command: wrapped } },
      ),
      /internal authorization wrappers/,
    );
  },
);
test(
  "resumed model context normalizes authenticated prior-attempt commands and empty inputs use bounded schema recovery",
  { skip: seatbeltSkip },
  async (t) => {
    const { policy, target, root } = await workspace(t);
    const earlier = prepareProgramIo({
      cwd: target,
      directory: path.join(root, "11111111-1111-4111-8111-111111111111-io"),
      testRole: false,
      readOnly: false,
      backend: "macos-seatbelt",
    });
    const wrapped = wrapProgramCommand("cat inside.txt", earlier),
      hooks = kiloCheckHooks({
        cwd: target,
        commands: [],
        scopeRoots: [target],
        programIo: policy,
      }),
      native = {
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: wrapped } },
          },
        ],
      },
      frame = { messages: [native] };
    await hooks["experimental.chat.messages.transform"]!({}, frame);
    assert.equal(
      frame.messages[0]!.parts[0]!.state.input.command,
      "cat inside.txt",
    );
    assert.equal(native.parts[0]!.state.input.command, wrapped);
    const failures = new ToolFailureTracker();
    let message = "";
    for (let i = 0; i < 3; i++) {
      try {
        await hooks["tool.execute.before"]({ tool: "bash" }, { args: {} });
      } catch (e) {
        message = String(e);
      }
      assert.ok(preExecutionDenied(message, {}));
      const failure = failures.observe({
        type: "tool_use",
        part: {
          id: String(i),
          tool: "bash",
          state: { status: "error", input: {}, error: message },
        },
      });
      if (i < 2) assert.equal(failure, null);
      else assert.match(failure!, /3 consecutive.*"bash"/);
    }
  },
);
test("missing isolation proof blocks success only while the guard is on", () => {
  const s = {
    graph: createAutonomousGraph(),
    targetProjectPath: "target",
    bindings: { planning: { connectionId: "kilo" } },
    connections: [{ id: "kilo", type: "kilo" }],
    visits: [{ nodeId: "planning", attempts: [{}] }],
  } as unknown as SessionState;
  assert.ok(programIoEvidenceProblem(s));
  s.graph.automation!.programIoGuard = false;
  assert.equal(programIoEvidenceProblem(s), null);
  const g = createAutonomousGraph();
  assert.equal(validateGraphDocument(g).automation!.programIoGuard, true);
  assert.throws(() =>
    validateGraphDocument({
      ...g,
      automation: { ...g.automation, targetScopeGuard: false },
    }),
  );
  if (!mac)
    assert.throws(
      () =>
        prepareProgramIo({
          cwd: ".",
          directory: "unused",
          testRole: false,
          readOnly: false,
        }),
      new RegExp(IO_UNAVAILABLE.replace(/[\[\]]/g, "\\$&")),
    );
});
test(
  "broker paths resolving through an alias into the writable project are rejected before keys or execution",
  { skip: !mac },
  async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "io-alias-"));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const target = path.join(root, "target"),
      alias = path.join(root, "alias");
    await fsp.mkdir(target);
    await fsp.symlink(target, alias);
    assert.throws(
      () =>
        prepareProgramIo({
          cwd: target,
          directory: path.join(alias, "broker"),
          testRole: false,
          readOnly: false,
        }),
      /broker\/audit directory must be outside/,
    );
    assert.equal(fs.existsSync(path.join(target, "broker/policy.json")), false);
  },
);
test(
  "native supervisor authenticates wrapped command exits and inspection evidence before the success gate",
  { skip: seatbeltSkip },
  async (t) => {
    const { policy, root, target } = await workspace(t);
    fs.mkdirSync(path.join(target, "verification"), { recursive: true });
    fs.writeFileSync(
      path.join(target, "verification/real.test.cjs"),
      "require('node:test')('real assertion',()=>require('node:assert').equal(2+2,4));",
    );
    const script = path.join(root, "native-fixture.cjs");
    fs.writeFileSync(
      script,
      `const{ kiloCheckHooks }=require(${JSON.stringify(path.join(__dirname, "kilo_protocol.js"))});const c=require('node:child_process'),p=JSON.parse(process.env.AGENT_GRAPH_PROGRAM_IO);(async()=>{const hooks=kiloCheckHooks({cwd:p.cwd,commands:[],scopeRoots:[p.cwd],programIo:p});let id=0;for(const original of ['cat inside.txt','node --test verification/real.test.cjs']){const args={command:original};await hooks['tool.execute.before']({tool:'bash'},{args});const r=c.spawnSync('/bin/sh',['-c',args.command],{cwd:p.cwd,env:process.env,encoding:'utf8'}),result={metadata:{exit:r.status}};await hooks['tool.execute.after']({tool:'bash',args},result);console.log(JSON.stringify({type:'tool_use',part:{id:String(++id),tool:'bash',state:{status:'completed',input:args,metadata:result.metadata,output:r.stdout+r.stderr}}}));}console.log(JSON.stringify({type:'text',part:{text:'[PHASE_DONE]'}}));})().catch(e=>{console.error(e);process.exitCode=1});`,
    );
    const result = await new ProcessSupervisor().run({
      binary: process.execPath,
      args: [script],
      transport: "pipe",
      cwd: target,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (v): v is [string, string] => typeof v[1] === "string",
          ),
        ),
        AGENT_GRAPH_PROGRAM_IO: JSON.stringify(policy),
      },
      programIoPolicy: policy,
      scopeRoots: [target],
      cols: 200,
      rows: 40,
      useConpty: false,
      transportTimeoutMs: 3000,
      idleTimeoutMs: 5000,
      toolTimeoutMs: 5000,
      phaseTimeoutMs: 20000,
      terminationGraceMs: 500,
      killTimeoutMs: 500,
      maxInMemoryOutputBytes: 1024 * 1024,
      rawLogPath: path.join(root, "native.log"),
      interactionWhitelist: [],
      destructivePrompts: [],
      sensitiveValues: [policy.privateKey],
    });
    assert.equal(
      result.outcome,
      "succeeded",
      result.failureMessage ?? result.output,
    );
    assert.equal(result.evidence.programIoAudit!.completedCommands, 2);
    assert.equal(result.evidence.programIoAudit!.invalidReceipts, 0);
    assert.equal(result.evidence.commands[0]!.exitCode, 0);
    assert.equal(
      result.evidence.commands[0]!.command,
      "node --test verification/real.test.cjs",
    );
    assert.ok(result.evidence.readFiles!.includes("inside.txt"));
    assert.ok(
      !fs
        .readFileSync(path.join(root, "native.log"), "utf8")
        .includes(policy.privateKey),
    );
  },
);
test(
  "strong invocation isolates provider configuration and exposes only sandboxed bash",
  { skip: !mac },
  async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "io invocation-"));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const target = path.join(root, "target");
    await fsp.mkdir(target);
    const graph = createAutonomousGraph();
    const providerHome = path.join(root, "session-private-home");
    const build = (name = "broker") =>
      buildInvocation(
        {
          id: "kilo",
          label: "fixture",
          type: "kilo",
          binary: path.resolve(__dirname, "../../../test/fixture_cli.cjs"),
        },
        { connectionId: "kilo", modelId: "fixture-model" },
        graph.nodes.find((n) => n.type === "review")!,
        {
          prompt: "inspect",
          cwd: target,
          fullAccess: false,
          allowedPaths: [],
          scopeRoots: [target],
          programIoGuard: {
            directory: path.join(root, name),
            providerHome,
            protectedFiles: [],
            expiresAt: Date.now() + 60000,
          },
        },
      );
    if (vmSkip) {
      await assert.rejects(build(), /IO_UNAVAILABLE/);
      return;
    }
    const result = await build();
    const config = JSON.parse(result.env.KILO_CONFIG_CONTENT!),
      protocol = JSON.parse(result.env.AGENT_GRAPH_KILO_CHECKS!);
    assert.equal(config.permission.bash, "allow");
    assert.equal(config.permission["*"], "deny");
    assert.equal(config.tools.read, false);
    assert.equal(config.tools.bash, true);
    assert.equal(config.snapshot, false);
    assert.equal(config.lsp, false);
    assert.equal(config.formatter, false);
    assert.deepEqual(config.mcp, {});
    assert.equal(config.plugin.length, 1);
    assert.equal(protocol.readOnlyRole, true);
    assert.ok(result.env.HOME!.startsWith(fs.realpathSync(root)));
    assert.equal(result.env.KILO_DISABLE_PROJECT_CONFIG, "true");
    assert.equal(result.env.NODE_OPTIONS, "");
    assert.ok(result.programIoPolicy!.preflightPassed);
    assert.match(result.args.join(" "), /Each bash command gets a fresh VM/);
    const second = await build("broker-second");
    assert.equal(second.env.HOME, result.env.HOME);
    assert.equal(second.env.KILO_CONFIG_DIR, result.env.KILO_CONFIG_DIR);
    assert.notEqual(second.programIoPolicy!.id, result.programIoPolicy!.id);
    assert.notEqual(
      second.programIoPolicy!.privateKey,
      result.programIoPolicy!.privateKey,
    );
    assert.ok(
      !second.programIoPolicy!.runtimeReadRoots.includes(second.env.HOME!),
    );
  },
);
test(
  "isolated VM programs cannot use host loopback services as filesystem delegates",
  { skip: vmSkip },
  async (t) => {
    const { policy } = await workspace(t, "implementation", nativeVmBackend());
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const code = `const s=require('node:net').connect({host:'127.0.0.1',port:${address.port}});s.on('connect',()=>process.exit(9));s.on('error',e=>{console.log(e.code);process.exit(['EPERM','EACCES','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(e.code)?0:8)});setTimeout(()=>process.exit(7),2000);`;
    const result = run("node -e " + sq(code), policy);
    assert.equal(result.child.status, 0, result.child.stderr);
    const tracker = new ProgramIoTracker(policy);
    tracker.normalize(result.event);
    assert.equal(tracker.finish().commands[0]!.containerRemoved, true);
  },
);
test(
  "VM: Claude's Bash leaves for the VM through the hook, and its other tools stay in the target",
  { skip: vmSkip },
  async (t) => {
    const { policy, outside } = await workspace(
      t,
      "implementation",
      nativeVmBackend(),
    );
    const protocol = {
      cwd: policy.cwd,
      roots: [policy.cwd],
      readOnly: false,
      testRole: false,
      commands: [],
    };
    const decide = (tool: string, input: Record<string, unknown>) =>
      (
        claudeVmDecision(
          { tool_name: tool, tool_input: input, tool_use_id: "use-1" },
          policy,
          protocol,
        ) as {
          hookSpecificOutput: {
            permissionDecision: string;
            updatedInput?: { command: string };
          };
        }
      ).hookSpecificOutput;
    assert.equal(
      decide("Read", { file_path: path.join(policy.cwd, "inside.txt") })
        .permissionDecision,
      "allow",
    );
    assert.equal(
      decide("Read", { file_path: path.join(outside, "sentinel.txt") })
        .permissionDecision,
      "deny",
    );
    assert.equal(decide("WebFetch", {}).permissionDecision, "deny");
    assert.equal(
      decide("Bash", { command: wrapProgramCommand("true", policy) })
        .permissionDecision,
      "deny",
    );
    const hostile = `const f=require('node:fs');let d=0;try{f.readFileSync(${JSON.stringify(path.join(outside, "sentinel.txt"))})}catch{d++}console.log(d)`;
    const native = "node -e " + sq(hostile);
    const decision = decide("Bash", { command: native });
    const child = spawnSync("/bin/sh", ["-c", decision.updatedInput!.command], {
      cwd: policy.cwd,
      env: { ...process.env, AGENT_GRAPH_PROGRAM_IO: JSON.stringify(policy) },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(
      child.stdout.trim(),
      "1",
      "the VM cannot see the outside file",
    );
    const tracker = new ProgramIoTracker(policy);
    const events = (id: string) => [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id, name: "Bash", input: { command: native } },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id }] },
      },
    ];
    for (const event of events("use-1")) tracker.normalize(event);
    let audit = tracker.finish();
    assert.equal(audit.completedCommands, 1);
    assert.equal(audit.invalidReceipts, 0);
    assert.equal(audit.unwrappedCommands, 0);
    assert.equal(audit.commands[0]!.containerRemoved, true);
    for (const event of events("no-hook-saw-this")) tracker.normalize(event);
    audit = tracker.finish();
    assert.equal(audit.unwrappedCommands, 1, "it ran on the host");
  },
);
test(
  "VM boundary blocks host files, guest outside writes, and detached processes are destroyed before command acceptance",
  { skip: vmSkip },
  async (t) => {
    const { policy, outside, target } = await workspace(
      t,
      "implementation",
      nativeVmBackend(),
    );
    const code = `const f=require('node:fs'),c=require('node:child_process'),p=${JSON.stringify(path.join(outside, "sentinel.txt"))};let denied=0;for(const fn of [()=>f.readFileSync(p),()=>f.writeFileSync(p,'bad'),()=>f.readdirSync(${JSON.stringify(outside)}),()=>f.statSync(p),()=>f.writeFileSync('/tmp/agent-outside.txt','bad'),()=>f.writeFileSync('frozen.txt','bad')])try{fn()}catch(e){if(['EPERM','EACCES','ENOENT','EROFS'].includes(e.code))denied++}const q=c.spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync(process.argv[1]);process.exit(9)}catch(e){process.exit(e.code==='ENOENT'?0:8)}",p]);const bg=c.spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('late-write.txt','bad'),2000)"],{detached:true,stdio:'ignore'});bg.unref();console.log(JSON.stringify({denied,child:q.status,secret:!!process.env.AGENT_GRAPH_PROGRAM_IO}));`;
    const result = run("node -e " + sq(code), policy);
    assert.equal(result.child.status, 0, result.child.stderr);
    assert.deepEqual(JSON.parse(result.child.stdout), {
      denied: 6,
      child: 0,
      secret: false,
    });
    assert.equal(
      fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"),
      "unchanged",
    );
    assert.equal(
      fs.readFileSync(path.join(target, "frozen.txt"), "utf8"),
      "frozen",
    );
    const tracker = new ProgramIoTracker(policy);
    tracker.normalize(result.event);
    assert.equal(tracker.finish().commands[0]!.containerRemoved, true);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(fs.existsSync(path.join(target, "late-write.txt")), false);
  },
);
test(
  "VM Test and review mounts preserve product files while permitting owned verification scratch",
  { skip: vmSkip },
  async (t) => {
    for (const role of ["test", "review"] as const) {
      const { policy, target } = await workspace(t, role, nativeVmBackend());
      const result = run(
        "node -e " +
          sq(
            "try{require('node:fs').writeFileSync('inside.txt','bad');process.exit(9)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e;console.log('readonly')}",
          ),
        policy,
      );
      assert.equal(result.child.status, 0, result.child.stderr);
      assert.equal(result.child.stdout.trim(), "readonly");
      assert.equal(
        fs.readFileSync(path.join(target, "inside.txt"), "utf8"),
        "inside",
      );
    }
  },
);
test(
  "controller cleans only an orphaned policy VM and retains invalid completion evidence",
  { skip: vmSkip },
  async (t) => {
    const { policy } = await workspace(t, "implementation", nativeVmBackend());
    const name = `agio-${policy.id.slice(0, 16)}-orphan-fixture`;
    const child = spawnSync(
      policy.vm!.binary,
      [
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        ...(process.platform === "linux" ? [] : ["--progress", "none"]),
        policy.vm!.image,
        "sleep",
        "60",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const tracker = new ProgramIoTracker(policy);
    assert.equal(tracker.finish().invalidReceipts, 1);
    assert.ok(!listVms(policy.vm!).includes(name));
  },
);
test("VM runtime status separates missing, stale and corrupt descriptors without starting anything", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "io-status-")),
    file = path.join(root, "runtime.json"),
    saved = process.env.AGENT_GRAPH_IO_VM_RUNTIME;
  t.after(async () => {
    if (saved === undefined) delete process.env.AGENT_GRAPH_IO_VM_RUNTIME;
    else process.env.AGENT_GRAPH_IO_VM_RUNTIME = saved;
    await fsp.rm(root, { recursive: true, force: true });
  });
  process.env.AGENT_GRAPH_IO_VM_RUNTIME = file;
  assert.equal(vmRuntimeStatus(), "missing");
  if (!fs.existsSync(VM_BINARY)) return;
  fs.writeFileSync(file, "{not json");
  assert.equal(vmRuntimeStatus(), "stale");
  fs.writeFileSync(file, JSON.stringify({ lockDigest: "other" }));
  assert.equal(vmRuntimeStatus(), "stale");
  const { lockDigest } = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../program_io_dependencies.json"),
      "utf8",
    ),
  );
  fs.writeFileSync(file, JSON.stringify({ lockDigest }));
  assert.equal(vmRuntimeStatus(), "ready");
});
test("a project inside the install folder gets a stated reason instead of a mount error", () => {
  const install = path.resolve("agent-graph");
  assert.match(
    nestedProjectProblem(path.join(install, "artifacts/x"), install)!,
    /설치 폴더/,
  );
  assert.match(nestedProjectProblem(install, install)!, /설치 폴더/);
  assert.equal(nestedProjectProblem(`${install}-other/project`, install), null);
});

// A platform stop of the CLI: only a stop the supervisor itself made, of a command
// with a signed start, is told apart from a violation. Everything else stays invalid.
const posix = process.platform === "win32" ? "POSIX fake container CLI" : false;
function stoppedFixture(
  t: { after(fn: () => Promise<unknown>): unknown },
  mode: "implementation" | "test" = "test",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "program io stop-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "broker"),
    vms = path.join(root, "vms.json"),
    binary = path.join(root, "container"),
    keys = generateKeyPairSync("ed25519");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "profile.sb"), "profile");
  fs.writeFileSync(vms, "[]");
  fs.writeFileSync(
    binary,
    `#!${process.execPath}
const fs=require('node:fs'),f=${JSON.stringify(vms)},[cmd,,name]=process.argv.slice(2);
if(cmd==='list')console.log(fs.readFileSync(f,'utf8'));
if(cmd==='delete'){if(fs.existsSync(f+'.stuck'))process.exit(1);fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,'utf8')).filter(v=>v.id!==name)));}
`,
    { mode: 0o755 },
  );
  const policy = {
    version: 1,
    id: randomUUID(),
    cwd: root,
    directory,
    node: process.execPath,
    runner: "runner",
    bootstrap: "bootstrap",
    profile: "profile",
    profileDigest: sha("profile"),
    publicKey: keys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    privateKey: keys.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    expiresAt: Date.now() + 60000,
    writableRoots: [],
    runtimeReadRoots: [],
    scratch: path.join(root, "scratch"),
    preflightPassed: true,
    browserPath: "/ms-playwright",
    backend: "apple-container-vm",
    vm: {
      binary,
      image: "image",
      imageDigest: `sha256:${"a".repeat(64)}`,
      lockDigest: "lock",
      controlHome: root,
      runtimeRoot: root,
      distRoot: root,
      manifestRoot: root,
      mode,
      protectedFiles: [],
      uid: 501,
      gid: 20,
    },
  } as ProgramIoPolicy;
  const record = (data: Record<string, unknown>, signature?: string) => {
    const full = {
      ...data,
      policyId: policy.id,
      profileDigest: policy.profileDigest,
    };
    fs.appendFileSync(
      path.join(directory, "receipts.jsonl"),
      JSON.stringify({
        data: full,
        signature: signature ?? ioSign(full, policy),
      }) + "\n",
    );
  };
  const start = (id: string, over: Record<string, unknown> = {}) =>
    record({
      type: "start",
      id,
      command: "ls -la",
      pid: 2147483646,
      at: new Date(Date.now() - 1000).toISOString(),
      backend: policy.backend,
      containerName: vmCommandName(policy.id, id),
      imageDigest: policy.vm!.imageDigest,
      argumentsDigest: "digest",
      network: "none",
      ...over,
    });
  const end = (id: string, over: Record<string, unknown> = {}) =>
    record({
      type: "end",
      id,
      command: "ls -la",
      exitCode: 137,
      at: new Date().toISOString(),
      backend: policy.backend,
      processGroupStopped: true,
      containerRemoved: true,
      ...over,
    });
  const running = (...names: string[]) =>
    fs.writeFileSync(vms, JSON.stringify(names.map((id) => ({ id }))));
  const left = () => JSON.parse(fs.readFileSync(vms, "utf8")).length as number;
  return { root, policy, vms, record, start, end, running, left };
}
const stopAudit = (policy: ProgramIoPolicy, settleMs = 300) => {
  const tracker = new ProgramIoTracker(policy, settleMs);
  tracker.markPlatformStop();
  return tracker.finish(true);
};
test(
  "a platform stop tells a signed interrupted VM command apart from a violation",
  { skip: posix },
  (t) => {
    const { policy, start, end, running, left } = stoppedFixture(t);
    const id = randomUUID();
    start(id);
    running(vmCommandName(policy.id, id));
    const before = new ProgramIoTracker(policy).finish(true);
    assert.equal(before.invalidReceipts, 2, "without a stop: VM and receipt");
    assert.equal(before.interruptedCommands, undefined);
    running(vmCommandName(policy.id, id));
    const audit = stopAudit(policy);
    assert.equal(audit.invalidReceipts, 0);
    assert.equal(audit.unresolvedCommands, 0);
    assert.equal(audit.interruptedCommands, 1);
    assert.equal(audit.nativeCommands, 0);
    assert.equal(audit.commands.length, 0, "no exit code, no check evidence");
    assert.equal(left(), 0);
    // The broker survived the CLI and signed the removal itself.
    end(id);
    assert.equal(stopAudit(policy).interruptedCommands, 1);
    assert.equal(stopAudit(policy).invalidReceipts, 0);
  },
);
test(
  "a stop does not excuse forged, unsigned, foreign or unconfirmed VM evidence",
  { skip: posix },
  async (t) => {
    const id = randomUUID();
    const cases: Array<
      [
        string,
        (f: ReturnType<typeof stoppedFixture>) => void,
        (policy: ProgramIoPolicy) => ProgramIoAudit,
      ]
    > = [
      [
        "bad signature",
        (f) =>
          f.record(
            { type: "start", id, command: "ls -la", at: "2000-01-01" },
            "forged",
          ),
        stopAudit,
      ],
      [
        "signature over other content",
        (f) => {
          f.start(id);
          const file = path.join(f.policy.directory, "receipts.jsonl");
          fs.writeFileSync(
            file,
            fs.readFileSync(file, "utf8").replace("ls -la", "rm -rf ."),
          );
        },
        stopAudit,
      ],
      [
        "VM with no signed start",
        (f) => f.running(vmCommandName(f.policy.id, randomUUID())),
        stopAudit,
      ],
      [
        "started after the stop",
        (f) => f.start(id, { at: new Date(Date.now() + 60000).toISOString() }),
        stopAudit,
      ],
      ["unreadable start time", (f) => f.start(id, { at: "soon" }), stopAudit],
      [
        "another VM's name",
        (f) => f.start(id, { containerName: "agio-other" }),
        stopAudit,
      ],
      [
        "another image",
        (f) => f.start(id, { imageDigest: "sha256:other" }),
        stopAudit,
      ],
      ["with network", (f) => f.start(id, { network: "host" }), stopAudit],
      [
        "broker signed that removal failed",
        (f) => {
          f.start(id);
          f.end(id, { containerRemoved: false });
        },
        stopAudit,
      ],
      ["an end with no start", (f) => f.end(id), stopAudit],
      [
        "a VM that cannot be removed",
        (f) => {
          f.start(id);
          f.running(vmCommandName(f.policy.id, id));
          fs.writeFileSync(f.vms + ".stuck", "");
        },
        stopAudit,
      ],
      [
        "a broker that still holds the lock",
        (f) => {
          f.start(id);
          const lock = path.join(f.policy.directory, "command.lock");
          fs.mkdirSync(lock);
          fs.writeFileSync(
            path.join(lock, "owner.json"),
            JSON.stringify({ pid: process.pid }),
          );
        },
        stopAudit,
      ],
      [
        "a VM client that is still running",
        (f) => f.start(id, { pid: process.pid }),
        stopAudit,
      ],
      [
        "a stop with the CLI not confirmed gone",
        (f) => {
          f.start(id);
          f.running(vmCommandName(f.policy.id, id));
        },
        (policy) => {
          const tracker = new ProgramIoTracker(policy, 300);
          tracker.markPlatformStop();
          return tracker.finish(false);
        },
      ],
      [
        "the CLI ended by itself",
        (f) => {
          f.start(id);
          f.running(vmCommandName(f.policy.id, id));
        },
        (policy) => new ProgramIoTracker(policy, 300).finish(true),
      ],
    ];
    for (const [name, arrange, audit] of cases)
      await t.test(name, (s) => {
        const fixture = stoppedFixture(s);
        arrange(fixture);
        const result = audit(fixture.policy);
        assert.ok(result.invalidReceipts > 0, name);
        assert.equal(result.interruptedCommands, undefined, name);
      });
  },
);
test(
  "a finished sibling keeps its proof, and a dead broker's lock does not block the stop",
  { skip: posix },
  (t) => {
    const { policy, start, end } = stoppedFixture(t);
    const done = wrapProgramCommand("cat a.txt", policy),
      doneId = unwrapProgramCommand(done, policy)!.id,
      id = randomUUID();
    start(doneId, { command: "cat a.txt" });
    end(doneId, { command: "cat a.txt", exitCode: 0 });
    start(id);
    const lock = path.join(policy.directory, "command.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: 2147483646 }),
    );
    const tracker = new ProgramIoTracker(policy, 300);
    tracker.normalize({
      type: "tool_use",
      part: {
        id: "1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: done },
          metadata: { exit: 0 },
        },
      },
    });
    tracker.markPlatformStop();
    const audit = tracker.finish(true);
    assert.equal(audit.invalidReceipts, 0);
    assert.equal(audit.completedCommands, 1);
    assert.equal(audit.nativeCommands, 1);
    assert.equal(audit.interruptedCommands, 1);
    assert.equal(fs.existsSync(lock), false);
  },
);
test(
  "a command the CLI reported as finished but never signed an end stays unresolved",
  { skip: posix },
  (t) => {
    const { policy, start } = stoppedFixture(t);
    const wrapped = wrapProgramCommand("ls -la", policy);
    start(unwrapProgramCommand(wrapped, policy)!.id);
    const tracker = new ProgramIoTracker(policy, 300);
    tracker.normalize({
      type: "tool_use",
      part: {
        id: "1",
        tool: "bash",
        state: {
          status: "error",
          input: { command: wrapped },
          error: "killed",
        },
      },
    });
    tracker.markPlatformStop();
    const audit = tracker.finish(true);
    assert.equal(audit.unresolvedCommands, 1);
    assert.equal(audit.interruptedCommands, undefined);
  },
);
test("session success refuses an accepted attempt with an interrupted command", () => {
  const audit = (over: Partial<ProgramIoAudit>): ProgramIoAudit => ({
    version: 1,
    backend: "apple-container-vm",
    policyId: "policy",
    profileDigest: "a".repeat(64),
    cwd: fs.realpathSync(os.tmpdir()),
    preflightPassed: true,
    nativeCommands: 0,
    completedCommands: 0,
    unwrappedCommands: 0,
    unresolvedCommands: 0,
    invalidReceipts: 0,
    runtimeReadRoots: [],
    commands: [],
    ...over,
  });
  const state = (
    programIoAudit: ProgramIoAudit,
    completionAccepted?: boolean,
  ) =>
    ({
      graph: createAutonomousGraph(),
      targetProjectPath: os.tmpdir(),
      bindings: { test: { connectionId: "kilo" } },
      connections: [{ id: "kilo", type: "kilo" }],
      visits: [
        { nodeId: "test", attempts: [{ programIoAudit, completionAccepted }] },
      ],
    }) as unknown as SessionState;
  assert.equal(
    programIoEvidenceProblem(state(audit({ interruptedCommands: 1 }), false)),
    null,
  );
  assert.equal(
    programIoEvidenceProblem(state(audit({ interruptedCommands: 1 }))),
    null,
  );
  assert.ok(
    programIoEvidenceProblem(state(audit({ interruptedCommands: 1 }), true)),
  );
  assert.ok(
    programIoEvidenceProblem(state(audit({ interruptedCommands: 0 }), false)),
  );
  assert.ok(
    programIoEvidenceProblem(state(audit({ invalidReceipts: 1 }), false)),
  );
  assert.equal(validProgramIoAudit(audit({ interruptedCommands: 1 })), true);
  assert.equal(validProgramIoAudit(audit({ interruptedCommands: -1 })), false);
});
test("the evidence gate halts on invalid receipts and lets an interrupted command through", async () => {
  const outcome = async (counts: Partial<ProgramIoAudit>) => {
    const halts: string[] = [];
    const host = {
      state: {
        graph: { automation: {} },
        visits: [],
        executionBudget: {
          deadlineAt: "2999-01-01T00:00:00.000Z",
          maxAttempts: 1000,
          maxCostUsd: null,
          exhaustedReason: null,
        },
      },
      halt: async (_visit: unknown, status: string) => {
        halts.push(status);
        return { step: "stopped" };
      },
      contractStop: async () => false,
      budgetStop: async () => {},
      stageStop: async () => {},
    } as unknown as GateHost;
    const attempt = {
      programIoAudit: {
        invalidReceipts: 0,
        unresolvedCommands: 0,
        unwrappedCommands: 0,
        ...counts,
      },
    } as unknown as { failureKind?: string };
    await evidenceGates(
      host,
      {
        node: { type: "test" },
        visit: {},
        policy: {},
      } as unknown as Parameters<typeof evidenceGates>[1],
      {
        attempt,
        result: { outcome: "process_exit", evidence: {} },
      } as unknown as Parameters<typeof evidenceGates>[2],
    );
    return { halts, failure: attempt.failureKind };
  };
  assert.deepEqual((await outcome({ interruptedCommands: 1 })).halts, []);
  assert.deepEqual(await outcome({ invalidReceipts: 2 }), {
    halts: ["BLOCKED"],
    failure: "role_violation",
  });
  assert.deepEqual((await outcome({ unresolvedCommands: 1 })).halts, [
    "BLOCKED",
  ]);
});
const supervisorOptions = (
  policy: ProgramIoPolicy,
  root: string,
  cli: string,
) =>
  ({
    binary: process.execPath,
    args: [cli],
    transport: "pipe",
    cwd: policy.cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (v): v is [string, string] => typeof v[1] === "string",
        ),
      ),
      AGENT_GRAPH_PROGRAM_IO: JSON.stringify(policy),
    },
    programIoPolicy: policy,
    cols: 200,
    rows: 40,
    useConpty: false,
    transportTimeoutMs: 15000,
    idleTimeoutMs: 15000,
    toolTimeoutMs: 15000,
    phaseTimeoutMs: 30000,
    terminationGraceMs: 2000,
    killTimeoutMs: 2000,
    maxInMemoryOutputBytes: 1024 * 1024,
    rawLogPath: path.join(root, "native.log"),
    interactionWhitelist: [],
    destructivePrompts: [],
    sensitiveValues: [policy.privateKey],
  }) as Parameters<ProcessSupervisor["run"]>[0];
const denial = JSON.stringify({
  type: "tool_use",
  part: {
    id: "denied",
    tool: "bash",
    state: {
      status: "error",
      input: { command: "find . -type f | sort" },
      error: `${TEST_POLICY} Test role permits registered foreground checks only.`,
    },
  },
});
test(
  "the supervisor marks only its own stop of a live CLI",
  { skip: posix },
  async (t) => {
    for (const [name, script, policyStop] of [
      ["policy", `console.log(${sq(denial)});setInterval(()=>{},1000);`, true],
      ["self-exit", "console.log('{}');", false],
    ] as const) {
      const { root, policy, start, running } = stoppedFixture(t);
      const id = randomUUID(),
        cli = path.join(root, "cli.cjs");
      start(id);
      running(vmCommandName(policy.id, id));
      fs.writeFileSync(cli, script);
      const result = await new ProcessSupervisor().run({
        ...supervisorOptions(policy, root, cli),
        eventPolicy: policyStop ? testPolicyEvent : undefined,
      });
      const audit = result.evidence.programIoAudit!;
      assert.equal(audit.invalidReceipts, policyStop ? 0 : 2, name);
      assert.equal(audit.interruptedCommands, policyStop ? 1 : undefined, name);
      if (policyStop) {
        assert.equal(result.outcome, "process_exit");
        assert.equal(result.failureKind, "role_violation");
      }
    }
  },
);
test(
  "an interrupted command counts as a possible write only where the VM can write",
  { skip: posix },
  async (t) => {
    for (const mode of ["implementation", "test"] as const) {
      const { root, policy, start } = stoppedFixture(t, mode),
        cli = path.join(root, "cli.cjs");
      start(randomUUID());
      fs.writeFileSync(
        cli,
        `console.log(${sq(denial)});setInterval(()=>{},1000);`,
      );
      const result = await new ProcessSupervisor().run({
        ...supervisorOptions(policy, root, cli),
        eventPolicy: testPolicyEvent,
      });
      assert.equal(result.evidence.programIoAudit!.interruptedCommands, 1);
      assert.equal(result.evidence.fileMutation, mode === "implementation");
    }
  },
);
const vmNames = (policy: ProgramIoPolicy): string[] =>
  listVms(policy.vm!).filter((name) =>
    name.startsWith(vmCommandName(policy.id, "")),
  );
async function untilStarted(policy: ProgramIoPolicy): Promise<void> {
  const file = path.join(policy.directory, "receipts.jsonl"),
    deadline = Date.now() + 30000;
  while (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").length) {
    assert.ok(Date.now() < deadline, "the broker never signed a start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function untilVmListed(policy: ProgramIoPolicy): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!vmNames(policy).length) {
    assert.ok(Date.now() < deadline, "the VM never appeared");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function startBroker(command: string, policy: ProgramIoPolicy) {
  return spawn(
    "/bin/sh",
    ["-c", `exec ${wrapProgramCommand(command, policy)}`],
    {
      cwd: policy.cwd,
      env: { ...process.env, AGENT_GRAPH_PROGRAM_IO: JSON.stringify(policy) },
      stdio: "ignore",
    },
  );
}
for (const [when, vmUp] of [
  ["with its VM up", true],
  ["while its VM client is still creating it", false],
] as const)
  test(
    `VM: a broker killed ${when} leaves no VM and a signed start, and no broker starts another`,
    { skip: vmSkip },
    async (t) => {
      const { policy, target } = await workspace(t, "test", nativeVmBackend());
      fs.mkdirSync(path.join(target, "verification"), { recursive: true });
      const broker = startBroker(
        "sleep 2; echo late > verification/late.txt; sleep 60",
        policy,
      );
      await untilStarted(policy);
      if (vmUp) await untilVmListed(policy);
      const tracker = new ProgramIoTracker(policy);
      tracker.markPlatformStop();
      // Reaped first: its real parent, the CLI, is gone, so launchd collects it. This
      // test process is its parent, and finish() blocks the loop that would collect it.
      const killed = new Promise((resolve) => broker.once("close", resolve));
      broker.kill("SIGKILL");
      await killed;
      const audit = tracker.finish(true);
      assert.equal(audit.invalidReceipts, 0);
      assert.equal(audit.unresolvedCommands, 0);
      assert.equal(audit.interruptedCommands, 1);
      assert.equal(audit.commands.length, 0);
      assert.deepEqual(vmNames(policy), []);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.equal(
        fs.existsSync(path.join(target, "verification/late.txt")),
        false,
        "the interrupted command cannot act after the audit",
      );
      assert.deepEqual(vmNames(policy), []);
      const receipts = fs.readFileSync(
        path.join(policy.directory, "receipts.jsonl"),
        "utf8",
      );
      const late = run("echo late > verification/late.txt", policy);
      assert.equal(late.child.status, 125, late.child.stderr);
      assert.equal(
        fs.readFileSync(path.join(policy.directory, "receipts.jsonl"), "utf8"),
        receipts,
      );
      assert.deepEqual(vmNames(policy), []);
      assert.equal(
        fs.existsSync(path.join(target, "verification/late.txt")),
        false,
      );
    },
  );
test(
  "VM: a signed broker that outlives the CLI ends its VM and still counts as interrupted",
  { skip: vmSkip },
  async (t) => {
    const { policy } = await workspace(t, "test", nativeVmBackend());
    const broker = startBroker("sleep 60", policy);
    await untilStarted(policy);
    const closed = new Promise((resolve) => broker.once("close", resolve));
    const tracker = new ProgramIoTracker(policy);
    tracker.markPlatformStop();
    broker.kill("SIGTERM");
    const audit = tracker.finish(true);
    await closed;
    assert.equal(audit.invalidReceipts, 0);
    assert.equal(audit.interruptedCommands, 1);
    assert.deepEqual(vmNames(policy), []);
  },
);
test(
  "VM: a VM left running without a platform stop stays invalid",
  { skip: vmSkip },
  async (t) => {
    const { policy } = await workspace(t, "test", nativeVmBackend());
    const broker = startBroker("sleep 60", policy);
    await untilStarted(policy);
    await untilVmListed(policy);
    const killed = new Promise((resolve) => broker.once("close", resolve));
    broker.kill("SIGKILL");
    await killed;
    const audit = new ProgramIoTracker(policy).finish(true);
    assert.ok(audit.invalidReceipts > 0);
    assert.equal(audit.interruptedCommands, undefined);
    assert.deepEqual(vmNames(policy), []);
  },
);
test(
  "VM: parallel ls and a denied find end the test CLI without a false isolation violation",
  { skip: vmSkip },
  async (t) => {
    const { policy, root } = await workspace(t, "test", nativeVmBackend());
    const cli = path.join(root, "parallel-fixture.cjs");
    fs.writeFileSync(
      cli,
      `const{kiloCheckHooks}=require(${JSON.stringify(path.join(__dirname, "kilo_protocol.js"))});const c=require('node:child_process'),f=require('node:fs'),path=require('node:path'),p=JSON.parse(process.env.AGENT_GRAPH_PROGRAM_IO);(async()=>{const hooks=kiloCheckHooks({cwd:p.cwd,commands:[],testSourcesReadOnly:true,programIo:p});const args={command:'ls -la'};await hooks['tool.execute.before']({tool:'bash'},{args});c.spawn('/bin/sh',['-c',args.command],{cwd:p.cwd,env:process.env,stdio:'ignore'});const file=path.join(p.directory,'receipts.jsonl');while(!f.existsSync(file))await new Promise(r=>setTimeout(r,10));const denied={command:'find . -type f | sort'};let error='';try{await hooks['tool.execute.before']({tool:'bash'},{args:denied})}catch(e){error=e.message}console.log(JSON.stringify({type:'tool_use',part:{id:'find',tool:'bash',state:{status:'error',input:denied,error}}}));setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exitCode=1});`,
    );
    const result = await new ProcessSupervisor().run({
      ...supervisorOptions(policy, root, cli),
      eventPolicy: testPolicyEvent,
    });
    assert.equal(result.outcome, "process_exit", result.output);
    assert.equal(result.failureKind, "role_violation");
    assert.match(result.failureMessage!, /AGENT_GRAPH_TEST_POLICY/);
    const audit = result.evidence.programIoAudit!;
    assert.equal(audit.invalidReceipts, 0);
    assert.equal(audit.unresolvedCommands, 0);
    assert.equal(audit.unwrappedCommands, 0);
    assert.equal(audit.interruptedCommands, 1);
    assert.deepEqual(vmNames(policy), []);
  },
);
