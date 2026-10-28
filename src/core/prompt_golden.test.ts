import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAutonomousGraph, createGraph } from "./graph";
import { deriveRequirementLedger } from "./requirement_ledger";
import { buildNodePrompt, buildRecoveryMessage } from "./prompt";
import { AgentGraphDocument, NodeType, NodeVisit, SessionState, NODE_TYPES } from "../shared/domain";
import { FailureKind } from "../shared/execution_types";

// Golden prompts pin the exact model input before prompt.ts is restructured.
// Regenerate only for an intended prompt change: UPDATE_GOLDEN=1 npm test
const goldenDir = path.resolve(__dirname, "../../../test/golden/prompts");
const now = Date.parse("2026-01-01T00:00:00.000Z");
const target = path.join(os.tmpdir(), "agent-graph-golden", "project");
const extra = path.join(os.tmpdir(), "agent-graph-golden", "shared");
const cli = path.resolve(__dirname, "../server/cli.js");
const escaped = (s: string) => JSON.stringify(s).slice(1, -1);
function normalize(text: string): string {
  let out = text;
  for (const [value, token] of [[cli, "<CLI>"], [target, "<TARGET>"], [extra, "<EXTRA>"]] as const)
    out = out.split(escaped(value)).join(token).split(value).join(token);
  return out;
}
function matchGolden(name: string, actual: string): void {
  const file = path.join(goldenDir, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(goldenDir, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  assert.ok(fs.existsSync(file), `missing golden ${name}; run UPDATE_GOLDEN=1 npm test`);
  assert.equal(actual, fs.readFileSync(file, "utf8"), `${name} changed; update goldens only for an intended prompt change`);
}
const receipt = (command: string, exitCode = 0) => ({ id: `r-${command}`, command, exitCode, environmentError: null });
function visit(nodeId: string, fields: Partial<NodeVisit> = {}): NodeVisit {
  return {
    id: `visit-${nodeId}`, nodeId, number: 1, status: "running",
    startedAt: "2025-12-31T23:00:00.000Z", completedAt: null, attempts: [], output: "",
    verdict: null, plans: [], selectedPlanId: null,
    cycleStartedAt: "2025-12-31T23:00:00.000Z", cycleDeadlineAt: "2026-01-01T01:00:00.000Z",
    recoveryCount: 0, transitionCommitted: false, automaticCycles: 0, ...fields,
  };
}
function session(graph: AgentGraphDocument, goal: string, connectionType: "codex" | "kilo" = "kilo"): SessionState {
  graph.id = "graph-golden";
  graph.updatedAt = "2025-12-31T00:00:00.000Z";
  return {
    stateVersion: 3, id: "session-golden", requestId: "request-golden", goal, targetProjectPath: target, graph,
    connections: [{ id: "conn", label: "Golden CLI", type: connectionType, binary: "golden-cli" }],
    bindings: Object.fromEntries(graph.nodes.map((n) => [n.id, { connectionId: "conn", modelId: "golden-model" }])),
    status: "RUNNING", statusReason: null, createdAt: "2025-12-31T23:00:00.000Z", updatedAt: "2025-12-31T23:00:00.000Z",
    currentNodeId: null, activeVisitId: null, visits: [], completedIterations: 0, visitLimit: 40, iterationLimit: 20,
    accessMode: "ask", additionalAllowedPaths: [], pendingAccess: null, pendingApproval: null, approvedPlanRef: null,
    automaticRecovery: null, processedRequests: [], interruptMessage: null,
    requirements: deriveRequirementLedger(goal),
    convergence: { stagnantCycles: 0, history: [] },
  } as unknown as SessionState;
}
const nodeOf = (state: SessionState, type: NodeType) => state.graph.nodes.find((n) => n.type === type)!;
function prompt(state: SessionState, type: NodeType, current = visit(type), recovery?: string): string {
  state.visits = [...state.visits.filter((v) => v.id !== current.id), current];
  return normalize(buildNodePrompt(state, nodeOf(state, type), current, recovery));
}
const lockedManifest = {
  version: 1 as const,
  protectedFiles: ["tests/verify-acceptance.mjs"],
  checks: [
    { id: "node", command: "npm test", requirements: ["REQ-001"] },
    { id: "acceptance", command: "node tests/verify-acceptance.mjs", requirements: ["REQ-001", "REQ-002"] },
  ],
  requiredFiles: [{ path: "README.md", requirements: ["REQ-002"] }],
  nodeTests: {
    checkId: "self_tests", suiteCheckId: "node",
    scopes: [{ id: "behavior", file: "test/behavior.test.mjs", requirements: ["REQ-001"], cases: ["behavior:boundary"],
      challenges: [{ id: "wrong-result", adapter: "tests/probes/defect.mjs", targets: ["module.mjs"] }] }],
  },
};
// Prior evidence for the locked autonomous cycle: one passing test, then a failed review.
function lockedSession(): SessionState {
  const state = session(createAutonomousGraph(), "Build a todo app and document it in README.md", "codex");
  state.verificationContract = { version: 1, status: "locked", origin: "implementation", lockedAt: "2025-12-31T23:10:00.000Z",
    manifest: lockedManifest, hashes: { "tests/verify-acceptance.mjs": "hash" }, digest: "digest" };
  state.executionBudget = { startedAt: "2025-12-31T23:00:00.000Z", deadlineAt: "2026-01-01T00:30:00.000Z", maxAttempts: 24, exhaustedReason: null };
  state.visits = [
    visit("planning", { id: "v1-planning", status: "succeeded", completedAt: "2025-12-31T23:05:00.000Z", output: "## OPTION 1: Single page\nPlan body", plans: [{ id: 1, title: "Single page", body: "Plan body for REQ-001 and REQ-002", revision: 1 }], selectedPlanId: 1 }),
    visit("test", { id: "v2-test", status: "succeeded", completedAt: "2025-12-31T23:20:00.000Z", verdict: "PASS", output: "[AGENT_REPORT]{}[/AGENT_REPORT]", verifiedCommands: [receipt("npm test"), receipt("node tests/verify-acceptance.mjs")] }),
    visit("review", { id: "v3-review", status: "failed", completedAt: "2025-12-31T23:30:00.000Z", verdict: "REJECTED", output: "README.md omits the controls section" }),
  ];
  state.approvedPlanRef = { visitId: "v1-planning", choiceId: 1, revision: 1 };
  return state;
}

test("prompt goldens: legacy graph roles", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const type of NODE_TYPES)
    matchGolden(`legacy-${type}.txt`, prompt(session(createGraph(), "Build a todo app"), type));
});
test("prompt goldens: autonomous graph with a pending contract", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const type of NODE_TYPES)
    matchGolden(`auto-pending-${type}.txt`, prompt(session(createAutonomousGraph(), "Build a todo app"), type));
});
test("prompt goldens: autonomous graph with a locked contract, budgets and repair handoff", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const type of NODE_TYPES)
    matchGolden(`auto-locked-${type}.txt`, prompt(lockedSession(), type, visit(type, { id: `v4-${type}`, stageDeadlineAt: "2026-01-01T00:10:00.000Z" })));
});
test("prompt goldens: access, research, operator message and recovery variants", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const full = session(createGraph(), "Build a todo app");
  full.accessMode = "full_access";
  matchGolden("legacy-full-access-implementation.txt", prompt(full, "implementation", visit("implementation"), "[process_exit] CLI exit 1"));
  const scoped = session(createGraph(), "Build a todo app");
  scoped.additionalAllowedPaths = [extra];
  scoped.interruptMessage = "Stop after the current check";
  matchGolden("legacy-extra-roots-interrupt.txt", prompt(scoped, "interrupt"));
  const research = session(createGraph(), "Research current React routing options on the web and build a demo");
  for (const type of ["planning", "review", "approval"] as const)
    matchGolden(`legacy-research-${type}.txt`, prompt(research, type));
  // Legacy test recovery chooses among four receipt states.
  const evidence = "[REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001\nSTATUS: SATISFIED\nEVIDENCE: ran\nCHECK_COMMAND: npm test\n[/REQUIREMENT_EVIDENCE]\nVERDICT: PASS";
  const variants: Record<string, Partial<NodeVisit>> = {
    "no-receipts": { output: evidence },
    "failed-receipt": { output: evidence, verifiedCommands: [receipt("npm test", 1)] },
    "missing-check": { output: evidence.replace("CHECK_COMMAND: npm test", "CHECK_COMMAND: node --test"), verifiedCommands: [receipt("npm test")] },
    "format-only": { output: evidence, verifiedCommands: [receipt("npm test")] },
  };
  for (const [name, fields] of Object.entries(variants))
    matchGolden(`legacy-test-recovery-${name}.txt`, prompt(session(createGraph(), "Build a todo app"), "test", visit("test", fields), "missing PHASE_DONE"));
});
test("prompt goldens: recovery messages for every failure kind", () => {
  const kinds: FailureKind[] = ["transport_timeout", "idle_timeout", "tool_timeout", "phase_timeout", "spawn_error", "process_exit",
    "incomplete_response", "network", "tool_arguments", "rate_limited", "quota_exhausted", "auth", "model_unavailable",
    "permission", "role_violation", "cancelled", "orphaned_process", "unknown"];
  const events = [{ type: "tool_use", part: { tool: "write", state: { status: "error", error: "filePath and content are required" } } }];
  const messages: Record<string, string> = {};
  for (const kind of kinds) messages[kind] = buildRecoveryMessage(kind, `${kind} happened`, "previous output", events, "implementation");
  messages["tool_arguments:write"] = buildRecoveryMessage("tool_arguments", 'Stopped after 3 consecutive invalid-argument failures for the "write" tool.', "out", events, "implementation");
  messages["tool_arguments:frozen-test"] = buildRecoveryMessage("tool_arguments", "unavailable write", "out", events, "test", true);
  messages["unscoped-termination"] = buildRecoveryMessage("process_exit", "[AGENT_GRAPH_UNSCOPED_TERMINATION] pkill node", "out", [], "implementation");
  messages["long-output"] = buildRecoveryMessage("process_exit", "exit", "x".repeat(6000), [], "implementation");
  matchGolden("recovery-messages.json", JSON.stringify(messages, null, 2) + "\n");
});
