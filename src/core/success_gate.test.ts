import test from "node:test";
import assert from "node:assert/strict";
import { NodeVisit, SessionState } from "../shared/domain";
import { createGraph } from "./graph";
import { deriveRequirementLedger } from "./requirement_ledger";
import { successBlockers } from "./success_gate";
import { currentTestProof } from "./verification_evidence";

const receipt = { id: "native", command: "npm test", exitCode: 0, environmentError: null };
function report(verdict: string): string {
  return ["REQ-001", "REQ-002"].map(id => `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${id}\nSTATUS: SATISFIED\nEVIDENCE: asserted required behavior\nCHECK_COMMAND: npm test\n[/REQUIREMENT_EVIDENCE]`).join("\n") + `\n${verdict}\n[PHASE_DONE]`;
}
function visit(nodeId: string): NodeVisit {
  return {
    id: nodeId, nodeId, status: "succeeded", completedAt: "2026-10-24T00:00:00Z", transitionCommitted: true,
    verdict: nodeId === "test" ? "PASS" : "APPROVED",
    output: report(nodeId === "test" ? "VERDICT: PASS" : "APPROVED"),
    attempts: [{ id: `${nodeId}-attempt`, status: "succeeded", endedAt: "2026-10-24T00:00:00Z", failureKind: null, pid: null, completionAccepted: true, commands: nodeId === "test" ? [structuredClone(receipt)] : [] }],
  } as NodeVisit;
}
function completed(): SessionState {
  const requirements = deriveRequirementLedger("Build the game\nHandle keyboard input");
  requirements.evidence = requirements.items.map(r => ({ requirementId: r.id, stageId: "approval", role: "Reviewer", status: "SATISFIED", summary: "observed", attemptId: "approval-attempt", recordedAt: "2026-10-24T00:00:00Z" }));
  return { graph: createGraph(), requirements, visits: [visit("test"), visit("review"), visit("approval")], currentNodeId: "SUCCESS", activeVisitId: null, pendingApproval: null, pendingAccess: null } as SessionState;
}

test("terminal success requires all requirements, observed tests and a final successful approval", () => {
  assert.deepEqual(successBlockers(completed()), []);
});
const invalid: Record<string, (s: SessionState) => void> = {
  "implementation bypass": s => { s.visits = [visit("implementation")]; },
  "review is not final approval": s => { s.visits.pop(); },
  "approval failure edge": s => { s.visits.at(-1)!.status = "failed"; s.visits.at(-1)!.verdict = "REJECTED"; },
  "missing approval attempt": s => { s.visits.at(-1)!.attempts = []; },
  "old approval without accepted completion": s => { delete s.visits.at(-1)!.attempts[0]!.completionAccepted; },
  "provider failure": s => { s.visits.at(-1)!.attempts[0]!.failureKind = "auth"; },
  "incomplete final response": s => { s.visits.at(-1)!.output = report("APPROVED").replace("[PHASE_DONE]", ""); },
  "pending plan approval": s => { s.pendingApproval = { nodeId: "planning", visitId: "plan" }; },
  "pending access approval": s => { s.pendingAccess = { nodeId: "implementation", visitId: "impl", paths: ["/outside"] }; },
  "missing final requirement": s => { s.visits.at(-1)!.output = report("APPROVED").replace("REQ-002", "REQ-999"); },
  "unresolved final requirement": s => { s.visits.at(-1)!.output = report("APPROVED").replace("SATISFIED", "PARTIAL"); },
  "empty requirement ledger": s => { s.requirements.items = []; },
  "unresolved ledger": s => { s.requirements.evidence[0]!.status = "BLOCKED"; },
  "no test visit": s => { s.visits.shift(); },
  "test FAIL": s => { s.visits[0]!.verdict = "FAIL"; },
  "test BLOCKED": s => { s.visits[0]!.verdict = "BLOCKED"; },
  "missing test requirement": s => { s.visits[0]!.output = report("VERDICT: PASS").replace("REQ-002", "REQ-999"); },
  "no native receipts despite saved proof": s => { s.visits[0]!.verifiedCommands = [receipt]; s.visits[0]!.attempts[0]!.commands = []; },
  "nonzero test exit": s => { s.visits[0]!.attempts[0]!.commands![0]!.exitCode = 1; },
  "unknown test exit": s => { s.visits[0]!.attempts[0]!.commands![0]!.exitCode = null; },
  "blocked test receipt": s => { s.visits[0]!.attempts[0]!.commands![0]!.environmentError = "EPERM"; },
  "prose instead of test execution": s => { s.visits[0]!.attempts[0]!.commands![0]!.command = "echo passed"; },
  "mismatched CHECK_COMMAND": s => { s.visits[0]!.output = report("VERDICT: PASS").replaceAll("npm test", "npm run verify"); },
  "old test without accepted completion": s => { delete s.visits[0]!.attempts[0]!.completionAccepted; },
  "reimplementation after tests": s => { s.visits.splice(1, 0, visit("implementation")); },
  "replanning after tests": s => { s.visits.splice(1, 0, visit("planning")); },
  "interrupt after tests": s => { s.visits.splice(1, 0, visit("interrupt")); },
  "failed review bypass": s => { s.visits[1]!.status = "failed"; s.visits[1]!.verdict = "REJECTED"; },
  "failed review command": s => { s.visits[1]!.attempts[0]!.commands = [{ ...receipt, exitCode: 1 }]; },
  "failed approval command": s => { s.visits[2]!.attempts[0]!.commands = [{ ...receipt, exitCode: 1 }]; },
  "failed command retained across report repair": s => { s.visits[2]!.attempts.unshift({ ...s.visits[2]!.attempts[0]!, completionAccepted: false, commands: [{ ...receipt, exitCode: 1 }] }); },
  "review mutation": s => { s.visits[1]!.attempts[0]!.fileMutation = true; },
  "approval mutation": s => { s.visits[2]!.attempts[0]!.fileMutation = true; },
};
for (const [name, mutate] of Object.entries(invalid)) test(`success gate blocks ${name}`, () => {
  const s = completed(); mutate(s);
  assert.ok(successBlockers(s).length, name);
});
test("a repaired cycle with fresh tests and approval can succeed after earlier failures", () => {
  const s = completed();
  const failed = visit("test"); failed.id = "old-test"; failed.status = "failed"; failed.verdict = "FAIL";
  s.visits.unshift(failed, { ...visit("implementation"), id: "repair" });
  assert.deepEqual(successBlockers(s), []);
});
test("test authors may add tests; only receipts after the last observed edit survive report recovery", () => {
  const s = completed(), v = s.visits[0]!;
  v.attempts.unshift({ ...v.attempts[0]!, completionAccepted: false, failureKind: "incomplete_response" });
  v.attempts[1]!.fileMutation = true;
  assert.deepEqual(successBlockers(s), [], "new tests were run after editing");
  v.attempts[1]!.commands = [];
  assert.equal(currentTestProof(s, s.visits[2]!).length, 0, "checks before editing are stale");
});
