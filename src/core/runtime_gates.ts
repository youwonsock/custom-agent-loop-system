import {
  AgentNode,
  ModelPricing,
  NodeTestProof,
  NodeVisit,
  SessionState,
  SessionStatus,
} from "../shared/domain";
import { Completion, validateCompletion } from "./completion";
import { ClaimedControlRequest, completeControlRequest } from "./control_queue";
import { deliverableProblem } from "./deliverables";
import { messageOf } from "./errors";
import { modelPricing } from "./model_pricing";
import { SCOPE_VIOLATION } from "./native_scope";
import { readNodeTestProof } from "./node_test_verification";
import { IO_VIOLATION } from "./program_io";
import { SupervisorResult } from "./process_supervisor";
import { AttemptFailure, ControlQueuePaths } from "./resilience";
import {
  AttemptRun,
  Completed,
  Stage,
  Stopped,
  STOPPED,
  UNDECIDED,
  Undecided,
  completed,
  contextMessage,
} from "./runtime_steps";
import { sessionBudgetReason } from "./session_budget";
import { stageBudgetReason } from "./stage_budget";
import {
  TEST_FAILED,
  TEST_POLICY,
  currentVerificationSources,
  sourceDifference,
  testSources,
} from "./test_source_guard";
import { productionHashes } from "./verification_sources";
import {
  currentNodeTestProof,
  currentTestProof,
} from "./verification_evidence";
import { isAuditRole, isReadOnly, isVerifierRole } from "../shared/node_roles";

/** What the steps after a supervised attempt need from the running session. */
export interface GateHost {
  readonly state: SessionState;
  readonly pricing: ReadonlyMap<string, ModelPricing>;
  controls(): ControlQueuePaths;
  save(): Promise<void>;
  settle(status: SessionStatus, reason: string | null): Promise<void>;
  halt(
    visit: NodeVisit,
    status: SessionStatus,
    reason: string,
    effects: { pauseVisit: boolean; clearRecovery: boolean },
  ): Promise<Stopped>;
  finishControl(request: ClaimedControlRequest): Promise<void>;
  budgetStop(reason: string): Promise<void>;
  stageStop(reason: string, visit: NodeVisit): Promise<void>;
  contractStop(): Promise<boolean>;
  verificationFailure(node: AgentNode, reason: string): Completion;
  outside(text: string, intentRoots?: string[]): string[];
  sourceChanges(expected: Record<string, string>): Promise<string[]>;
}
type Step = Stopped | Completed | Undecided;
interface GateContext {
  host: GateHost;
  stage: Stage;
  run: AttemptRun;
}
/** Returns a step to end the attempt there; nothing moves on to the next gate. */
type EvidenceGate = (
  context: GateContext,
) => Promise<Stopped | Completed | void>;

const orphanedProcess: EvidenceGate = async ({ host, stage, run }) => {
  const { attempt, result } = run;
  if (result.outcome !== "orphaned_process") return;
  attempt.failureKind = "orphaned_process";
  attempt.message = contextMessage(
    stage,
    result.failureMessage ?? "CLI 프로세스 종료를 확인할 수 없습니다.",
  );
  await host.halt(stage.visit, "BLOCKED", attempt.message, {
    pauseVisit: true,
    clearRecovery: false,
  });
  if (result.controlRequest)
    await completeControlRequest(
      host.controls(),
      result.controlRequest,
      "failed",
      "자식 프로세스 종료를 확인하지 못해 실행을 차단했습니다.",
    );
  return STOPPED;
};
const pendingControl: EvidenceGate = async ({ host, run }) => {
  if (!run.result.controlRequest) return;
  await host.finishControl(run.result.controlRequest);
  return STOPPED;
};
const programIoEvidence: EvidenceGate = async ({ host, stage, run }) => {
  const { attempt } = run,
    audit = attempt.programIoAudit;
  if (
    !audit ||
    !(
      audit.invalidReceipts ||
      audit.unresolvedCommands ||
      audit.unwrappedCommands
    )
  )
    return;
  const reason = `${IO_VIOLATION} Kernel-isolated command evidence is incomplete or invalid.`;
  attempt.status = "process_exit";
  attempt.failureKind = "role_violation";
  attempt.message = reason;
  attempt.completionAccepted = false;
  return host.halt(stage.visit, "BLOCKED", reason, {
    pauseVisit: true,
    clearRecovery: true,
  });
};
const scopeEvidence: EvidenceGate = async ({ host, stage, run }) => {
  const { attempt } = run,
    audit = attempt.scopeAudit;
  if (!audit || !(audit.outsideCalls || audit.unresolvedCalls)) return;
  attempt.completionAccepted = false;
  attempt.failureKind = "role_violation";
  attempt.message = `${SCOPE_VIOLATION} 대상 밖 native 조회 또는 미확정 실행이 관측돼 실행을 차단했습니다.`;
  return host.halt(stage.visit, "BLOCKED", attempt.message, {
    pauseVisit: true,
    clearRecovery: true,
  });
};
const isFrozenTest = ({ node, policy }: Stage) =>
  policy.testSourceGuard && node.type === "test";
/** Records what the frozen test role changed; the policy gate acts on it later. */
const frozenTestChanges: EvidenceGate = async ({ host, stage, run }) => {
  const { sourceInputs, visit } = stage,
    { attempt, result } = run;
  if (!isFrozenTest(stage) || !sourceInputs) return;
  try {
    run.guardedInputs = await testSources(host.state.targetProjectPath);
    run.sourceChanges = [
      ...new Set([
        ...run.sourceChanges,
        ...sourceDifference(sourceInputs, run.guardedInputs),
      ]),
    ];
  } catch (error) {
    run.sourceChanges.push(`소스 snapshot 읽기 실패: ${messageOf(error)}`);
  }
  const nativeSources = (result.evidence.changedFiles ?? []).filter(
    (f) =>
      !/^(?:verification|artifacts|test-results|playwright-report|coverage)(?:\/|$)/.test(
        f.replace(/\\/g, "/"),
      ),
  );
  run.sourceChanges = [...new Set([...run.sourceChanges, ...nativeSources])];
  result.evidence.fileMutation = run.sourceChanges.length > 0;
  attempt.fileMutation = result.evidence.fileMutation;
  if (!run.sourceChanges.length && !run.policyReason) return;
  run.policyReason ??= `${TEST_POLICY} 테스트 역할의 제품·테스트 소스 변경을 반려했습니다: ${run.sourceChanges.join(", ")}. 구현과 전체 검증을 다시 수행해야 합니다.`;
  attempt.verificationInvalidation = {
    at: new Date().toISOString(),
    reason: run.policyReason,
    files: run.sourceChanges,
  };
  visit.verifiedCommands = [];
  delete visit.nodeTestProof;
  delete visit.verificationSourceHashes;
  attempt.failureKind = run.policyReason.startsWith(TEST_FAILED)
    ? "process_exit"
    : "role_violation";
  attempt.message = run.policyReason;
  attempt.completionAccepted = false;
};
const sessionBudget: EvidenceGate = async ({ host }) => {
  const reason = sessionBudgetReason(host.state);
  if (!reason) return;
  await host.budgetStop(reason);
  return STOPPED;
};
const contractIntact: EvidenceGate = async ({ host }) =>
  (await host.contractStop()) ? STOPPED : undefined;
const protectedWrites: EvidenceGate = async ({ host, stage, run }) => {
  const written = (run.result.evidence.changedFiles ?? []).filter(
    (file) =>
      host.state.verificationContract?.hashes?.[file.replace(/\\/g, "/")] !==
      undefined,
  );
  if (!written.length) return;
  return host.halt(
    stage.visit,
    "BLOCKED",
    `고정 검증 파일의 쓰기가 관측됐습니다: ${written.join(", ")}`,
    { pauseVisit: true, clearRecovery: true },
  );
};
const environmentFailureKind = (environment: string) =>
  /EPERM|EACCES|permission denied|sandbox/i.test(environment)
    ? "permission"
    : /unreachable|disabled|ENETUNREACH|EAI_AGAIN/i.test(environment)
      ? "network"
      : "process_exit";
const frozenTestPolicy: EvidenceGate = async ({ host, stage, run }) => {
  const { node, visit } = stage,
    { attempt, result } = run;
  if (!isFrozenTest(stage) || !run.policyReason) return;
  const environment = result.evidence.commands.find(
    (c) => c.environmentError,
  )?.environmentError;
  if (environment) {
    const reason = `검증 환경 제약: ${environment}. 제품 수정으로 반복하지 않습니다. 필요한 실행 권한·환경을 확인한 뒤 같은 방문에서 전체 검사를 다시 수행하세요.`;
    attempt.status = attempt.failureKind = environmentFailureKind(environment);
    attempt.message = reason;
    attempt.completionAccepted = false;
    if (attempt.verificationInvalidation)
      attempt.verificationInvalidation.reason = reason;
    return host.halt(visit, "WAITING_USER", reason, {
      pauseVisit: true,
      clearRecovery: true,
    });
  }
  const terminal = result.diagnostics.terminalError;
  if (
    terminal &&
    ["auth", "permission", "model_unavailable"].includes(terminal.kind)
  )
    return host.halt(visit, "WAITING_USER", terminal.message, {
      pauseVisit: true,
      clearRecovery: false,
    });
  await host.save();
  return completed(host.verificationFailure(node, run.policyReason));
};
const stageBudget: EvidenceGate = async ({ host, stage }) => {
  const reason = stageBudgetReason(host.state, stage.node, stage.visit);
  if (!reason) return;
  await host.stageStop(reason, stage.visit);
  return STOPPED;
};
/** Hash comparison catches writes no event reported, such as node -e. */
const hiddenChanges: EvidenceGate = async ({ host, stage, run }) => {
  const { node, policy, sourceInputs } = stage,
    { attempt, result } = run,
    readOnly = isReadOnly(node.type);
  if (
    !sourceInputs ||
    !(!policy.testSourceGuard || readOnly) ||
    result.outcome !== "succeeded"
  )
    return;
  let changed: string[];
  try {
    const after = readOnly
      ? await testSources(host.state.targetProjectPath)
      : await productionHashes(host.state.targetProjectPath);
    changed = [
      ...new Set([...Object.keys(sourceInputs), ...Object.keys(after)]),
    ].filter((file) => sourceInputs[file] !== after[file]);
  } catch (error) {
    changed = [`소스 검사 차단: ${messageOf(error)}`];
  }
  if (!changed.length) return;
  result.evidence.changedFiles = [
    ...new Set([...(result.evidence.changedFiles ?? []), ...changed]),
  ];
  result.evidence.fileMutation = true;
  attempt.fileMutation = true;
};
const auditedSources: EvidenceGate = async ({ host, stage, run }) => {
  const { node, policy, visit } = stage;
  if (
    !policy.testSourceGuard ||
    !isAuditRole(node.type) ||
    run.result.outcome !== "succeeded"
  )
    return;
  const expected = currentVerificationSources(host.state, visit);
  const changes = expected
    ? await host.sourceChanges(expected)
    : ["missing test source snapshot"];
  if (!changes.length) return;
  run.attempt.verificationInvalidation = {
    at: new Date().toISOString(),
    reason: "테스트 이후 소스 변경",
    files: changes,
  };
  return completed(
    host.verificationFailure(
      node,
      `테스트 이후 소스가 변경되어 승인 근거를 무효화했습니다: ${changes.join(", ")}`,
    ),
  );
};
/** In order: a later gate relies on what the earlier ones ruled out or recorded. */
const EVIDENCE_GATES: EvidenceGate[] = [
  orphanedProcess,
  pendingControl,
  programIoEvidence,
  scopeEvidence,
  frozenTestChanges,
  sessionBudget,
  contractIntact,
  protectedWrites,
  frozenTestPolicy,
  stageBudget,
  hiddenChanges,
  auditedSources,
];
export async function evidenceGates(
  host: GateHost,
  stage: Stage,
  run: AttemptRun,
): Promise<Step> {
  for (const gate of EVIDENCE_GATES) {
    const step = await gate({ host, stage, run });
    if (step) return step;
  }
  return UNDECIDED;
}

async function nodeTestProof({ host, stage, run }: GateContext) {
  const { node, visit } = stage,
    nodeTests = host.state.verificationContract?.manifest?.nodeTests;
  if (
    !nodeTests ||
    !isVerifierRole(node.type) ||
    run.result.outcome !== "succeeded"
  )
    return {};
  try {
    const proof: NodeTestProof = await readNodeTestProof(
      host.state.targetProjectPath,
      nodeTests,
    );
    if (node.type !== "test") {
      const prior = currentNodeTestProof(host.state, visit);
      if (
        !prior ||
        prior.runId !== proof.runId ||
        prior.reportDigest !== proof.reportDigest
      )
        throw Error(
          "자체 Node 증거가 현재 테스트 역할에서 승인된 실행과 다릅니다.",
        );
    }
    return { proof };
  } catch (error) {
    return { error: messageOf(error) };
  }
}
/** A verifier without its deliverables fails here; implementation gets a repair. */
async function deliverables(
  { host, stage, run }: GateContext,
  completion: Completion,
): Promise<Completed | void> {
  const { node, visit } = stage;
  if (
    !completion.valid ||
    !(node.type === "implementation" || isVerifierRole(node.type)) ||
    ["FAIL", "REJECTED", "BLOCKED"].includes(completion.verdict ?? "")
  )
    return;
  const problem = await deliverableProblem(host.state);
  if (!problem) return;
  run.attempt.completionAccepted = false;
  if (node.type === "implementation") {
    completion.valid = false;
    completion.failureKind = "incomplete_response";
    completion.reason = problem;
    return;
  }
  visit.verifiedCommands = [];
  delete visit.nodeTestProof;
  delete visit.verificationSourceHashes;
  return completed(host.verificationFailure(node, problem));
}
function recordPassedTest(
  { stage, run }: GateContext,
  completion: Completion,
  proof: NodeTestProof | undefined,
) {
  const { node, policy, visit } = stage;
  if (
    !completion.valid ||
    completion.verdict !== "PASS" ||
    node.type !== "test"
  )
    return;
  if (proof) visit.nodeTestProof = proof;
  if (policy.testSourceGuard && run.guardedInputs)
    visit.verificationSourceHashes = run.guardedInputs;
}
function planStaysInScope(
  { host, stage }: GateContext,
  completion: Completion,
) {
  if (
    !completion.valid ||
    stage.node.type !== "planning" ||
    !stage.policy.automated
  )
    return;
  const requested = host.outside(
    `${host.state.goal}\n${host.state.graph.nodes.map((n) => n.instructions).join("\n")}`,
  );
  const unrequested = [
    ...new Set(
      completion.plans.flatMap((plan) => host.outside(plan.body, requested)),
    ),
  ];
  if (!unrequested.length) return;
  completion.valid = false;
  completion.failureKind = "incomplete_response";
  completion.reason = `자율 계획에 목표가 요청하지 않은 외부 경로가 있습니다: ${unrequested.join(", ")}. Keep the plan inside the target; remove unrequested external paths and return the complete corrected plan without requesting operator access. Explicit external paths requested by the original goal retain approval gates.`;
}
/**
 * Parse and validate the role's completion. Undecided means the attempt
 * failed, with run.completion set for the failure step.
 */
export async function judge(
  host: GateHost,
  stage: Stage,
  run: AttemptRun,
): Promise<Step> {
  const { node, visit } = stage,
    { attempt, result } = run,
    context = { host, stage, run };
  const { proof, error: proofError } = await nodeTestProof(context);
  const completion = validateCompletion(node, result, {
    goal: host.state.goal,
    requirements: host.state.requirements.items,
    commands: visit.verifiedCommands ?? result.evidence.commands,
    priorTestProof: currentTestProof(host.state, visit),
    automation: host.state.graph.automation,
    contract: host.state.verificationContract,
    cwd: host.state.targetProjectPath,
    nodeTestProof: proof,
    inspectedFiles: [
      ...new Set(visit.attempts.flatMap((a) => a.readFiles ?? [])),
    ],
  });
  run.completion = completion;
  const undelivered = await deliverables(context, completion);
  if (undelivered) return undelivered;
  if (
    proofError &&
    completion.valid &&
    ["FAIL", "REJECTED"].includes(completion.verdict ?? "")
  )
    completion.reason = `자체 Node 검증: ${proofError}`;
  recordPassedTest(context, completion, proof);
  planStaysInScope(context, completion);
  if (completion.environmentBlocked) {
    visit.output = completion.output;
    visit.verdict = "BLOCKED";
    attempt.message = completion.environmentBlocked;
    attempt.completionAccepted = false;
    return host.halt(visit, "WAITING_USER", completion.environmentBlocked, {
      pauseVisit: true,
      clearRecovery: true,
    });
  }
  if (!completion.valid) return UNDECIDED;
  attempt.completionAccepted = !completion.researchBlocked;
  await host.save();
  return completed(completion);
}

export function classifyFailure(
  result: SupervisorResult,
  completion: Pick<Completion, "reason" | "failureKind">,
): AttemptFailure {
  const preserved =
    result.failureKind &&
    !["process_exit", "incomplete_response"].includes(result.failureKind);
  const diagnostic =
    result.diagnostics.terminalError ??
    (result.exitCode !== 0 || result.timedOut
      ? result.diagnostics.plainError
      : null);
  const kind =
    result.outcome === "orphaned_process"
      ? "orphaned_process"
      : result.cancelled
        ? "cancelled"
        : preserved
          ? result.failureKind!
          : result.timedOut
            ? "phase_timeout"
            : diagnostic
              ? diagnostic.kind
              : result.exitCode !== 0 || result.outcome !== "succeeded"
                ? "process_exit"
                : (completion.failureKind ?? "incomplete_response");
  const detail =
    !preserved && diagnostic
      ? diagnostic.message
      : (completion.reason ?? result.failureMessage);
  let message =
    kind === "auth"
      ? `CLI 인증이 필요합니다. 해당 CLI에서 로그인한 뒤 재개하세요.${diagnostic ? ` (${diagnostic.message})` : ""}`
      : kind === "model_unavailable"
        ? `CLI에서 선택한 모델을 실행할 수 없습니다. 모델 권한과 설정을 확인하세요.${diagnostic ? ` (${diagnostic.message})` : ""}`
        : (detail ?? `CLI 실패 (${result.exitCode})`);
  if (
    preserved &&
    result.timedOut &&
    diagnostic &&
    diagnostic.kind !== "process_exit"
  )
    message += `\nLast observed CLI error: ${diagnostic.message}`;
  return {
    kind,
    message,
    retryable:
      ![
        "auth",
        "model_unavailable",
        "permission",
        "role_violation",
        "orphaned_process",
        "cancelled",
      ].includes(kind) &&
      !["auth", "permission", "model_unavailable"].includes(
        diagnostic?.kind ?? "",
      ),
    occurredAt: new Date().toISOString(),
    attemptId: null,
    role: null,
    phase: null,
    exitCode: result.exitCode,
    cliSessionId: result.cliSessionId,
  };
}

/** Classify a failed attempt; null once a non-retryable failure stopped the session. */
export async function attemptFailure(
  host: GateHost,
  stage: Stage,
  { attempt, result, completion }: AttemptRun,
): Promise<AttemptFailure | null> {
  const { node, visit } = stage;
  attempt.completionAccepted = false;
  const failure = classifyFailure(result, completion!);
  // A retry meets the same refusal, and the missing-format reason would hide it.
  const denied = result.evidence.deniedWrites ?? [];
  if (
    denied.length &&
    !isReadOnly(node.type) &&
    failure.kind === "incomplete_response"
  ) {
    failure.kind = "permission";
    failure.retryable = false;
    failure.message = `CLI가 파일 쓰기 권한을 거부했습니다: ${denied.join(", ")}. CLI의 권한 설정과 프로젝트 신뢰 여부를 확인한 뒤 재개하세요.`;
  }
  failure.message = contextMessage(stage, failure.message);
  failure.attemptId = attempt.id;
  failure.role = node.roleName;
  failure.phase = node.type;
  attempt.status = failure.kind;
  attempt.failureKind = failure.kind;
  attempt.message = failure.message;
  visit.output = completion!.output;
  await host.save();
  if (!failure.retryable) {
    await host.halt(visit, "WAITING_USER", failure.message, {
      pauseVisit: true,
      clearRecovery: false,
    });
    return null;
  }
  const providerFailure =
    result.diagnostics.terminalError ?? result.diagnostics.plainError;
  if (
    (failure.kind === "quota_exhausted" ||
      providerFailure?.kind === "quota_exhausted") &&
    attempt.pricing?.status !== "free"
  ) {
    await host.halt(
      visit,
      "PAUSED",
      `${failure.message} ${attempt.pricing?.status === "paid" ? "유료" : "가격 미확인"} 모델의 공급자 사용 한도에 도달해 추가 호출 없이 정지했습니다.`,
      { pauseVisit: true, clearRecovery: false },
    );
    return null;
  }
  return failure;
}
/** Attempts ran out: schedule a free model's recovery, otherwise pause. */
export async function recoverOrPause(
  host: GateHost,
  node: AgentNode,
  visit: NodeVisit,
  reason: string,
): Promise<void> {
  const budget = sessionBudgetReason(host.state, true);
  if (budget) {
    await host.budgetStop(budget);
    return;
  }
  const stageReason = stageBudgetReason(host.state, node, visit, true);
  if (stageReason) {
    await host.stageStop(stageReason, visit);
    return;
  }
  const s = host.state.settings,
    pricing = host.pricing.get(node.id) ?? modelPricing();
  if (
    pricing.status === "free" &&
    node.type !== "interrupt" &&
    visit.automaticCycles < s.maxAutomaticRecoveryCycles
  ) {
    const delayMs =
      s.automaticRecoveryBackoffMs[
        Math.min(visit.automaticCycles, s.automaticRecoveryBackoffMs.length - 1)
      ]!;
    if (
      host.state.executionBudget &&
      Date.now() + delayMs >= Date.parse(host.state.executionBudget.deadlineAt)
    ) {
      await host.budgetStop(
        "남은 전체 실행 시간 안에 자동 복구를 시작할 수 없습니다.",
      );
      return;
    }
    visit.automaticCycles++;
    visit.status = "paused";
    host.state.automaticRecovery = {
      count: visit.automaticCycles,
      resumeAt: new Date(Date.now() + delayMs).toISOString(),
    };
    visit.cycleStartedAt = new Date().toISOString();
    visit.cycleDeadlineAt = new Date(
      Date.now() + delayMs + s.phaseRecoveryBudgetMs,
    ).toISOString();
    await host.settle(
      "RECOVERING",
      `${reason} 무료로 확인된 모델이므로 자동 복구 ${visit.automaticCycles}/${s.maxAutomaticRecoveryCycles}회를 예약했습니다. 재개 전에 무료 여부를 다시 확인합니다.`,
    );
  } else {
    visit.status = "paused";
    host.state.automaticRecovery = null;
    await host.settle(
      "PAUSED",
      `${reason} ${pricing.status === "free" ? "무료 모델의 자동 복구 한도 또는 중단 처리 제한에 도달했습니다." : `${pricing.status === "paid" ? "유료" : "가격 미확인"} 모델이므로 추가 자동 복구를 중지했습니다.`} 확인 후 수동 재개하세요.`,
    );
  }
}
