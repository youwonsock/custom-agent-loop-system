import test from "node:test";
import assert from "node:assert/strict";
import { createGraph } from "./graph";
import { validateCompletion, parsePlans } from "./completion";
import { deriveRequirementLedger } from "./requirement_ledger";
import { emptyEvidence } from "./event_evidence";
import { SupervisorResult } from "./process_supervisor";
import { cliDiagnostic, emptyCliDiagnostics } from "./cli_diagnostics";
const result = (text: string): SupervisorResult => ({
  pid: 1,
  outcome: "succeeded",
  failureKind: null,
  failureMessage: null,
  exitCode: 0,
  output: text,
  assistantText: text,
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
test("assistant completion and requirement gates reject weak PASS or APPROVED", () => {
  const g = createGraph(),
    requirements = deriveRequirementLedger("build acceptance").items;
  assert.equal(
    validateCompletion(
      g.nodes[1]!,
      result("echo [PHASE_DONE]"),
      "goal",
      requirements,
    ).valid,
    false,
  );
  assert.equal(
    validateCompletion(
      g.nodes[2]!,
      result("VERDICT: PASS\n[PHASE_DONE]"),
      "goal",
      requirements,
    ).verdict,
    "FAIL",
  );
  assert.equal(
    validateCompletion(
      g.nodes[4]!,
      result("APPROVED\n[PHASE_DONE]"),
      "goal",
      requirements,
    ).verdict,
    "REJECTED",
  );
  const changed = result("APPROVED\n[PHASE_DONE]");
  changed.evidence.fileMutation = true;
  assert.equal(
    validateCompletion(g.nodes[4]!, changed, "goal", requirements).valid,
    false,
  );
});
test("planning options are complete, sequential and scoped to fixed REQ IDs", () => {
  const plans =
    "## OPTION 1: A\nREQ-001 first strategy\n## OPTION 2: B\nREQ-001 second strategy\n## OPTION 3: C\nREQ-001 third strategy\n[PHASE_DONE]";
  assert.equal(parsePlans(plans).length, 3);
  assert.equal(
    validateCompletion(
      createGraph().nodes[0]!,
      result(plans),
      "goal",
      deriveRequirementLedger("goal").items,
    ).valid,
    true,
  );
});
test("required web research relies on observed completion, independent of native tool settings", () => {
  const g = createGraph(),
    r = result(
      "SOURCE: https://example.com/source\nVERIFIED_FACT: observed\nAPPROVED\n[PHASE_DONE]",
    );
  assert.equal(
    validateCompletion(g.nodes[4]!, r, "인터넷 검색", []).valid,
    false,
  );
  r.evidence.completedSearches = 1;
  assert.equal(
    validateCompletion(g.nodes[4]!, r, "인터넷 검색", []).valid,
    true,
  );
  const blocked = result("RESEARCH_BLOCKED\n[PHASE_DONE]");
  assert.equal(
    validateCompletion(g.nodes[0]!, blocked, "인터넷 검색", []).researchBlocked,
    true,
  );
});

test("a terminal provider failure rejects otherwise complete output even with CLI exit zero", () => {
  const r = result("APPROVED\n[PHASE_DONE]");
  r.diagnostics.terminalError = cliDiagnostic({
    statusCode: 401,
    message: "Unauthorized",
  });
  const completion = validateCompletion(createGraph().nodes[4]!, r, "goal", []);
  assert.equal(completion.valid, false);
  assert.equal(completion.failureKind, "auth");
});

test("missing markers and read-only mutations expose typed failure causes", () => {
  const node = createGraph().nodes[3]!;
  assert.equal(
    validateCompletion(node, result("unfinished"), "goal", []).failureKind,
    "incomplete_response",
  );
  const changed = result("unfinished");
  changed.evidence.fileMutation = true;
  assert.equal(
    validateCompletion(node, changed, "goal", []).failureKind,
    "role_violation",
  );
});
test("missing or malformed positive evidence uses bounded report recovery while real negative evidence stays a verdict", () => {
  const requirements = deriveRequirementLedger("one\ntwo").items;
  const block = (id: string, status = "SATISFIED") => `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${id}\nSTATUS: ${status}\nEVIDENCE: observed check\n[/REQUIREMENT_EVIDENCE]`;
  for (const type of ["test", "review", "approval"] as const) {
    const node = createGraph().nodes.find(n => n.type === type)!;
    const verdict = type === "test" ? "VERDICT: PASS" : "APPROVED";
    const malformed = validateCompletion(node, result(`${block("REQ-001")}\n${block("REQ_ID: REQ-002")}\n${verdict}\n[PHASE_DONE]`), "goal", requirements);
    assert.equal(malformed.valid, false);
    assert.equal(malformed.failureKind, "incomplete_response");
    assert.match(malformed.reason!, /REQ-002/);
    const repaired = validateCompletion(node, result(`${block("REQ-001")}\n${block("REQ-002")}\n${verdict}\n[PHASE_DONE]`), "goal", requirements);
    assert.equal(repaired.valid, true);
    assert.equal(repaired.verdict, type === "test" ? "PASS" : "APPROVED");
    const negative = validateCompletion(node, result(`${block("REQ-001")}\n${block("REQ-002", "FAILED")}\n${verdict}\n[PHASE_DONE]`), "goal", requirements);
    assert.equal(negative.valid, true);
    assert.equal(negative.verdict, type === "test" ? "FAIL" : "REJECTED");
    const mixed = validateCompletion(node, result(`${block("REQ-001", "FAILED")}\n${verdict}\n[PHASE_DONE]`), "goal", requirements);
    assert.equal(mixed.valid, true);
    assert.equal(mixed.verdict, type === "test" ? "FAIL" : "REJECTED");
  }
});
