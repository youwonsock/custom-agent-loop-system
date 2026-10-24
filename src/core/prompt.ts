import { AgentNode, NodeVisit, SessionState } from "../shared/domain";
import { requiresResearch } from "./completion";
import { FailureKind } from "./resilience";
import { browserVerificationCommand } from "./browser_command";
import {
  currentTestProof,
  failedVerificationCommand,
  checkCommandKey,
  isVerificationCommand,
} from "./verification_evidence";
import { parseRequirementEvidence } from "./requirement_ledger";
export function buildRecoveryMessage(
  kind: FailureKind,
  message: string,
  assistantText: string,
  events: Record<string, unknown>[],
): string {
  const lines = [
    `[${kind}] ${message}`,
    `Previous observed output:\n${assistantText.slice(-5000)}`,
  ];
  if (kind === "tool_arguments") {
    const errors = events
      .flatMap((event) => {
        const part = event.part as Record<string, unknown> | undefined;
        const state = part?.state as Record<string, unknown> | undefined;
        return event.type === "tool_use" &&
          state?.status === "error" &&
          typeof state.error === "string"
          ? [`${String(part?.tool)}: ${state.error.slice(0, 1500)}`]
          : [];
      })
      .slice(-3);
    lines.push(
      "The preceding CLI aborted repeated unavailable tools or malformed tool input. This is a fresh bounded attempt. Follow the current role and native tool schema, supply all required fields, never submit {} and never repeat the same invalid call. Kilo read-only roles use read/glob/grep, never exec/exec_command/bash/write/edit. Writable roles use bash(command, description) for checks and write(filePath, content) for files. Never run checks in a read-only role. Do not weaken checks or switch models.",
      ...errors,
    );
  }
  return lines.join("\n");
}
const responsibilities: Record<AgentNode["type"], string> = {
  planning:
    "Inspect requirements and existing files without writing files. Return the requested number of complete strategies; when only one option is requested, propose one strategy without alternatives. Do not implement or invoke native plan approval tools; return the options as assistant text.",
  implementation:
    "Inspect existing work first. Implement cumulatively. Do not weaken, delete or skip tests to make the implementation appear complete. Run focused checks and report observed results.",
  test: "Run existing tests, add missing acceptance coverage and execute it. You may edit tests but never production code. Report product failures as FAIL. If required checks cannot run because of environment permissions, unavailable network or tooling, report VERDICT: BLOCKED and the exact command, observed error and operator action. Never repair production code or change sandbox settings to work around an execution sandbox. If the native CLI supports per-command approval, request approval for the exact required local test command; a denied request remains BLOCKED.",
  review:
    "Independently inspect the code, original goal and test evidence using read-only tools. Reject missing or contradictory evidence. Never repair files or conceal failing tests.",
  approval:
    "Audit the complete original goal and all requirements using read-only inspection. Approve only when the goal is proved by concrete evidence. Never edit files.",
  interrupt:
    "Explain the verified failure or stagnation, distinguish facts from hypotheses and give the smallest operator recovery action. Do not continue implementation or claim completion.",
};
export function buildNodePrompt(
  state: SessionState,
  node: AgentNode,
  visit: NodeVisit,
  recovery?: string,
): string {
  const structured = state.verificationContract?.status === "locked" && ["test","review","approval"].includes(node.type);
  const ref = state.approvedPlanRef;
  const approved = ref
    ? state.visits
        .find((v) => v.id === ref.visitId)
        ?.plans.find((p) => p.id === ref.choiceId)?.body
    : undefined;
  const evidence = [
    ...new Map(
      state.visits
        .filter((v) => v.completedAt && v.id !== visit.id)
        .map((v) => [v.nodeId, v]),
    ).values(),
  ];
  const lines = [
    `You are ${node.roleName}. Node: ${node.name} (${node.id}). Execution type: ${node.type}.`,
    `Session: ${state.id}. Visit: ${visit.id}. Each revisit is a new task execution.`,
    "=== ORIGINAL USER GOAL (AUTHORITATIVE) ===",
    state.goal,
    "The original goal is the acceptance contract. A plan is a subordinate strategy and may never omit, weaken or replace the goal.",
    "=== FIXED REQUIREMENTS ===",
    ...state.requirements.items.map((r) => `${r.id}: ${r.text}`),
    "=== MOST RECENT APPROVED PLAN ===",
    approved ?? "(none)",
    `=== TARGET PROJECT ===\n${state.targetProjectPath}`,
    state.accessMode === "full_access"
      ? "The operator granted full filesystem access for this session."
      : `Write only inside these approved roots: ${[state.targetProjectPath, ...state.additionalAllowedPaths].join(", ")}. Report exact additional paths if needed.`,
    "=== ROLE CONTRACT ===",
    structured && node.type === "test" ? responsibilities.test.replace("report VERDICT: BLOCKED and the exact command", "report JSON verdict BLOCKED and the exact command") : responsibilities[node.type],
    `=== NODE INSTRUCTIONS ===\n${node.instructions || "(no additional instructions)"}`,
    "Use your CLI configuration for MCP, search, skills and hooks. Do not assume a configured tool succeeded; cite observed evidence.",
    "=== PRIOR OBSERVED EVIDENCE ===",
    ...evidence.map(
      (v) =>
        `[${v.nodeId} / ${v.id}] ${v.verdict ?? v.status}\n${v.output.slice(-6000)}`,
    ),
    "=== NATIVE VERIFICATION RECEIPTS (execution evidence, not proof of coverage) ===",
    JSON.stringify(
      node.type === "test"
        ? (visit.verifiedCommands ?? [])
        : currentTestProof(state, visit),
    ),
    structured ? "The engine binds JSON judgments to frozen check IDs and observed native receipts. Never invent a passed check." : "For each requirement report: [REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001\nSTATUS: SATISFIED|PARTIAL|FAILED|BLOCKED\nEVIDENCE: concrete observed check or artifact\n[/REQUIREMENT_EVIDENCE]. Never invent a passed check.",
  ];
  if (state.executionBudget) lines.push("=== WHOLE SESSION BUDGET (never resets on retries/resume) ===",JSON.stringify({deadlineAt:state.executionBudget.deadlineAt,maxNativeAttempts:state.executionBudget.maxAttempts,usedNativeAttempts:state.visits.reduce((n,v)=>n+v.attempts.length,0)}),"The engine enforces this wall-clock and native-agent-invocation budget. Provider-internal model turns are not counted as separate native attempts. Do not edit budget files or create another session to evade the limits.");
  if (state.graph.automation?.verificationContract) lines.push(
    "=== FROZEN VERIFICATION CONTRACT ===",
    state.verificationContract?.status === "locked" ? JSON.stringify(state.verificationContract.manifest) : JSON.stringify({version:1,protectedFiles:["tests/verify-acceptance.mjs"],checks:[{id:"acceptance",command:"node tests/verify-acceptance.mjs",requirements:state.requirements.items.map(r=>r.id)}]}),
    state.verificationContract?.status === "locked"
      ? "This supplied/frozen manifest and every protected file must stay byte-for-byte unchanged, even in implementation repairs. All registered checks require actual exit-zero receipts in the test role. Never weaken or bypass a protected check, change npm scripts to replace it, or author its result. Refer to check IDs in plans rather than copying installed absolute paths."
      : "Implementation must prepare .agent-graph/verification.json before entering test. This is its schema/example; author meaningful acceptance tests, map EVERY fixed REQ ID to one or more check IDs, and list their files as protectedFiles. Commands must be single foreground verification runners, not reports or masked scripts. At least one protected acceptance runner must run directly; web contracts must also register the exact installed browser verifier. The engine freezes this contract at the test boundary; later repairs change production, never the protected checks. If the user supplied acceptance files, protect and preserve them. Planning is read-only: describe the contract without writing it.",
  );
  if (state.graph.automation) {
    lines.push(
      "=== AUTONOMOUS WORKFLOW ===",
      "After starting, complete implementation, tests, review and final approval without requesting routine operator feedback. Repair product defects in implementation; tests may add acceptance coverage but must not edit production code or frozen checks. Never create an operator-only evidence prerequisite unless the original user goal explicitly requires a human. Existing human approval/access gates remain binding. Never relabel an actual permission error as product failure.",
      structured ? "For fixable product/test-setup blockers use JSON verdict BLOCKED and blockedKind product or test_setup. Real permissions, authentication, external services and explicitly human evidence use blockedKind external and remain blocked." : "For a fixable product/test-setup blocker, report BLOCKED_KIND: product or BLOCKED_KIND: test_setup with concrete evidence and VERDICT: BLOCKED; it follows the failed verification repair path. Real permissions, authentication, external services and explicitly human evidence use BLOCKED_KIND: external and remain blocked.",
    );
    if (state.graph.automation.browserVerification) {
      const writable = node.type === "implementation" || node.type === "test";
      lines.push(
        writable
          ? "Actual browser execution is mandatory. Execute this exact platform-owned command directly, under the existing sandbox and command approval policy:"
          : "Actual browser evidence is mandatory, but this role is READ-ONLY. Plan or audit this expected command and its existing receipts/report; never execute it or create/edit the spec in this role:",
        browserVerificationCommand(),
        "Browser spec contract: .agent-graph/browser.json (version:1), server.command argv (e.g. [node,server.mjs], a dedicated ephemeral PORT is supplied; print the actual loopback URL), nonempty steps with unique ids. Available steps: viewport(width,height), click(selector), press(key), drag(selector,direction), reload, visible(selector), text(selector,equals or contains), count(selector,equals), noOverflow, within(selector,container), snapshot(name,selector), sameSnapshot(name,selector), differentSnapshot(name,selector), noConsoleErrors, http(path,status,contains). Actual assertions cover the original goal, desktop/390px bounds, controls, reload persistence and pointer input. The helper writes verification/browser/report.json, screenshots, trace and source hashes; never author or edit that report. It runs the actual generated server, never a fallback. A browser report without its native exit-zero receipt is not sufficient.",
      );
      if (writable) lines.push(
        "Create the spec only if absent; preserve any acceptance spec supplied by the user. Run unit tests first, then the exact browser command last as a single foreground call, without redirect, echo/status wrappers or file edits afterward. If it fails on product assertions, report FAIL for implementation. The verifier resolves Playwright from its own installation as a fallback: target-local require('playwright') failure is NOT an environment blocker. Execute the command before investigating dependencies. Do not inspect platform source or search for installations when a valid successful native verifier receipt already exists. Only its actual missing-tool error warrants preparing Playwright/Chromium through normal approved tools; never bypass a denied approval.",
      );
    }
  }
  if (node.type === "implementation" || node.type === "test")
    lines.push(
      "=== VERIFICATION EXECUTION CONTRACT ===",
      (structured ? "Report only JSON judgments; receipt commands are attached by the engine. " : "") + "The working directory is already the target. Run npm test directly without a cd prefix. Native tool metadata contains the exit code: do not rerun merely to echo it. Run the check as a single foreground command. For Node projects use npm test, or npm test > verification/model-tests.txt 2>&1 after creating the log directory in a SEPARATE tool call. Read the saved log in another tool call. Do not append echo, cat, tail, sed, exit, pipelines, background &, or shell status wrappers to the test command. Registered commands must match the actual native command (the trailing log redirect may be omitted). A failed assertion must remain a nonzero native exit, including inside package.json scripts; never use || fallback runners, exit-zero overrides, --passWithNoTests or --if-present for required checks. After changing files, rerun the affected checks; prior receipts are stale.",
      "Test externally observable behavior and adversarial boundaries, not just implementation helpers. For a served browser app, assert actual HTTP status/content for the entrypoint and assets, a missing file, traversal rejection and malformed URL handling. Close only servers the test started. Verify input blocking in overlays, persisted restart/continue state after reload, large safe-integer storage boundaries and visible controls at required viewport sizes. Do not claim actual browser testing from a DOM mock or source inspection.",
    );
  else
    lines.push(
      "Read-only audit: you must not execute tests or start servers. Inspect files and current native test-role receipts, including their exit codes and matching source-bound operator evidence. If checks need rerunning, report REJECTED with the reason so the graph returns to the writable implementation/test path. Never run a test to replace or repair missing proof from a read-only role.",
    );
  if (!structured && ["test", "review", "approval"].includes(node.type))
    lines.push(
      "The complete final report must contain one correctly formatted block for EVERY ID below. Choose exactly one STATUS and replace the EVIDENCE placeholder with observed facts. Write REQ_ID exactly once per line. A bare PASS or APPROVED without these blocks is incomplete.",
      ...state.requirements.items.map(
        (r) =>
          `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${r.id}\nSTATUS: SATISFIED|PARTIAL|FAILED|BLOCKED\nEVIDENCE: concrete observed check or artifact${node.type === "test" ? "\nCHECK_COMMAND: exact executed foreground test command" : ""}\n[/REQUIREMENT_EVIDENCE]`,
      ),
    );
  if (node.type === "planning")
    lines.push(
      `Return exactly ${node.planning?.optionsCount ?? 3} complete options. Use "## OPTION 1: Title" etc. Every option must include each full REQ ID, files, ordered implementation steps, verification and risks. Never compress IDs: write REQ-006, REQ-007 separately, not REQ-006/007. A format-only recovery needs only a corrected complete plan; do not inspect the platform source or repeat tools when existing evidence is sufficient.`,
      "In EACH option include a concrete plan entry for EVERY ID below, replacing each placeholder:",
      ...state.requirements.items.map(r => `${r.id}: planned implementation and verification`),
    );
  if (!structured && node.type === "test")
    lines.push(
      "PASS requires concrete SATISFIED evidence for every REQ and a CHECK_COMMAND: exact executed command line inside EACH requirement block. Execute a real test runner (for example npm test or node --test); exit zero is required. Do not use cat/echo, pipelines or masked exits as proof. Prior native verification receipts from this same visit may be cited when only repairing report format. A single suite may cover several requirements, but explain the actual assertions for each. Finish with VERDICT: PASS, VERDICT: FAIL or VERDICT: BLOCKED. Missing coverage is FAIL; unavailable execution environment is BLOCKED. Do not claim browser/device testing without actually performing it.",
    );
  if (!structured && (node.type === "review" || node.type === "approval"))
    lines.push(
      "APPROVED requires concrete SATISFIED evidence for every REQ and current native PASS receipts from the test role. Reject skipped, failed or stale verification. A failure, new implementation, plan or interrupt invalidates earlier test approval; rerun tests before approving. Only the final approval role can complete the session. Finish with APPROVED or REJECTED.",
    );
  if (
    requiresResearch(state.goal) &&
    ["planning", "review", "approval"].includes(node.type)
  )
    lines.push(
      "Complete actual web research. Include [RESEARCH_EVIDENCE], SOURCE: https://..., VERIFIED_FACT: ... or LIMITATION: ... . If your CLI cannot perform the required research, state RESEARCH_BLOCKED on its own line and explain the needed operator action.",
    );
  if (state.interruptMessage)
    lines.push(
      `=== OPERATOR MESSAGE (historical; the current node role takes precedence) ===\n${state.interruptMessage}`,
    );
  if (!structured && recovery && node.type === "test") {
    const receipts = visit.verifiedCommands ?? [];
    const missingChecks = [...new Set(parseRequirementEvidence(visit.output ?? "").flatMap(r =>
      r.checkCommand && !receipts.some(c => c.exitCode === 0 && !c.environmentError && checkCommandKey(c.command) === checkCommandKey(r.checkCommand!))
        ? [r.checkCommand] : []))];
    if (!receipts.length)
      lines.push(
        "No current accepted native verification receipt remains. Execute a fresh single foreground npm test command; read its native exit metadata and log separately. Do not reuse prior log-only PASS, prefix cd, append echo or print shell exit status. If browser verification is required, execute its exact platform command after unit tests.",
      );
    else if (failedVerificationCommand(receipts))
      lines.push(
        "Current native receipts include a failed or incomplete check. Preserve the failure and report a complete VERDICT: FAIL; formatting cannot turn it into PASS.",
      );
    else if (missingChecks.length)
      lines.push(
        "Only SOME checks have accepted native receipts. This is missing execution evidence, not report-only formatting. Execute each missing real runner as a standalone foreground command, then the platform browser command last. Never relabel a unit/engine requirement as covered only by a browser report. Do not repeat accepted checks solely for formatting, weaken tests or copy a rejected compound/masked command; use its underlying runner directly (npm test for Node). Missing accepted receipts:",
        ...missingChecks.filter(isVerificationCommand).map(c => `CHECK_COMMAND: ${c}`),
      );
    else
      lines.push(
        "Existing current native checks succeeded. Repair the report without editing files or rerunning checks. Copy CHECK_COMMAND exactly, including any leading cd, from these actual receipts:",
        ...receipts.map((c) => `CHECK_COMMAND: ${c.command}`),
      );
  }
  if (structured) {
    const receipts=node.type === "test" ? visit.verifiedCommands??[] : currentTestProof(state,visit);
    const missing=state.verificationContract!.manifest!.checks.filter(check=>!receipts.some(r=>r.exitCode===0&&!r.environmentError&&checkCommandKey(r.command)===checkCommandKey(check.command)));
    lines.push("=== JSON REPORT v1 ===",
      "Return one [AGENT_REPORT] JSON [/AGENT_REPORT] with version:1, verdict and requirements. Each requirement has id, status (SATISFIED/PARTIAL/FAILED/BLOCKED), evidence (concrete observed fact, max 2000 chars). Do NOT type CHECK_COMMAND, combine command strings, quote receipts, write a report file or add PHASE_DONE. The engine attaches check IDs, actual receipt IDs and commands. Every fixed ID is mandatory for PASS/APPROVED; omitted/duplicate/unknown IDs are rejected. Never infer a pass from an unexecuted/failed check. FAIL/REJECTED may return only failed items; an external blocker uses verdict:BLOCKED, blockedKind:external, and concrete evidence. Product/test setup blockers use blockedKind:product/test_setup. Existing access/auth gates always win.",
      `[AGENT_REPORT]\n${JSON.stringify({version:1,verdict:node.type==="test"?"PASS":"APPROVED",requirements:state.requirements.items.map(r=>({id:r.id,status:"SATISFIED",evidence:"replace with observed facts; use FAILED/BLOCKED when unproved"}))})}\n[/AGENT_REPORT]`,
      node.type==="test" ? (missing.length ? `Actual successful receipts still missing; execute THESE checks separately, browser last:\n${missing.map(c=>`${c.id}: ${c.command}`).join("\n")}` : "All frozen checks already have successful current receipts. Return JSON only without edits or repeated execution.") : "Read-only: inspect current test receipts and reports; reject missing, failed, skipped or stale evidence. Do not execute checks.");
  }
  if (recovery)
    lines.push(
      `=== BOUNDED RECOVERY ===\n${recovery}\nInspect existing changes first. Preserve completed work and finish the contract; do not blindly repeat implementation. If only the final report format was incomplete, return the complete corrected report using existing observed checks; do not rewrite production code or rerun already conclusive checks solely to repair formatting.`,
    );
  if (!structured) lines.push("The final assistant line must be [PHASE_DONE] on its own line.");
  return lines.join("\n\n");
}
