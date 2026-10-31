import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ProcessSupervisor,
  ProcessSupervisorOptions,
} from "./process_supervisor";
import { ClaimedControlRequest } from "./resilience";

// Pins the supervisor paths process_supervisor.test.ts does not reach, so its
// decomposition can be compared. Pipe transport runs the same on every OS.
async function supervise(
  t: TestContext,
  script: string,
  overrides: Partial<ProcessSupervisorOptions> = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rawLogPath = path.join(directory, "logs/raw.log");
  const result = await new ProcessSupervisor().run({
    transport: "pipe",
    binary: process.execPath,
    args: ["-e", script],
    cwd: directory,
    env: process.env as Record<string, string>,
    cols: 200,
    rows: 40,
    useConpty: false,
    transportTimeoutMs: 5000,
    idleTimeoutMs: 5000,
    toolTimeoutMs: 5000,
    phaseTimeoutMs: 8000,
    terminationGraceMs: 500,
    killTimeoutMs: 2000,
    maxInMemoryOutputBytes: 1024 * 1024,
    rawLogPath,
    interactionWhitelist: [],
    destructivePrompts: [],
    ...overrides,
  });
  return { result, rawLogPath };
}
const live = "console.log('started');setInterval(()=>{},1000);";
const event = (value: unknown) =>
  `console.log(${JSON.stringify(JSON.stringify(value))});`;
const controlRequest = (
  type: "STOP" | "INTERRUPT",
  message?: string,
): ClaimedControlRequest =>
  ({
    request: { type, ...(message ? { message } : {}) },
  }) as unknown as ClaimedControlRequest;

test("a clean exit succeeds and a nonzero exit reports its code", async (t) => {
  const clean = await supervise(t, "console.log('ok');");
  assert.equal(clean.result.outcome, "succeeded");
  assert.equal(clean.result.failureKind, null);
  assert.equal(clean.result.exitCode, 0);
  assert.equal(clean.result.timedOut, false);
  assert.equal(clean.result.cancelled, false);
  assert.match(await fs.readFile(clean.rawLogPath, "utf8"), /ok/);
  const failed = await supervise(t, "console.log('x');process.exit(3);");
  assert.equal(failed.result.outcome, "process_exit");
  assert.equal(failed.result.failureKind, "process_exit");
  assert.equal(failed.result.failureMessage, "Process exited with code 3");
  assert.equal(failed.result.exitCode, 3);
});
test("a missing binary is a spawn error with the audits still attached", async (t) => {
  const { result } = await supervise(t, "", {
    binary: path.join(os.tmpdir(), "no-such-binary-for-supervisor"),
    scopeRoots: [os.tmpdir()],
  });
  assert.equal(result.outcome, "spawn_error");
  assert.equal(result.failureKind, "spawn_error");
  assert.equal(result.exitCode, -1);
  assert.equal(result.assistantText, "");
  assert.ok(result.evidence.scopeAudit);
});
test("a claimed stop or interrupt cancels the child and keeps the request", async (t) => {
  for (const [request, message] of [
    [controlRequest("STOP"), "User requested stop"],
    [
      controlRequest("INTERRUPT", "look here"),
      "User requested interrupt: look here",
    ],
  ] as const) {
    let polls = 0;
    const { result } = await supervise(t, live, {
      pollControl: async () => (++polls >= 2 ? request : null),
    });
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.failureKind, "cancelled");
    assert.equal(result.failureMessage, message);
    assert.equal(result.cancelled, true);
    assert.equal(result.controlRequest, request);
  }
});
test("a policy poll stops the child as a role violation, and a control claim wins over it", async (t) => {
  const policy = await supervise(t, live, {
    pollPolicy: async () => "policy says stop",
  });
  assert.equal(policy.result.outcome, "process_exit");
  assert.equal(policy.result.failureKind, "role_violation");
  assert.equal(policy.result.failureMessage, "policy says stop");
  assert.equal(policy.result.cancelled, false);
  const claimed = await supervise(t, live, {
    pollControl: async () => controlRequest("STOP"),
    pollPolicy: async () => "policy says stop",
  });
  assert.equal(claimed.result.outcome, "cancelled");
});
test("an event policy reason picks the failure kind from its marker", async (t) => {
  for (const [reason, kind] of [
    ["[AGENT_GRAPH_UNSCOPED_TERMINATION] no", "tool_arguments"],
    ["[AGENT_GRAPH_TEST_FAILED] no", "process_exit"],
    ["other", "role_violation"],
  ] as const) {
    const seen: unknown[] = [];
    const { result } = await supervise(
      t,
      `${event({ type: "marker" })}${live}`,
      {
        eventPolicy: (value) => {
          seen.push(value);
          return reason;
        },
      },
    );
    assert.equal(result.outcome, "process_exit");
    assert.equal(result.failureKind, kind);
    assert.equal(result.failureMessage, reason);
    assert.deepEqual(seen[0], { type: "marker" });
  }
});
test("a whitelisted prompt is answered once and a destructive one is not", async (t) => {
  const prompt = `console.log('continue deploy now');process.stdin.on('data',d=>{console.log('answer:'+d.toString().trim());process.exit(0);});setTimeout(()=>process.exit(9),1500);`;
  const answered = await supervise(t, prompt, {
    interactionWhitelist: ["continue deploy"],
  });
  assert.equal(answered.result.outcome, "succeeded");
  assert.equal(answered.result.autoInjected.length, 1);
  assert.equal(answered.result.autoInjected[0]!.response, "y");
  assert.match(answered.result.output, /answer:y/);
  const refused = await supervise(t, prompt, {
    interactionWhitelist: ["continue deploy"],
    destructivePrompts: ["deploy now"],
  });
  assert.equal(refused.result.exitCode, 9);
  assert.deepEqual(refused.result.autoInjected, []);
});
test("the raw log stops at its limit and says so, while progress keeps reporting", async (t) => {
  const progress: string[] = [];
  const output: string[] = [];
  const { result, rawLogPath } = await supervise(
    t,
    "for(let i=0;i<10;i++)process.stdout.write('x'.repeat(1024*1024)+'\\n');",
    {
      maxInMemoryOutputBytes: 64 * 1024,
      onProgress: (value) => {
        progress.push(value.activity);
      },
      onOutput: (text) => output.push(text),
    },
  );
  assert.equal(result.outcome, "succeeded");
  const log = await fs.readFile(rawLogPath, "utf8");
  assert.match(log, /\[AGENT_LOOP_LOG_TRUNCATED\]\n$/);
  assert.ok(Buffer.byteLength(log) < 9 * 1024 * 1024);
  assert.ok(Buffer.byteLength(result.output) <= 64 * 1024);
  assert.equal(progress[0], "initial_transport");
  assert.equal(progress.at(-1), "model_generation");
  assert.ok(output.length > 0);
});
test("sensitive values never reach the log, output or events", async (t) => {
  const { result, rawLogPath } = await supervise(
    t,
    `console.log('secret-value');${event({ type: "text", part: { text: "secret-value" } })}`,
    { sensitiveValues: ["secret-value", ""] },
  );
  assert.ok(!(await fs.readFile(rawLogPath, "utf8")).includes("secret-value"));
  assert.ok(!result.output.includes("secret-value"));
  assert.ok(!JSON.stringify(result.events).includes("secret-value"));
});
