import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SessionState, NodeVisit } from "../shared/domain";
import { createAutonomousGraph } from "./graph";
import { deriveRequirementLedger } from "./requirement_ledger";
import { lockContract, CONTRACT_FILE } from "./verification_contract";
import { validateCompletion } from "./completion";
import { emptyEvidence } from "./event_evidence";
import { emptyCliDiagnostics } from "./cli_diagnostics";
import { SupervisorResult } from "./process_supervisor";
import { buildNodePrompt } from "./prompt";
const cmd = "node tests/verify-acceptance.mjs";
const result = (assistantText: string): SupervisorResult => ({
  pid: 1,
  outcome: "succeeded",
  failureKind: null,
  failureMessage: null,
  exitCode: 0,
  output: assistantText,
  assistantText,
  events: [],
  cliSessionId: null,
  startedAt: "",
  endedAt: "",
  timedOut: false,
  cancelled: false,
  rawLogPath: "",
  controlRequest: null,
  autoInjected: [],
  evidence: emptyEvidence(),
  diagnostics: emptyCliDiagnostics(),
});
const framed = (requirements: unknown[], verdict = "PASS") =>
  `[AGENT_REPORT]\n${JSON.stringify({ version: 1, verdict, requirements })}\n[/AGENT_REPORT]`;
test("JSON judgments bind to actual contract receipts without model-authored command strings or sentinel", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "json-report-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".agent-graph"));
  await fs.mkdir(path.join(root, "tests"));
  await fs.writeFile(
    path.join(root, "tests/verify-acceptance.mjs"),
    "// acceptance\n",
  );
  await fs.writeFile(
    path.join(root, CONTRACT_FILE),
    JSON.stringify({
      version: 1,
      protectedFiles: ["tests/verify-acceptance.mjs"],
      checks: [{ id: "acceptance", command: cmd, requirements: ["REQ-001"] }],
    }),
  );
  const graph = createAutonomousGraph();
  graph.automation!.browserVerification = false;
  const requirements = deriveRequirementLedger("goal").items;
  const state = {
    id: "session",
    targetProjectPath: root,
    graph,
    requirements: deriveRequirementLedger("goal"),
    goal: "goal",
    visits: [],
    accessMode: "ask",
    additionalAllowedPaths: [],
  } as unknown as SessionState;
  state.verificationContract = await lockContract(state, "supplied");
  const node = graph.nodes.find((n) => n.type === "test")!,
    receipt = {
      id: "native-observed",
      command: cmd,
      exitCode: 0,
      environmentError: null,
    };
  const row = {
    id: "REQ-001",
    status: "SATISFIED",
    evidence: "actual assertion",
    CHECK_COMMAND: "invented command",
  };
  const c = validateCompletion(node, result(framed([row])), {
    goal: "goal",
    requirements,
    commands: [receipt],
    priorTestProof: [],
    automation: graph.automation,
    contract: state.verificationContract,
  });
  assert.equal(c.valid, true);
  assert.equal(c.verdict, "PASS");
  assert.match(c.output, /native-observed \(exit 0\)/);
  assert.match(c.output, /CHECK_COMMAND: node tests\/verify-acceptance.mjs/);
  assert.doesNotMatch(c.output, /invented command/);
  assert.ok(c.output.endsWith("[PHASE_DONE]"));
  for (const bad of [
    framed([]),
    framed([row, row]),
    framed([{ ...row, id: "REQ-999" }]),
    framed([{ ...row, status: "SUCCESS" }]),
    "[AGENT_REPORT] {unfinished",
    "VERDICT: PASS\n[PHASE_DONE]",
  ]) {
    assert.equal(
      validateCompletion(node, result(bad), {
        goal: "goal",
        requirements,
        commands: [receipt],
        priorTestProof: [],
        automation: graph.automation,
        contract: state.verificationContract,
      }).valid,
      false,
      bad,
    );
  }
  const cdReceipt = { ...receipt, command: `cd '${root}' && ${cmd}` };
  const cd = validateCompletion(node, result(framed([row])), {
    goal: "goal",
    requirements,
    commands: [cdReceipt],
    priorTestProof: [],
    automation: graph.automation,
    contract: state.verificationContract,
    cwd: root,
  });
  assert.equal(cd.valid, true);
  assert.equal(cd.verdict, "PASS");
  assert.match(cd.output, /cd '/);
  const other = validateCompletion(node, result(framed([row])), {
    goal: "goal",
    requirements,
    commands: [cdReceipt],
    priorTestProof: [],
    automation: graph.automation,
    contract: state.verificationContract,
    cwd: root + "-other",
  });
  assert.equal(other.valid, false);
  const missing = validateCompletion(node, result(framed([row])), {
    goal: "goal",
    requirements,
    commands: [],
    priorTestProof: [],
    automation: graph.automation,
    contract: state.verificationContract,
  });
  assert.equal(missing.valid, false);
  assert.match(missing.reason!, /acceptance/);
  const failed = validateCompletion(node, result(framed([row])), {
    goal: "goal",
    requirements,
    commands: [{ ...receipt, exitCode: 1 }],
    priorTestProof: [],
    automation: graph.automation,
    contract: state.verificationContract,
  });
  assert.equal(failed.verdict, "FAIL");
  assert.notEqual(failed.verdict, "PASS");
  const visit = {
    id: "visit",
    nodeId: node.id,
    attempts: [],
    output: c.output,
    verifiedCommands: [receipt],
  } as unknown as NodeVisit;
  state.visits = [visit];
  const prompt = buildNodePrompt(state, node, visit, "repair JSON");
  assert.match(prompt, /All frozen checks already/);
  assert.doesNotMatch(prompt, /CHECK_COMMAND: exact executed/);
});
