import test from "node:test";
import assert from "node:assert/strict";
import { outsidePaths } from "./access_paths";
import { CommandTracker, currentTestProof, isVerificationCommand } from "./verification_evidence";
import { SessionState, NodeVisit } from "../shared/domain";
import { createGraph } from "./graph";
import { buildNodePrompt } from "./prompt";
import { deriveRequirementLedger } from "./requirement_ledger";

test("prompt path scan preserves spaces, URL targets and actual external requests", () => {
  const root = "/Users/me/Desktop/agent graph test/game";
  for (const text of ["HTTP GET /styles.css should return 200", "GET /../results/goal.txt", "URL /?check=1", "GET /%2e%2e%2fresults%2fgoal.txt", `Read "${root}/main.js"`, `Read \`${root}/main.js\``, "fetch https://example.com/styles.css"])
    assert.deepEqual(outsidePaths(text, [root]), [], text);
  assert.deepEqual(outsidePaths('Read /tmp/outside.txt', [root]), ["/tmp/outside.txt"]);
  assert.deepEqual(outsidePaths(`Read "${root}/../outside file.txt"`, [root]), [`${root}/../outside file.txt`]);
  assert.deepEqual(outsidePaths('HTTP test needs FILE_ACCESS: /secret/file.txt', [root]), ["/secret/file.txt"]);
  assert.deepEqual(outsidePaths('Read "C:\\work space\\game\\main.js"', ['C:\\work space\\game']), []);
  assert.deepEqual(outsidePaths('Read "C:\\work space\\other\\file.txt"', ['C:\\work space\\game']), ['C:\\work space\\other\\file.txt']);
});

test("only executed validation commands qualify; report reads and masked failures cannot", () => {
  for (const c of ["npm test", "cd '/a b' && npm test", "/bin/zsh -lc 'node --test'", "node verification/check-engine.mjs", "python3 -m pytest", "npx playwright test"])
    assert.equal(isVerificationCommand(c), true, c);
  for (const c of ["echo npm test", "cat test-results.json", "npm test || true", "false; npm test", "npm test | cat", "node -e 'console.log(\"passed\")'", "echo x && npm test"])
    assert.equal(isVerificationCommand(c), false, c);
});

const codex = (command: string, code: number, output = "") => ({ type: "item.completed", item: { id: "check", type: "command_execution", command, exit_code: code, aggregated_output: output, status: "completed" } });
test("native receipts distinguish blocked, failed, successful and unexecuted checks across providers", () => {
  const tracker = new CommandTracker();
  tracker.observe({ type: "text", part: { text: "npm test passed with exit 0" } });
  assert.equal(tracker.receipts.length, 0);
  tracker.observe(codex("npm test", 1, "Error: listen EPERM: operation not permitted"));
  assert.match(tracker.receipts[0]!.environmentError!, /listen EPERM/);
  tracker.observe(codex("npm test", 0));
  assert.equal(tracker.receipts.length, 1);
  assert.equal(tracker.receipts[0]!.environmentError, null);
  tracker.observe({ type: "tool_use", part: { callID: "kilo", tool: "bash", state: { status: "completed", input: { command: "node --test" }, metadata: { exit: 2 }, output: "assertion failed" } } });
  assert.equal(tracker.receipts[1]!.exitCode, 2);
  tracker.observe({ type: "tool_use", part: { callID: "denied", tool: "bash", state: { status: "error", input: { command: "pytest" }, error: "Tool denied" } } });
  assert.equal(tracker.receipts[2]!.exitCode, null);
  tracker.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "claude", name: "Bash", input: { command: "go test ./..." } }] } });
  tracker.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "claude", is_error: false, content: "ok" }] } });
  assert.equal(tracker.receipts.at(-1)!.exitCode, 0);
  tracker.observe({ type: "item.completed", item: { id: "failed-zero", type: "command_execution", command: "npm run verify", exit_code: 0, status: "failed" } });
  assert.equal(tracker.receipts.at(-1)!.exitCode, null, "native failure status cannot be promoted by exit zero");
  tracker.observe({ type: "item.completed", item: { id: "edit", type: "file_change", status: "completed" } });
  assert.equal(tracker.receipts.length, 0, "later edits invalidate earlier checks");
});

test("proof is invalidated by subsequent implementation or failed tests; legacy snapshots fail closed", () => {
  const check = { id: "c", command: "npm test", exitCode: 0, environmentError: null };
  const passed = { id: "test1", nodeId: "test", status: "succeeded", verdict: "PASS", completedAt: "2026-10-24", output: "[REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001\nSTATUS: SATISFIED\nEVIDENCE: executed\nCHECK_COMMAND: npm test\n[/REQUIREMENT_EVIDENCE]\nVERDICT: PASS\n[PHASE_DONE]", attempts: [{ status: "succeeded", completionAccepted: true, endedAt: "2026-10-24", commands: [check] }], verifiedCommands: [check] } as NodeVisit;
  const review = { id: "review1", nodeId: "review" } as NodeVisit;
  const state = { graph: createGraph(), requirements: deriveRequirementLedger("goal"), visits: [passed, review] } as SessionState;
  assert.deepEqual(currentTestProof(state, review), [check]);
  state.visits.splice(1, 0, { id: "impl2", nodeId: "implementation" } as NodeVisit);
  assert.deepEqual(currentTestProof(state, review), []);
  state.visits = [{ ...passed, attempts: [], verifiedCommands: undefined }, review];
  assert.deepEqual(currentTestProof(state, review), []);
});


test("foreground capture retains the native failing exit; background and reporting suffixes are never proof", () => {
  const capture = "npm test > verification/model-tests.txt 2>&1";
  assert.equal(isVerificationCommand(capture), true);
  const tracker = new CommandTracker();
  tracker.observe(codex(capture, 1, "1 failing test"));
  assert.equal(tracker.receipts[0]!.exitCode, 1);
  for (const c of ["npm test &", "npm test & true", "npm test 2>&1 &", "npm test > out; echo $?", "npm test 2>&1 | tee out; echo $?"])
    assert.equal(isVerificationCommand(c), false, c);
});


test("only writable roles receive test-execution instructions; audits inspect existing native proof", () => {
  const graph = createGraph();
  for (const node of graph.nodes) {
    const visit = { id: "visit", nodeId: node.id, attempts: [] } as unknown as NodeVisit;
    const state = { id: "session", graph, goal: "build a local app", requirements: deriveRequirementLedger("build a local app"), visits: [visit], accessMode: "ask", additionalAllowedPaths: [], targetProjectPath: "/work" } as unknown as SessionState;
    const prompt = buildNodePrompt(state, node, visit);
    const writable = ["implementation", "test"].includes(node.type);
    assert.equal(prompt.includes("=== VERIFICATION EXECUTION CONTRACT ==="), writable);
    assert.equal(prompt.includes("must not execute tests or start servers"), !writable);
    if (node.type === "test") assert.match(prompt, /EVIDENCE: concrete observed check or artifact\nCHECK_COMMAND: exact executed foreground test command/);
  }
});
