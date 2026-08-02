import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  boundedAttemptTimeoutMs,
  approvalDecisionSignature,
  automaticRecoveryDelayMs,
  buildPrompt,
  classifyExhaustedFailureDisposition,
  classifyAgentFailure,
  cleanupRecoveredChildProcesses,
  discoverCodexModels,
  deriveRequirementLedger,
  evaluateRequirementCoverage,
  advanceConvergence,
  extractVerdictFromOutput,
  filterDiscoveredModelsForProvider,
  findAbsolutePathsOutsideAllowedRoots,
  findAbsolutePathsOutsideTarget,
  goalRequiresExternalResearch,
  goalRequiresNamedReferenceVerification,
  isResearchBlockedResponse,
  isReadOnlyModelRole,
  materializePlanChoiceMarkdown,
  normalizeLoopState,
  normalizeAdditionalAllowedPaths,
  parseApprovalVerdict,
  parseReferenceIdentity,
  parseTesterVerdict,
  probeProviderBinary,
  shouldStartManualRecoveryCycle,
  summarizeAttemptEvents,
  hasObservedFileMutation,
  validateAgentCompletion,
} from "./loop_orchestrator";

test("requirement ledger stays stable and approval evidence must cover every item", () => {
  const ledger = deriveRequirementLedger(
    "Create the game in the requested folder.\nResearch Smash Fast on the web first.\nKeep one stage and place physics controls on the right."
  );
  assert.deepEqual(ledger.items.map((item) => item.id), ["REQ-001", "REQ-002", "REQ-003"]);
  assert.equal(ledger.items[1].category, "research");
  const partial = [
    "[REQUIREMENT_EVIDENCE]",
    "REQ_ID: REQ-001",
    "STATUS: SATISFIED",
    "EVIDENCE: index.html exists",
    "[/REQUIREMENT_EVIDENCE]",
  ].join("\n");
  assert.deepEqual(evaluateRequirementCoverage(partial, ledger.items).missing, ["REQ-002", "REQ-003"]);
  const complete = ledger.items.map((item) => [
    "[REQUIREMENT_EVIDENCE]",
    `REQ_ID: ${item.id}`,
    "STATUS: SATISFIED",
    `EVIDENCE: observed ${item.id}`,
    "[/REQUIREMENT_EVIDENCE]",
  ].join("\n")).join("\n");
  assert.equal(evaluateRequirementCoverage(complete, ledger.items).allSatisfied, true);
});

test("Korean connective clauses become separate stable requirements", () => {
  const ledger = deriveRequirementLedger(
    "Downloads \ud3f4\ub354 \uc548\uc5d0 Test \ud3f4\ub354\ub97c \ub9cc\ub4e4\uace0 web \uac8c\uc784\uc744 \uc81c\uc791\ud574 \uc774\ub54c \uc778\ud130\ub137\uc744 \uac80\uc0c9\ud574 \ucc38\uace0\ud574 \ucd94\uac00\ub85c \ubb3c\ub9ac \uc124\uc815 UI\ub97c \uc6b0\uce21\uc5d0 \ubc30\uce58\ud574"
  );
  assert.deepEqual(ledger.items.map((item) => item.id), ["REQ-001", "REQ-002", "REQ-003"]);
  assert.equal(ledger.items[1].category, "research");
  assert.match(ledger.items[2].text, /^\ucd94\uac00\ub85c/);
});

test("convergence marks a second non-improving completed cycle as stagnant", () => {
  const ledger = deriveRequirementLedger("Implement A.\nImplement B.");
  ledger.evidence.push({
    requirementId: "REQ-001",
    stageId: "VERIFICATION",
    role: "qa_lead",
    status: "PARTIAL",
    summary: "A remains partial",
    attemptId: "a1",
    recordedAt: new Date().toISOString(),
  });
  const first = advanceConvergence({ stagnantCycles: 0, history: [] }, ledger, 1);
  assert.equal(first.stagnantCycles, 0);
  const second = advanceConvergence(first, ledger, 2);
  assert.equal(second.stagnantCycles, 1);
  ledger.evidence.push({
    requirementId: "REQ-001",
    stageId: "VERIFICATION",
    role: "qa_lead",
    status: "SATISFIED",
    summary: "A verified",
    attemptId: "a2",
    recordedAt: new Date().toISOString(),
  });
  const improved = advanceConvergence(second, ledger, 3);
  assert.equal(improved.stagnantCycles, 0);
});

test("Codex app-server discovery initializes and paginates model/list", async () => {
  const fakeServer = [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "rl.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
    "  if (message.method === 'model/list' && !message.params.cursor) send({ id: message.id, result: { data: [{ model: 'gpt-first', displayName: 'GPT First', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }, { id: 'gpt-id-only' }], nextCursor: 'page-2' } });",
    "  if (message.method === 'model/list' && message.params.cursor === 'page-2') send({ id: message.id, result: { data: [{ model: 'gpt-first' }, { model: 'gpt-second' }], nextCursor: null } });",
    "});",
  ].join("\n");
  const result = await discoverCodexModels(process.execPath, ["-e", fakeServer], 5_000);
  assert.equal(result.available, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.models, ["gpt-first", "gpt-id-only", "gpt-second"]);
  assert.equal(result.modelLabels?.["gpt-first"], "GPT First");
  assert.deepEqual(result.modelVariants?.["gpt-first"], ["low", "high"]);
});

test("Codex app-server model errors remain retryable through configured fallbacks", async () => {
  const fakeServer = [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "rl.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') send({ id: message.id, result: {} });",
    "  if (message.method === 'model/list') send({ id: message.id, error: { code: 401, message: 'login required' } });",
    "});",
  ].join("\n");
  const result = await discoverCodexModels(process.execPath, ["-e", fakeServer], 5_000);
  assert.equal(result.available, true);
  assert.deepEqual(result.models, []);
  assert.match(result.error ?? "", /model\/list failed.*login required/i);
});

test("provider binary probe distinguishes installed executables from missing providers", async () => {
  assert.equal((await probeProviderBinary(process.execPath)).available, true);
  const missing = await probeProviderBinary(`agent-loop-missing-provider-${Date.now()}`);
  assert.equal(missing.available, false);
  assert.match(missing.error ?? "", /unavailable/i);
});

test("provider catalogs retain only models owned by the selected agent CLI", () => {
  const mixed = [
    "kilo/openai/gpt-5.6-sol",
    "kilo/anthropic/claude-sonnet-5",
    "opencode/gpt-5.6-sol",
    "opencode-go/kimi-k3",
    "openai-compatible/gemma4",
  ];
  assert.deepEqual(filterDiscoveredModelsForProvider("kilo", "kilo", mixed), [
    "kilo/openai/gpt-5.6-sol",
    "kilo/anthropic/claude-sonnet-5",
  ]);
  assert.deepEqual(filterDiscoveredModelsForProvider("opencode", "opencode", mixed), [
    "opencode/gpt-5.6-sol",
    "opencode-go/kimi-k3",
  ]);
});

function result(assistantText: string, output = assistantText, exitCode = 0): any {
  return {
    pid: 1,
    exitCode,
    output,
    events: [],
    timedOut: false,
    cancelled: false,
    autoInjected: [],
    assistantText,
  };
}

test("completion token must be in assistant text on its own line", () => {
  assert.equal(validateAgentCompletion("implementation", result("done\n[PHASE_DONE]")).valid, true);
  assert.equal(validateAgentCompletion("implementation", result("done", "prompt [PHASE_DONE]")).valid, false);
  assert.equal(validateAgentCompletion("implementation", result("done [PHASE_DONE]")).valid, false);
});

test("read-only roles reject observed file mutation events", () => {
  const codexWrite = result("done\n[PHASE_DONE]");
  codexWrite.events = [{ type: "item.completed", item: { type: "file_change", changes: [] } }];
  assert.equal(hasObservedFileMutation(codexWrite), true);
  const validation = validateAgentCompletion("approval", codexWrite, 3, { forbidFileMutation: true });
  assert.equal(validation.valid, false);
  const failure = classifyAgentFailure(codexWrite, validation.reason);
  assert.equal(failure.kind, "role_violation");
  assert.equal(failure.retryable, false);

  const toolWrite = result("done\n[PHASE_DONE]");
  toolWrite.events = [{ type: "tool_use", name: "mcp__filesystem__write_file" }];
  assert.equal(hasObservedFileMutation(toolWrite), true);
  assert.equal(isReadOnlyModelRole("planner"), true);
  assert.equal(isReadOnlyModelRole("tester"), false);
});

test("supervisor timeout classifications are not overwritten by completion validation", () => {
  const timedOut = result("", "", -1);
  timedOut.failureKind = "transport_timeout";
  timedOut.failureMessage = "No PTY transport output for 120000ms";
  const failure = classifyAgentFailure(timedOut, timedOut.failureMessage);
  assert.equal(failure.kind, "transport_timeout");
  assert.equal(failure.retryable, true);

  const productivePhaseTimeout = result("", "debug coordinates 401 and authentication helper", 1);
  productivePhaseTimeout.failureKind = "phase_timeout";
  productivePhaseTimeout.failureMessage = "Role recovery budget deadline reached";
  const phaseFailure = classifyAgentFailure(
    productivePhaseTimeout,
    productivePhaseTimeout.failureMessage
  );
  assert.equal(phaseFailure.kind, "phase_timeout");
  assert.equal(phaseFailure.retryable, true);

  const completedWithoutSentinel = classifyAgentFailure(
    result("implementation text"),
    "Assistant response did not contain [PHASE_DONE] on its own line."
  );
  assert.equal(completedWithoutSentinel.kind, "incomplete_response");

  const cleanOutputWithStatusNumber = classifyAgentFailure(
    result("implementation text", "UI handles HTTP 401 and 429 states"),
    "Assistant response did not contain [PHASE_DONE] on its own line."
  );
  assert.equal(cleanOutputWithStatusNumber.kind, "incomplete_response");
});

test("CLI usage errors fail fast instead of consuming transport recovery attempts", () => {
  const usageError = result(
    "",
    "error: unexpected argument '--search' found\n\nUsage: codex exec [OPTIONS] [PROMPT]",
    2
  );
  usageError.failureKind = "process_exit";
  usageError.failureMessage = "Process exited with code 2";
  const failure = classifyAgentFailure(
    usageError,
    "Planner response did not provide exactly three valid plan options."
  );
  assert.equal(failure.kind, "spawn_error");
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /unexpected argument '--search'/);
  assert.equal(classifyExhaustedFailureDisposition(failure, []), "wait_for_user");
});

test("attempt evidence retains terminal step reason and peak token usage", () => {
  const attempt = result("");
  attempt.events = [
    { type: "step_finish", part: { reason: "tool-calls", tokens: { total: 100327 } } },
    { type: "step_finish", part: { reason: "unknown", tokens: { input: 0, output: 0 } } },
  ];
  assert.deepEqual(summarizeAttemptEvents(attempt), {
    lastEventType: "step_finish",
    lastToolName: null,
    lastToolStatus: null,
    lastToolCommand: null,
    lastStepFinishReason: "unknown",
    lastStepFinishTotalTokens: null,
    maxObservedTotalTokens: 100327,
  });
});

test("implementation preflight detects absolute paths outside the target project", () => {
  assert.deepEqual(
    findAbsolutePathsOutsideTarget(
      "Write `C:\\Users\\a\\Downloads\\Test\\index.html` and update `C:\\GitRepo\\Haven\\src\\game.ts`.",
      "C:\\GitRepo\\Haven"
    ),
    ["C:\\Users\\a\\Downloads\\Test\\index.html"]
  );
  assert.deepEqual(
    findAbsolutePathsOutsideTarget(
      "Only edit `C:\\GitRepo\\Haven\\src\\game.ts`; it may be opened via file:// or https://localhost.",
      "C:\\GitRepo\\Haven"
    ),
    []
  );
});

test("additional access roots are canonicalized and honored by implementation preflight", () => {
  const target = "C:\\GitRepo\\Haven";
  const additional = normalizeAdditionalAllowedPaths(
    [
      "C:\\Users\\a\\Downloads\\Test\\",
      "c:\\users\\a\\downloads\\test",
      "C:\\GitRepo\\Haven\\generated",
    ],
    target
  );
  assert.deepEqual(additional, ["C:\\Users\\a\\Downloads\\Test"]);
  assert.deepEqual(
    findAbsolutePathsOutsideAllowedRoots(
      "Write `C:\\Users\\a\\Downloads\\Test\\index.html` and `D:\\private\\secret.txt`.",
      target,
      additional
    ),
    ["D:\\private\\secret.txt"]
  );
});

test("planner, tester, and reviewer enforce their contracts", () => {
  const plans =
    "=== PLAN OPTIONS ===\n## OPTION 1: A\nA\n## OPTION 2: B\nB\n## OPTION 3: C\nC\n[PHASE_DONE]";
  assert.equal(validateAgentCompletion("planning", result(plans), 3).valid, true);
  assert.equal(validateAgentCompletion("planning", result(plans), 4).valid, false);
  assert.equal(validateAgentCompletion("test", result("VERDICT: PASS\n[PHASE_DONE]")).valid, true);
  assert.equal(
    validateAgentCompletion(
      "test",
      result("VERDICT: FAIL — Restitution and friction controls are not wired.\n[PHASE_DONE]")
    ).valid,
    true
  );
  assert.equal(
    validateAgentCompletion("test", result("VERDICT: PASS: all checks passed\n[PHASE_DONE]")).valid,
    true
  );
  assert.equal(
    validateAgentCompletion("test", result("VERDICT: FAILURE\n[PHASE_DONE]")).valid,
    false
  );
  assert.equal(validateAgentCompletion("test", result("PASS\n[PHASE_DONE]")).valid, false);
  assert.equal(validateAgentCompletion("review", result("APPROVED\n[PHASE_DONE]")).valid, true);
  assert.equal(
    validateAgentCompletion("review", result("REJECTED — two requirements remain.\n[PHASE_DONE]")).valid,
    true
  );
  assert.equal(validateAgentCompletion("approval", result("APPROVEDNESS\n[PHASE_DONE]")).valid, false);
});

test("original goals that explicitly require internet research are detected", () => {
  assert.equal(
    goalRequiresExternalResearch("인터넷을 검색해서 Smash Fast를 찾은 후 제작해"),
    true
  );
  assert.equal(goalRequiresExternalResearch("Browse the web and research the named app first"), true);
  assert.equal(goalRequiresExternalResearch("검색 UI를 구현하고 로컬 파일을 수정해"), false);
  assert.equal(isResearchBlockedResponse("evidence\nRESEARCH_BLOCKED\n[PHASE_DONE]"), true);
  assert.equal(isResearchBlockedResponse("The research was blocked by a site."), false);
  assert.equal(
    goalRequiresNamedReferenceVerification("인터넷을 검색해서 Smash Fast라는 게임과 같은 게임을 제작해"),
    true
  );
  assert.equal(
    goalRequiresNamedReferenceVerification("인터넷에서 현재 Node.js 지원 버전을 검색해"),
    false
  );
});

test("research-required completion needs an observed search and cited evidence", () => {
  const plans = [
    "[RESEARCH_EVIDENCE]",
    "SOURCE: https://example.com/smash-fast-gameplay",
    "VERIFIED_FACT: The source demonstrates the core interaction.",
    "LIMITATION: Secondary modes were not visible.",
    "CONFIDENCE: HIGH",
    "[/RESEARCH_EVIDENCE]",
    "=== PLAN OPTIONS ===",
    "## OPTION 1: A",
    "A",
    "## OPTION 2: B",
    "B",
    "## OPTION 3: C",
    "C",
    "[PHASE_DONE]",
  ].join("\n");
  const researched = result(plans);
  researched.events = [
    { type: "item.completed", item: { type: "web_search", query: "Smash Fast gameplay" } },
  ];
  assert.equal(
    validateAgentCompletion("planning", researched, 3, { externalResearchRequired: true }).valid,
    true
  );

  const noSearch = result(plans);
  assert.match(
    validateAgentCompletion("planning", noSearch, 3, { externalResearchRequired: true }).reason ?? "",
    /did not complete a web search/i
  );

  const noCitation = result(plans.replace("SOURCE: https://example.com/smash-fast-gameplay", "SOURCE: unknown"));
  noCitation.events = researched.events;
  assert.match(
    validateAgentCompletion("planning", noCitation, 3, { externalResearchRequired: true }).reason ?? "",
    /source url/i
  );
});

test("low-confidence reference research pauses cleanly instead of inventing plans", () => {
  const blocked = result([
    "[RESEARCH_EVIDENCE]",
    "SOURCE: https://example.com/store-listing",
    "LIMITATION: The listing does not establish the core gameplay.",
    "CONFIDENCE: LOW",
    "[/RESEARCH_EVIDENCE]",
    "RESEARCH_BLOCKED",
    "[PHASE_DONE]",
  ].join("\n"));
  blocked.events = [
    { type: "item.completed", item: { type: "web_search", query: "named game gameplay" } },
  ];
  assert.equal(
    validateAgentCompletion("planning", blocked, 3, { externalResearchRequired: true }).valid,
    true
  );

  const guessed = result((blocked.assistantText as string).replace("RESEARCH_BLOCKED\n", ""));
  guessed.events = blocked.events;
  assert.match(
    validateAgentCompletion("planning", guessed, 3, { externalResearchRequired: true }).reason ?? "",
    /low-confidence research/i
  );
});

function exactReferenceResearchText(overrides: {
  match?: string;
  confidence?: string;
  packageId?: string;
  candidateCount?: number;
  secondReferenceId?: string;
  secondSource?: string;
  decision?: string;
  extra?: string;
} = {}): string {
  const packageId = overrides.packageId ?? "com.tosbygames.smashfast";
  return [
    "[REFERENCE_IDENTITY]",
    "TITLE: smash fast!",
    "CREATOR: Tosby Games",
    `PACKAGE_ID: ${packageId}`,
    "CANONICAL_URL: https://play.google.com/store/apps/details?id=com.tosbygames.smashfast",
    `CANDIDATE_COUNT: ${overrides.candidateCount ?? 1}`,
    `IDENTITY_MATCH: ${overrides.match ?? "EXACT"}`,
    `CONFIDENCE: ${overrides.confidence ?? "HIGH"}`,
    "[/REFERENCE_IDENTITY]",
    "[RESEARCH_EVIDENCE]",
    "EVIDENCE_TYPE: IDENTITY",
    "SOURCE: https://play.google.com/store/apps/details?id=com.tosbygames.smashfast",
    `REFERENCE_ID: ${packageId}`,
    "VERIFIED_FACT: The store identifies the exact title, creator, and package.",
    "LIMITATION: Physics constants are not listed.",
    "[/RESEARCH_EVIDENCE]",
    "[RESEARCH_EVIDENCE]",
    "EVIDENCE_TYPE: GAMEPLAY",
    `SOURCE: ${overrides.secondSource ?? "https://www.youtube.com/watch?v=verified-gameplay"}`,
    `REFERENCE_ID: ${overrides.secondReferenceId ?? packageId}`,
    "VERIFIED_FACT: Gameplay footage shows the primary interaction loop.",
    "LIMITATION: Only the recorded mode was observable.",
    "[/RESEARCH_EVIDENCE]",
    overrides.extra ?? "",
    overrides.decision ?? "=== PLAN OPTIONS ===\n## OPTION 1: A\nA\n## OPTION 2: B\nB\n## OPTION 3: C\nC",
    "[PHASE_DONE]",
  ].filter(Boolean).join("\n");
}

function withTwoWebSearchEvents(attempt: any): any {
  attempt.events = [
    { type: "item.completed", item: { type: "web_search", query: "exact app identity" } },
    { type: "item.completed", item: { type: "web_search", query: "exact app gameplay" } },
  ];
  return attempt;
}

test("named-reference research requires an exact high-confidence identity and two-source evidence", () => {
  const valid = withTwoWebSearchEvents(result(exactReferenceResearchText()));
  const requirements = { externalResearchRequired: true, namedReferenceRequired: true };
  assert.equal(validateAgentCompletion("planning", valid, 3, requirements).valid, true);
  assert.deepEqual(parseReferenceIdentity(valid.assistantText as string), {
    title: "smash fast!",
    creator: "Tosby Games",
    packageId: "com.tosbygames.smashfast",
    canonicalUrl: "https://play.google.com/store/apps/details?id=com.tosbygames.smashfast",
    candidateCount: 1,
    identityMatch: "EXACT",
    confidence: "HIGH",
  });

  const medium = withTwoWebSearchEvents(result(exactReferenceResearchText({ confidence: "MEDIUM" })));
  assert.match(
    validateAgentCompletion("planning", medium, 3, requirements).reason ?? "",
    /exact.*high/i
  );

  const similar = withTwoWebSearchEvents(result(exactReferenceResearchText({ match: "SIMILAR" })));
  assert.match(
    validateAgentCompletion("planning", similar, 3, requirements).reason ?? "",
    /exact.*high/i
  );

  const ambiguousCandidates = withTwoWebSearchEvents(result(exactReferenceResearchText({ candidateCount: 2 })));
  assert.match(
    validateAgentCompletion("planning", ambiguousCandidates, 3, requirements).reason ?? "",
    /multiple or zero candidate products/i
  );

  const mismatchedEvidence = withTwoWebSearchEvents(result(exactReferenceResearchText({
    secondReferenceId: "com.other.game",
  })));
  assert.match(
    validateAgentCompletion("planning", mismatchedEvidence, 3, requirements).reason ?? "",
    /same.*reference_id|locked.*reference_id/i
  );

  const sameDomain = withTwoWebSearchEvents(result(exactReferenceResearchText({
    secondSource: "https://play.google.com/store/apps/details?id=another",
  })));
  assert.match(
    validateAgentCompletion("planning", sameDomain, 3, requirements).reason ?? "",
    /two distinct source domains/i
  );
});

test("QA and master cannot change identity or approve their own exact-match contradiction", () => {
  const expected = {
    title: "smash fast!",
    creator: "Tosby Games",
    packageId: "com.tosbygames.smashfast",
    canonicalUrl: "https://play.google.com/store/apps/details?id=com.tosbygames.smashfast",
    candidateCount: 1,
    identityMatch: "EXACT" as const,
    confidence: "HIGH" as const,
  };
  const changed = withTwoWebSearchEvents(result(exactReferenceResearchText({
    packageId: "com.kelvinjroberts.smash",
    decision: "APPROVED",
  })));
  assert.match(
    validateAgentCompletion("approval", changed, 3, {
      externalResearchRequired: true,
      namedReferenceRequired: true,
      expectedReferenceIdentity: expected,
    }).reason ?? "",
    /identity changed between stages/i
  );

  const contradictory = withTwoWebSearchEvents(result(exactReferenceResearchText({
    decision: "APPROVED",
    extra: "LIMITATION: This is not the exact same game; it is only a similar style match.",
  })));
  assert.match(
    validateAgentCompletion("approval", contradictory, 3, {
      externalResearchRequired: true,
      namedReferenceRequired: true,
      expectedReferenceIdentity: expected,
    }).reason ?? "",
    /approved contradicts/i
  );
});

test("handoff prompt keeps the original goal authoritative over the approved plan", () => {
  const prompt = buildPrompt(
    "master",
    {
      sessionId: "session-test",
      originalGoal: "Create a game matching the researched Smash Fast mechanics.",
      approvedPlan: "Create an unrelated falling-circle tap game.",
      lockedReferenceIdentity: {
        title: "smash fast!",
        creator: "Tosby Games",
        packageId: "com.tosbygames.smashfast",
        canonicalUrl: "https://play.google.com/store/apps/details?id=com.tosbygames.smashfast",
        candidateCount: 1,
        identityMatch: "EXACT",
        confidence: "HIGH",
      },
      targetProjectPath: "C:\\work",
      additionalAllowedPaths: [],
      accessMode: "full_access",
      progressNotes: "",
      failureDigest: null,
      phase: "MASTER_APPROVAL",
      loopCount: 1,
      toolAccess: {
        webSearch: { enabled: true, mode: "live" },
        mcpServers: [],
      },
    },
    undefined,
    undefined,
    {
      id: "approval",
      label: "Approval",
      description: "Final approval",
      executor: "approval",
      completionContract: "approval",
    }
  );
  assert.match(prompt, /ORIGINAL USER GOAL \(AUTHORITATIVE\)/);
  assert.match(prompt, /APPROVED IMPLEMENTATION PLAN \(SUBORDINATE STRATEGY\)/);
  assert.ok(prompt.indexOf("matching the researched Smash Fast mechanics") < prompt.indexOf("unrelated falling-circle"));
  assert.match(prompt, /original user goal is the acceptance contract and is never replaced/i);
  assert.match(prompt, /LOCKED REFERENCE IDENTITY \(MUST NOT CHANGE\)/);
  assert.match(prompt, /com\.tosbygames\.smashfast/);
});

test("tester verdict parser uses the last independent verdict line and permits a rationale", () => {
  assert.equal(
    parseTesterVerdict(
      "VERDICT: PASS\nInterim result changed after focused tests.\nVERDICT: FAIL — two live controls are disconnected."
    ),
    "FAIL"
  );
  assert.equal(parseTesterVerdict("The tester wrote VERDICT: PASS in prose."), null);
  assert.equal(parseTesterVerdict("VERDICT: PASSING"), null);
});

test("approval parser uses the last independent decision line and permits a rationale", () => {
  assert.equal(
    parseApprovalVerdict("APPROVED: provisional\nEvidence changed.\nREJECTED — acceptance test failed."),
    "REJECTED"
  );
  assert.equal(parseApprovalVerdict("The reviewer said APPROVED in prose."), null);
  assert.equal(parseApprovalVerdict("REJECTEDNESS"), null);
});

test("master verdict extraction uses the complete assistant transcript for Codex multi-message output", () => {
  const attempt = result(
    [
      "I will inspect the remaining files.",
      "APPROVED: all acceptance checks pass.",
      "The implementation satisfies the goal.",
      "[PHASE_DONE]",
    ].join("\n"),
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-unique" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "APPROVED: all acceptance checks pass.\n[PHASE_DONE]" },
      }),
    ].join("\n")
  );
  attempt.events = [
    { type: "item.completed", item: { type: "agent_message", text: "I will inspect the remaining files." } },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "APPROVED: all acceptance checks pass.\n[PHASE_DONE]" },
    },
    { type: "turn.completed" },
  ];

  const verdictText = extractVerdictFromOutput(attempt);
  assert.equal(parseApprovalVerdict(verdictText), "APPROVED");
  assert.doesNotMatch(verdictText, /thread-unique/);
});

test("master rejection signatures ignore transport IDs and preserve the decision rationale", () => {
  assert.equal(
    approvalDecisionSignature("REJECTED: acceptance test failed at C:\\repo\\game.js:42"),
    approvalDecisionSignature("REJECTED: acceptance test failed at D:\\other\\game.js:99")
  );
  assert.equal(
    approvalDecisionSignature('{"type":"thread.started","thread_id":"unique"}'),
    "master_protocol:missing_approval_verdict"
  );
});

test("planning materializes a full overview and one markdown document per option", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-plan-docs-"));
  try {
    const materialized = await materializePlanChoiceMarkdown(tempRoot, [
      { id: 1, title: "Safe migration", body: "## Steps\n\n1. Preserve behavior." },
      { id: 2, title: "Focused rewrite", body: "## Steps\n\n1. Replace the module." },
      { id: 3, title: "Incremental split", body: "## Steps\n\n1. Extract boundaries." },
    ]);

    assert.equal(materialized.choices.length, 3);
    assert.equal(materialized.choices[0].markdownPath, path.join("plan_options", "option_1.md"));
    const overview = await fs.readFile(materialized.overviewPath, "utf8");
    assert.match(overview, /# Plan Options/);
    assert.match(overview, /## Option 1: Safe migration/);
    assert.match(overview, /## Option 2: Focused rewrite/);
    assert.match(overview, /## Option 3: Incremental split/);
    assert.match(overview, /\.\/plan_options\/option_1\.md/);
    const option = await fs.readFile(
      path.join(tempRoot, materialized.choices[2].markdownPath!),
      "utf8"
    );
    assert.match(option, /^# Plan Option 3: Incremental split/m);
    assert.match(option, /Extract boundaries/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("planning rejects Markdown output paths outside the session directory", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-plan-paths-"));
  try {
    await assert.rejects(
      materializePlanChoiceMarkdown(
        tempRoot,
        [{ id: 1, title: "Unsafe", body: "Do not write this." }],
        path.join("..", "escaped.md")
      ),
      /escapes the session directory/
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("legacy RUNNING state migration is idempotent and blocks without a lease", () => {
  const legacy: any = {
    stateVersion: 1,
    sessionId: "legacy",
    status: "RUNNING",
    phase: "IMPLEMENTATION",
    loopCount: 2,
    cliBinary: "opencode",
    agentStates: {
      planner: { status: "idle", lastExitCode: null, lastRunAt: null },
      implementer: { status: "running", lastExitCode: null, lastRunAt: null },
      tester: { status: "idle", lastExitCode: null, lastRunAt: null },
      qa_lead: { status: "idle", lastExitCode: null, lastRunAt: null },
      master: { status: "idle", lastExitCode: null, lastRunAt: null },
      interrupter: { status: "idle", lastExitCode: null, lastRunAt: null },
    },
  };
  const first = normalizeLoopState(legacy);
  assert.equal(first.migrated, true);
  assert.equal(first.state.status, "BLOCKED");
  assert.equal(first.state.stateVersion, 2);
  assert.deepEqual(first.state.additionalAllowedPaths, []);
  assert.equal(first.state.accessMode, "ask");
  assert.equal(first.state.pendingAccessRequest, null);
  assert.equal(first.state.agentStates.implementer.status, "idle");
  const second = normalizeLoopState(first.state);
  assert.equal(second.migrated, false);
});

test("exhausted failures pause only after observable model spend", () => {
  const failure = (kind: any, retryable = true): any => ({
    kind,
    message: kind,
    retryable,
    occurredAt: new Date().toISOString(),
    attemptId: "attempt-1",
    role: "implementer",
    phase: "IMPLEMENTATION",
    exitCode: 1,
    cliSessionId: null,
  });
  assert.equal(
    classifyExhaustedFailureDisposition(failure("transport_timeout"), [
      { assistantTextBytes: 200, maxObservedTotalTokens: 50 },
    ]),
    "recover_transport"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("idle_timeout"), [
      { assistantTextBytes: 0, maxObservedTotalTokens: null },
    ]),
    "recover_transport"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("incomplete_response"), [
      { assistantTextBytes: 200, maxObservedTotalTokens: 50 },
      { assistantTextBytes: 250, maxObservedTotalTokens: 60 },
    ]),
    "pause_stagnation"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("incomplete_response"), [
      { assistantTextBytes: 200, maxObservedTotalTokens: 50 },
    ]),
    "recover_transport"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("auth", false), []),
    "wait_for_user"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("orphaned_process", false), []),
    "blocked"
  );
});

test("automatic recovery backoff reuses the final configured delay", () => {
  assert.equal(automaticRecoveryDelayMs(1, [60_000, 300_000]), 60_000);
  assert.equal(automaticRecoveryDelayMs(2, [60_000, 300_000]), 300_000);
  assert.equal(automaticRecoveryDelayMs(4, [60_000, 300_000]), 300_000);
});

test("persisted timeout failures mislabeled as auth are normalized on resume", () => {
  const normalized = normalizeLoopState({
    stateVersion: 2,
    sessionId: "timeout-migration",
    status: "PAUSED",
    phase: "INTERRUPT",
    targetProjectPath: process.cwd(),
    lastFailure: {
      kind: "auth",
      message: "Phase exceeded 900000ms",
      retryable: false,
      occurredAt: new Date().toISOString(),
      attemptId: "attempt-1",
      role: "implementer",
      phase: "IMPLEMENTATION",
      exitCode: 1,
      cliSessionId: "session-1",
    },
    agentStates: {},
  } as any);
  assert.equal(normalized.state.lastFailure?.kind, "phase_timeout");
  assert.equal(normalized.state.lastFailure?.retryable, true);
  assert.match(normalized.state.lastFailureDigest ?? "", /classifier error/);
});

test("attempt hard timeout never extends beyond the recovery deadline", () => {
  assert.equal(boundedAttemptTimeoutMs(600_000, 1_000_000, 990_000), 10_000);
  assert.equal(boundedAttemptTimeoutMs(600_000, 2_000_000, 1_000_000), 600_000);
  assert.equal(boundedAttemptTimeoutMs(600_000, 1_000_000, 1_000_001), 0);
});

test("recovery blocks when any persisted child PID cannot be confirmed dead", async () => {
  const terminated: number[] = [];
  const result = await cleanupRecoveredChildProcesses(
    [101, 202],
    5_000,
    {
      currentPid: 999,
      check: (pid) => pid === 101 ? "dead" : "alive",
      terminate: async (pid) => {
        terminated.push(pid);
        return "unknown";
      },
    }
  );
  assert.deepEqual(terminated, [202]);
  assert.equal(result.orphanedPid, 202);
});

test("only manual resume starts a new recovery cycle after an interrupter briefing", () => {
  const state = normalizeLoopState({
    stateVersion: 2,
    status: "PAUSED",
    interruptBriefing: "Attempts exhausted.",
    activeAttempt: {
      status: "succeeded",
    },
  } as any).state;
  assert.equal(shouldStartManualRecoveryCycle(state, false), true);
  assert.equal(shouldStartManualRecoveryCycle(state, true), false);
  state.interruptBriefing = null;
  assert.equal(shouldStartManualRecoveryCycle(state, false), false);
});
