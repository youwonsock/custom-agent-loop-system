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
  const block = (id: string, status = "SATISFIED") => `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${id}\nSTATUS: ${status}\nEVIDENCE: observed check\nCHECK_COMMAND: npm test\n[/REQUIREMENT_EVIDENCE]`;
  for (const type of ["test", "review", "approval"] as const) {
    const node = createGraph().nodes.find(n => n.type === type)!;
    const verdict = type === "test" ? "VERDICT: PASS" : "APPROVED";
    const malformed = validateCompletion(node, result(`${block("REQ-001")}\n${block("REQ_ID: REQ-002")}\n${verdict}\n[PHASE_DONE]`), "goal", requirements);
    assert.equal(malformed.valid, false);
    assert.equal(malformed.failureKind, "incomplete_response");
    assert.match(malformed.reason!, /REQ-002/);
    const repairedResult = result(`${block("REQ-001")}\n${block("REQ-002")}\n${verdict}\n[PHASE_DONE]`);
    const receipts = [{ id: "check", command: "npm test", exitCode: 0, environmentError: null }];
    const repaired = validateCompletion(node, repairedResult, "goal", requirements, receipts, receipts);
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

test("prose PASS cannot replace native command execution and approval needs current test proof", () => {
  const graph = createGraph(), requirements = deriveRequirementLedger("pointer swipes").items;
  const report = "[REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001\nSTATUS: SATISFIED\nEVIDENCE: pointer swipes are implemented\nCHECK_COMMAND: npm test\n[/REQUIREMENT_EVIDENCE]\n";
  const r = result(report + "VERDICT: PASS\n[PHASE_DONE]");
  assert.equal(validateCompletion(graph.nodes[2]!, r, "goal", requirements).valid, false);
  r.evidence.commands = [{ id: "real", command: "npm test", exitCode: 1, environmentError: null }];
  assert.equal(validateCompletion(graph.nodes[2]!, r, "goal", requirements).verdict, "FAIL");
  r.evidence.commands[0]!.exitCode = 0;
  assert.equal(validateCompletion(graph.nodes[2]!, r, "goal", requirements).verdict, "PASS");
  const approval = result(report + "APPROVED\n[PHASE_DONE]");
  assert.equal(validateCompletion(graph.nodes[4]!, approval, "goal", requirements).verdict, "REJECTED");
  assert.equal(validateCompletion(graph.nodes[4]!, approval, "goal", requirements, [], r.evidence.commands).verdict, "APPROVED");
});

test("observed environment failure holds even a claimed PASS without retrying report formatting", () => {
  const r = result("VERDICT: PASS");
  r.evidence.commands = [{ id: "native", command: "npm test", exitCode: 1, environmentError: "listen EPERM" }];
  const completion = validateCompletion(createGraph().nodes[2]!, r, "goal", []);
  assert.equal(completion.verdict, "BLOCKED");
  assert.match(completion.environmentBlocked!, /listen EPERM/);
  assert.equal(completion.valid, true);
});

test("real CLI markdown reports and redirected checks retain verdicts without false format recovery", () => {
  const node = createGraph().nodes[2]!, requirements = deriveRequirementLedger("acceptance").items;
  const text = "[REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001\nSTATUS: SATISFIED\nEVIDENCE: observed test\nCHECK_COMMAND: `npm test`\n[/REQUIREMENT_EVIDENCE]\n**VERDICT: PASS**\n[PHASE_DONE]";
  const r = result(text);
  r.evidence.commands = [{ id: "real", command: "npm test > verification/test-output.txt 2>&1", exitCode: 0, environmentError: null }];
  assert.equal(validateCompletion(node, r, "goal", requirements).verdict, "PASS");
  const blocked = result(text.replace("STATUS: SATISFIED", "STATUS: BLOCKED").replace("VERDICT: PASS", "VERDICT: FAIL"));
  const held = validateCompletion(node, blocked, "goal", requirements);
  assert.equal(held.verdict, "BLOCKED");
  assert.match(held.environmentBlocked!, /테스트 역할이/);
});

for (const type of ["review", "approval"] as const) test(`${type} cannot approve observed failed or blocked verification`, () => {
  const node = createGraph().nodes.find(n => n.type === type)!;
  const requirements = deriveRequirementLedger("acceptance").items;
  const output = "[REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001\nSTATUS: SATISFIED\nEVIDENCE: claimed\n[/REQUIREMENT_EVIDENCE]\nAPPROVED\n[PHASE_DONE]";
  const prior = [{ id: "passed", command: "npm test", exitCode: 0, environmentError: null }];
  for (const exitCode of [1, null]) {
    const completion = validateCompletion(node, result(output), "goal", requirements, [{ ...prior[0]!, exitCode }], prior);
    assert.equal(completion.verdict, "REJECTED");
  }
  const blocked = validateCompletion(node, result(output), "goal", requirements, [{ ...prior[0]!, exitCode: 1, environmentError: "listen EPERM" }], prior);
  assert.equal(blocked.verdict, "BLOCKED");
  assert.ok(blocked.environmentBlocked);
});


test("planning recovery identifies unresolved IDs per option without accepting numeric prefixes", () => {
  const requirements = deriveRequirementLedger("one\ntwo").items;
  const node = createGraph().nodes[0]!;
  node.planning = { requiresApproval: false, optionsCount: 1 };
  for (const text of ["REQ-001/003", "REQ-001 REQ-0020"]) {
    const c = validateCompletion(node, result(`## OPTION 1: Plan\n${text}\n[PHASE_DONE]`), "goal", requirements);
    assert.equal(c.valid, false);
    assert.match(c.reason!, /OPTION 1: REQ-002/);
    assert.match(c.reason!, /REQ-006, REQ-007/);
  }
  assert.equal(validateCompletion(node, result("## OPTION 1: Plan\nREQ-001 first check\nREQ-002 second check\n[PHASE_DONE]"), "goal", requirements).valid, true);
});


test("plan-only reference normalization accepts known lists and ranges without rewriting output", () => {
 const requirements=deriveRequirementLedger("one\ntwo\nthree").items,node=createGraph().nodes[0]!;
 node.planning={requiresApproval:false,optionsCount:1};
 for(const refs of ["REQ-001/002/003","REQ-001,002,003","REQ-001..003","REQ-001–REQ-003"]){
  const text=`## OPTION 1: Strategy\n${refs}: implement and verify the original goal\n[PHASE_DONE]`;
  const c=validateCompletion(node,result(text),"goal",requirements);
  assert.equal(c.valid,true,refs);assert.equal(c.output,text);
 }
 for(const refs of ["REQ-001..999","REQ-003..001","REQ-001/003","REQ-001 REQ-0020"])
  assert.equal(validateCompletion(node,result(`## OPTION 1: Strategy\n${refs}\n[PHASE_DONE]`),"goal",requirements).valid,false,refs);
});
test("plan abbreviation support never expands test evidence or permits success without fixed-ID blocks", () => {
 const requirements=deriveRequirementLedger("one\ntwo").items;
 const r=result("[REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001/002\nSTATUS: SATISFIED\nEVIDENCE: observed\nCHECK_COMMAND: npm test\n[/REQUIREMENT_EVIDENCE]\nVERDICT: PASS\n[PHASE_DONE]");
 r.evidence.commands=[{id:"test",command:"npm test",exitCode:0,environmentError:null}];
 const c=validateCompletion(createGraph().nodes[2]!,r,"goal",requirements);
 assert.equal(c.valid,false);assert.notEqual(c.verdict,"PASS");
});
