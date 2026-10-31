import { NodeVerdict } from "../shared/execution_types";
import {
  AgentGraphDocument,
  AgentNode,
  CommandReceipt,
  PlanChoice,
  VerificationContract,
  NodeTestProof,
} from "../shared/domain";
import { SupervisorResult } from "./process_supervisor";
import {
  evaluateRequirementCoverage,
  RequirementItem,
  parseRequirementEvidence,
} from "./requirement_ledger";
import { FailureKind } from "./resilience";
import {
  checkCommandKey,
  failedVerificationCommand,
  isVerificationCommand,
  isBrowserVerificationCommand,
  commandSucceeded,
} from "./verification_evidence";
import { renderStructuredReport } from "./report_protocol";
import { missingContractReceipts } from "./verification_contract";
import { deliverableInspectionProblem } from "./deliverables";
import { implementationBlocker } from "./implementation_blocker";
import { diagnosticMessage } from "./cli_diagnostics";
import {
  nodeTestProofProblem,
  nodeScopeAuditProblem,
  nodeInspectionProblem,
} from "./node_test_policy";
import {
  isAuditRole,
  isReadOnly,
  isResearchRole,
  isVerifierRole,
} from "../shared/node_roles";
export const requiresResearch = (goal: string): boolean =>
  /(?:인터넷|웹)\s*(?:을|를|에서|으로)?\s*(?:검색|조사|찾)|\b(?:search|browse|research|look\s*up)(?:\s+the)?\s+(?:internet|web)\b|\b(?:internet|web)\s+(?:search|research)\b/i.test(
    goal.replace(/\s+/g, " "),
  );
export function parsePlans(output: string): PlanChoice[] {
  return [
    ...output.matchAll(
      /^##\s*OPTION\s+(\d+)\s*:\s*([^\n]+)\n([\s\S]*?)(?=^##\s*OPTION\s+\d+\s*:|^\[PHASE_DONE\]\s*$|$(?![\s\S]))/gim,
    ),
  ].map((m) => ({
    id: Number(m[1]),
    title: m[2]!.trim(),
    body: m[3]!.trim(),
    revision: 1,
  }));
}
/** Plan references are prose, not execution evidence. Recognize explicit lists
 * and bounded ranges of known IDs without changing the model's original plan. */
function planReferences(
  body: string,
  requirements: RequirementItem[],
): Set<string> {
  const ids = new Set(body.match(/\bREQ-\d+\b/g) ?? []);
  const known = new Set(requirements.map((r) => r.id));
  const id = (digits: string) => `REQ-${digits}`;
  for (const match of body.matchAll(
    /\bREQ-\d{3,}(?:\s*[\/,]\s*(?:REQ-)?\d{3,}\b)+/g,
  ))
    for (const number of match[0].matchAll(/\d{3,}\b/g))
      if (known.has(id(number[0]))) ids.add(id(number[0]));
  for (const match of body.matchAll(
    /\bREQ-(\d{3,})\s*(?:\.\.|[-–—~])\s*(?:REQ-)?(\d{3,})\b/g,
  )) {
    if (!known.has(id(match[1]!)) || !known.has(id(match[2]!))) continue;
    const start = Number(match[1]),
      end = Number(match[2]);
    if (end < start) continue;
    // Iterate only the finite ledger, never a model-supplied numeric range.
    for (const r of requirements) {
      const n = Number(r.id.slice(4));
      if (n >= start && n <= end) ids.add(r.id);
    }
  }
  return ids;
}
export interface Completion {
  valid: boolean;
  reason: string | null;
  failureKind: FailureKind | null;
  output: string;
  verdict: NodeVerdict | null;
  plans: PlanChoice[];
  researchBlocked: boolean;
  environmentBlocked: string | null;
}
export interface CompletionContext {
  goal: string;
  requirements: RequirementItem[];
  /** Receipts to judge; defaults to what this attempt observed. */
  commands?: CommandReceipt[];
  /** Receipts of the accepted test visit that review and approval rely on. */
  priorTestProof?: CommandReceipt[];
  automation?: AgentGraphDocument["automation"];
  contract?: VerificationContract;
  cwd?: string;
  nodeTestProof?: NodeTestProof;
  /** Files proven read; defaults to what this attempt observed. */
  inspectedFiles?: string[];
}
interface Judging extends CompletionContext {
  node: AgentNode;
  result: SupervisorResult;
  commands: CommandReceipt[];
  priorTestProof: CommandReceipt[];
  inspectedFiles: string[];
  answer: Completion;
}
/** Returns the finished judgment, or nothing to let the next gate look. */
type Judged = Completion | void;
type Gate = (j: Judging) => Judged;

const fail = (
  { answer }: Judging,
  reason: string,
  failureKind: FailureKind = "incomplete_response",
): Completion => ({ ...answer, valid: false, reason, failureKind });

/** A terminal prose sentinel ends implementation, never approves the product.
 * Canonicalize only the observed autonomous implementation variation; quoted,
 * repeated, fenced or nonterminal markers and all audit roles stay strict. */
function normalizedOutput(
  node: AgentNode,
  text: string,
  automation: CompletionContext["automation"],
): string {
  const output = text.replace(/\r\n/g, "\n").trim();
  return automation &&
    node.type === "implementation" &&
    (output.match(/\[PHASE_DONE\]/g) ?? []).length === 1 &&
    !output.includes("```") &&
    !output.includes("~~~") &&
    /[.!?。][\t ]+\[PHASE_DONE\]$/.test(output)
    ? output.replace(/[\t ]+\[PHASE_DONE\]$/, "\n[PHASE_DONE]")
    : output;
}
const cliFailure: Gate = (j): Judged => {
  const { result, node } = j;
  if (result.exitCode !== 0 || result.outcome !== "succeeded")
    return fail(
      j,
      result.failureMessage ?? `CLI 종료 코드 ${result.exitCode}`,
      result.failureKind ?? "process_exit",
    );
  if (result.diagnostics.terminalError)
    return fail(
      j,
      result.diagnostics.terminalError.message,
      result.diagnostics.terminalError.kind,
    );
  if (isReadOnly(node.type) && result.evidence.fileMutation)
    return fail(
      j,
      "읽기 전용 역할에서 파일 변경이 관측되었습니다.",
      "role_violation",
    );
};
const implementationHandoff: Gate = (j): Judged => {
  const { answer } = j;
  if (j.node.type !== "implementation") return;
  try {
    const observed = j.commands.find((c) => c.environmentError),
      reported = implementationBlocker(answer.output);
    if (!observed && !reported) return;
    if (!observed && reported?.kind !== "external")
      return fail(
        j,
        `구현이 ${reported?.kind} blocker를 보고했습니다. 같은 구현 역할에서 원인을 수정한 뒤 완료하세요: ${reported?.evidence}`,
      );
    answer.verdict = "BLOCKED";
    answer.environmentBlocked = diagnosticMessage(
      `구현 외부 환경 제약: ${observed ? `${observed.command} → ${observed.environmentError}` : reported?.evidence}. 제품 수정이나 테스트 호출로 반복하지 않습니다.`,
    );
    return answer;
  } catch (error) {
    return fail(
      j,
      `구현 blocker 보고 보완 필요: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const structuredReport: Gate = (j): Judged => {
  const { node, answer, contract } = j;
  try {
    const rendered = renderStructuredReport(
      answer.output,
      node,
      j.requirements,
      node.type === "test" ? j.commands : j.priorTestProof,
      contract,
      j.cwd,
    );
    if (
      j.automation?.verificationContract &&
      contract?.status === "locked" &&
      isVerifierRole(node.type) &&
      rendered === null
    )
      return fail(
        j,
        "고정 검증 계약은 AGENT_REPORT JSON v1 보고가 필요합니다.",
      );
    if (rendered !== null) answer.output = rendered;
  } catch (error) {
    return fail(
      j,
      `구조화 보고 보완 필요: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const testRoleProductEdits: Gate = ({
  node,
  result,
  automation,
  commands,
  answer,
}): Judged => {
  const productionEdits = (result.evidence.changedFiles ?? []).filter(
    (file) =>
      !/^(?:test|tests|verification|\.agent-graph|artifacts|test-results|playwright-report)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$|^playwright\.config\.[cm]?[jt]s$/.test(
        file.replace(/\\/g, "/"),
      ),
  );
  if (
    automation &&
    node.type === "test" &&
    productionEdits.length &&
    !commands.some((c) => c.environmentError)
  ) {
    answer.verdict = "FAIL";
    answer.reason = `테스트 역할의 제품 파일 변경을 반려했습니다: ${productionEdits.join(", ")}. 구현 역할에서 수정하고 전체 검증을 다시 수행해야 합니다.`;
    return answer;
  }
};
const repairableBlocker = ({ automation, answer }: Judging): boolean =>
  Boolean(automation) &&
  /^BLOCKED_KIND:\s*(?:product|test_setup)\s*$/im.test(answer.output);
const verifierBlocked: Gate = (j): Judged => {
  const { answer } = j;
  if (!isVerifierRole(j.node.type)) return;
  const blocked = j.commands.find((c) => c.environmentError);
  const reportedBlocked = parseRequirementEvidence(answer.output).some(
    (r) => r.status === "BLOCKED",
  );
  if (
    blocked ||
    (!repairableBlocker(j) &&
      (reportedBlocked ||
        /^(?:\*\*|__)?VERDICT:\s*BLOCKED\b/im.test(answer.output)))
  ) {
    answer.verdict = "BLOCKED";
    answer.environmentBlocked = blocked
      ? `검증 환경 제약: ${blocked.command} → ${blocked.environmentError}. 환경을 해결한 뒤 같은 방문을 수동 재개하세요.`
      : "테스트 역할이 필수 검사를 BLOCKED로 보고했습니다. 실제 명령 로그와 환경을 확인한 뒤 수동 재개하세요.";
    return answer;
  }
};
const phaseDoneMarker: Gate = (j): Judged => {
  const { output } = j.answer;
  if (
    !/^\[PHASE_DONE\]\s*$/m.test(output) ||
    output.split("\n").at(-1)?.trim() !== "[PHASE_DONE]"
  )
    return fail(
      j,
      "assistant 응답 마지막에 독립 행 [PHASE_DONE]이 필요합니다.",
    );
};
const researchEvidence: Gate = (j): Judged => {
  const { answer, result } = j;
  if (!requiresResearch(j.goal) || !isResearchRole(j.node.type)) return;
  if (answer.researchBlocked) return answer;
  if (
    !result.evidence.completedSearches ||
    !/^SOURCE:\s*https?:\/\/\S+/im.test(answer.output) ||
    !/^(?:VERIFIED_FACT|LIMITATION):\s*\S+/im.test(answer.output)
  )
    return fail(
      j,
      "인터넷 조사에 대한 완료된 검색 이벤트와 SOURCE·VERIFIED_FACT 근거가 필요합니다.",
    );
};
function planningChoices(j: Judging): Judged {
  const { answer, node, requirements } = j;
  answer.plans = parsePlans(answer.output);
  const count = node.planning?.optionsCount ?? 3;
  if (
    answer.plans.length !== count ||
    !answer.plans.every((p, i) => p.id === i + 1 && p.body.length > 0)
  )
    return fail(j, `완전한 계획 선택지 ${count}개가 순서대로 필요합니다.`);
  const missing = answer.plans.flatMap((p) => {
    const ids = planReferences(p.body, requirements);
    const absent = requirements.filter((r) => !ids.has(r.id));
    return absent.length
      ? [`OPTION ${p.id}: ${absent.map((r) => r.id).join(", ")}`]
      : [];
  });
  if (missing.length)
    return fail(
      j,
      `계획별 필수 REQ ID 누락: ${missing.join("; ")}. 해결되지 않은 각 ID를 전체 표기로 작성하세요 (예: REQ-006, REQ-007). 알려진 ID의 명확한 목록·범위만 참조로 해석합니다. 구현이나 도구 재실행 없이 전체 계획 보고만 보완하세요.`,
    );
}
interface VerdictRules {
  /** What a repairable BLOCKED line counts as. */
  blockedAs: string;
  line: RegExp;
  positive: NodeVerdict;
  negative: NodeVerdict;
  absent: string;
  /** Names the verdict the model has to send again. */
  verdictName: string;
}
const TEST_VERDICT: VerdictRules = {
  blockedAs: "VERDICT: FAIL",
  line: /^(?:\*\*|__)?VERDICT:\s*(PASS|FAIL)\b.*$/gim,
  positive: "PASS",
  negative: "FAIL",
  absent: "VERDICT: PASS 또는 FAIL 행이 필요합니다.",
  verdictName: "VERDICT",
};
const AUDIT_VERDICT: VerdictRules = {
  blockedAs: "REJECTED",
  line: /^(?:\*\*|__)?(APPROVED|REJECTED)\b.*$/gim,
  positive: "APPROVED",
  negative: "REJECTED",
  absent: "APPROVED 또는 REJECTED 행이 필요합니다.",
  verdictName: "승인 판정",
};
function reportedVerdict(
  j: Judging,
  coverage: ReturnType<typeof evaluateRequirementCoverage>,
  rules: VerdictRules,
): Judged {
  const { answer } = j;
  const text = repairableBlocker(j)
    ? answer.output.replace(/^VERDICT:\s*BLOCKED\b.*$/gim, rules.blockedAs)
    : answer.output;
  const lines = [...text.matchAll(rules.line)];
  if (!lines.length) return fail(j, rules.absent);
  const positive = lines.at(-1)![1]!.toUpperCase() === rules.positive;
  answer.verdict =
    positive && coverage.allSatisfied ? rules.positive : rules.negative;
  if (!positive) return;
  if (!coverage.allSatisfied)
    answer.reason = `요구사항 증거가 부족합니다: ${coverage.unresolved.join(", ")}`;
  if (
    coverage.missing.length > 0 &&
    coverage.unresolved.length === coverage.missing.length
  )
    return fail(
      j,
      `요구사항 증거 형식이 누락되었거나 잘못되었습니다: ${coverage.missing.join(", ")}. 기존 결과를 보존하고 모든 REQ의 올바른 증거 블록과 ${rules.verdictName}를 포함한 전체 최종 보고를 다시 반환하세요.`,
    );
}
const roleVerdict: Gate = (j): Judged => {
  const coverage = evaluateRequirementCoverage(j.answer.output, j.requirements);
  if (j.node.type === "planning") return planningChoices(j);
  if (j.node.type === "test") return reportedVerdict(j, coverage, TEST_VERDICT);
  if (isAuditRole(j.node.type))
    return reportedVerdict(j, coverage, AUDIT_VERDICT);
};
const positive = ({ answer }: Judging) =>
  answer.verdict === "PASS" || answer.verdict === "APPROVED";
const negativeVerdict = ({ node }: Judging): NodeVerdict =>
  node.type === "test" ? "FAIL" : "REJECTED";
const approvalInspections: Gate = (j): Judged => {
  if (j.answer.verdict !== "APPROVED") return;
  const nodeTests = j.contract?.manifest?.nodeTests;
  const problem =
    deliverableInspectionProblem(j.contract?.manifest, j.inspectedFiles) ??
    (nodeTests ? nodeInspectionProblem(nodeTests, j.inspectedFiles) : null);
  if (problem) return fail(j, problem);
};
const noFailedEvidence: Gate = (j): Judged => {
  const { answer, contract } = j;
  if (!positive(j)) return;
  const problem =
    nodeTestProofProblem(contract?.manifest?.nodeTests, j.nodeTestProof) ??
    nodeScopeAuditProblem(contract?.manifest?.nodeTests, answer.output);
  if (problem) {
    answer.verdict = negativeVerdict(j);
    answer.reason = problem;
    return answer;
  }
  const failed = failedVerificationCommand(j.commands);
  if (failed) {
    answer.verdict = negativeVerdict(j);
    answer.reason = `관측된 검증 명령이 성공하지 않았습니다: ${failed.command} (exit ${failed.exitCode ?? "unknown"}).`;
    return answer;
  }
};
const contractReceipts: Gate = (j): Judged => {
  const { answer, node } = j;
  if (!positive(j)) return;
  const missing = missingContractReceipts(
    j.contract,
    node.type === "test" ? j.commands : j.priorTestProof,
    !!j.automation?.verificationContract,
    j.cwd,
  );
  if (!missing.length) return;
  if (node.type === "test")
    return fail(
      j,
      `검증 계약의 실제 성공 기록이 필요합니다: ${missing.join(", ")}. 계약의 해당 명령만 단독 foreground 호출로 실행하세요. Missing native receipts: execute EVERY missing registry command literally, without | tail, | head, semicolon, echo, status wrappers or extra flags; read saved reports separately. Native tools may truncate displayed output without changing exit status.`,
    );
  answer.verdict = "REJECTED";
  answer.reason = `검증 계약의 테스트 기록이 부족합니다: ${missing.join(", ")}`;
  return answer;
};
const testPassReceipts: Gate = (j): Judged => {
  const { commands, cwd, requirements } = j;
  if (j.answer.verdict !== "PASS") return;
  if (
    j.automation?.browserVerification &&
    !commands.some(
      (c) =>
        commandSucceeded(c) && isBrowserVerificationCommand(c.command, cwd),
    )
  )
    return fail(
      j,
      "자율 웹 검증에는 플랫폼 verify-browser 명령의 실제 성공 기록이 필요합니다. 브라우저 보고서만 작성하거나 npm test로 대체할 수 없습니다.",
    );
  const records = new Map(
    parseRequirementEvidence(j.answer.output).map((r) => [r.requirementId, r]),
  );
  const unverified = requirements.filter((r) => {
    const command = records.get(r.id)?.checkCommand;
    return (
      !command ||
      !commands.some(
        (c) =>
          checkCommandKey(c.command) === checkCommandKey(command) &&
          commandSucceeded(c) &&
          isVerificationCommand(c.command, cwd),
      )
    );
  });
  if (
    !commands.some(
      (c) => commandSucceeded(c) && isVerificationCommand(c.command, cwd),
    ) ||
    unverified.length
  )
    return fail(
      j,
      `관측된 성공 검증 명령이 필요합니다 (${unverified.map((r) => r.id).join(", ")}). 각 요구사항 블록에 CHECK_COMMAND: 실제 실행 명령을 적으세요. 설명이나 저장된 로그 파일만으로 PASS를 판정할 수 없습니다.`,
    );
};
const approvalTestProof: Gate = ({ answer, priorTestProof, cwd }): Judged => {
  if (
    answer.verdict === "APPROVED" &&
    !priorTestProof.some(
      (c) => commandSucceeded(c) && isVerificationCommand(c.command, cwd),
    )
  ) {
    answer.verdict = "REJECTED";
    answer.reason =
      "현재 구현에 대한 테스트 역할의 관측된 PASS 기록이 없습니다. 검증을 실행한 뒤 승인해야 합니다.";
  }
};
/** Order matters: a later gate relies on what an earlier one already ruled out. */
const GATES: Gate[] = [
  cliFailure,
  implementationHandoff,
  structuredReport,
  testRoleProductEdits,
  verifierBlocked,
  phaseDoneMarker,
  researchEvidence,
  roleVerdict,
  approvalInspections,
  noFailedEvidence,
  contractReceipts,
  testPassReceipts,
  approvalTestProof,
];
export function validateCompletion(
  node: AgentNode,
  result: SupervisorResult,
  context: CompletionContext,
): Completion {
  const output = normalizedOutput(
    node,
    result.assistantText,
    context.automation,
  );
  const answer: Completion = {
    valid: true,
    reason: null,
    failureKind: null,
    output,
    verdict: null,
    plans: [],
    researchBlocked: /^RESEARCH_BLOCKED\s*$/im.test(output),
    environmentBlocked: null,
  };
  const judging: Judging = {
    ...context,
    node,
    result,
    answer,
    commands: context.commands ?? result.evidence.commands,
    priorTestProof: context.priorTestProof ?? [],
    inspectedFiles: context.inspectedFiles ?? result.evidence.readFiles ?? [],
  };
  for (const gate of GATES) {
    const finished = gate(judging);
    if (finished) return finished;
  }
  return answer;
}
