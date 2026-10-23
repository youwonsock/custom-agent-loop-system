import { NodeVerdict } from "../shared/execution_types";
import { AgentNode, CommandReceipt, PlanChoice } from "../shared/domain";
import { SupervisorResult } from "./process_supervisor";
import {
  evaluateRequirementCoverage,
  RequirementItem,
  parseRequirementEvidence,
} from "./requirement_ledger";
import { isReadOnly } from "./invocation";
import { FailureKind } from "./resilience";
import { checkCommandKey, failedVerificationCommand, isVerificationCommand } from "./verification_evidence";
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
export function validateCompletion(
  node: AgentNode,
  result: SupervisorResult,
  goal: string,
  requirements: RequirementItem[],
  commands: CommandReceipt[] = result.evidence.commands,
  priorTestProof: CommandReceipt[] = [],
): Completion {
  const output = result.assistantText.replace(/\r\n/g, "\n").trim();
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
  const fail = (
    reason: string,
    failureKind: FailureKind = "incomplete_response",
  ) => ({ ...answer, valid: false, reason, failureKind });
  if (result.exitCode !== 0 || result.outcome !== "succeeded")
    return fail(
      result.failureMessage ?? `CLI 종료 코드 ${result.exitCode}`,
      result.failureKind ?? "process_exit",
    );
  if (result.diagnostics.terminalError)
    return fail(
      result.diagnostics.terminalError.message,
      result.diagnostics.terminalError.kind,
    );
  if (isReadOnly(node.type) && result.evidence.fileMutation)
    return fail(
      "읽기 전용 역할에서 파일 변경이 관측되었습니다.",
      "role_violation",
    );
  if (["test", "review", "approval"].includes(node.type)) {
    const blocked = commands.find(c => c.environmentError);
    const reportedBlocked = parseRequirementEvidence(output).some(r => r.status === "BLOCKED");
    if (blocked || reportedBlocked || /^(?:\*\*|__)?VERDICT:\s*BLOCKED\b/im.test(output)) {
      answer.verdict = "BLOCKED";
      answer.environmentBlocked = blocked
        ? `검증 환경 제약: ${blocked.command} → ${blocked.environmentError}. 환경을 해결한 뒤 같은 방문을 수동 재개하세요.`
        : "테스트 역할이 필수 검사를 BLOCKED로 보고했습니다. 실제 명령 로그와 환경을 확인한 뒤 수동 재개하세요.";
      return answer;
    }
  }
  if (
    !/^\[PHASE_DONE\]\s*$/m.test(output) ||
    output.split("\n").at(-1)?.trim() !== "[PHASE_DONE]"
  )
    return fail("assistant 응답 마지막에 독립 행 [PHASE_DONE]이 필요합니다.");
  if (
    requiresResearch(goal) &&
    ["planning", "review", "approval"].includes(node.type)
  ) {
    if (answer.researchBlocked) return answer;
    if (
      !result.evidence.completedSearches ||
      !/^SOURCE:\s*https?:\/\/\S+/im.test(output) ||
      !/^(?:VERIFIED_FACT|LIMITATION):\s*\S+/im.test(output)
    )
      return fail(
        "인터넷 조사에 대한 완료된 검색 이벤트와 SOURCE·VERIFIED_FACT 근거가 필요합니다.",
      );
  }
  const coverage = evaluateRequirementCoverage(output, requirements);
  const missingOnly = coverage.missing.length > 0 &&
    coverage.unresolved.length === coverage.missing.length;
  if (node.type === "planning") {
    answer.plans = parsePlans(output);
    const count = node.planning?.optionsCount ?? 3;
    if (
      answer.plans.length !== count ||
      !answer.plans.every((p, i) => p.id === i + 1 && p.body.length > 0)
    )
      return fail(`완전한 계획 선택지 ${count}개가 순서대로 필요합니다.`);
    if (
      answer.plans.some((p) => requirements.some((r) => !p.body.includes(r.id)))
    )
      return fail("모든 계획 선택지에서 각 REQ ID를 다뤄야 합니다.");
  }
  if (node.type === "test") {
    const lines = [...output.matchAll(/^(?:\*\*|__)?VERDICT:\s*(PASS|FAIL)\b.*$/gim)];
    if (!lines.length) return fail("VERDICT: PASS 또는 FAIL 행이 필요합니다.");
    answer.verdict =
      lines.at(-1)![1]!.toUpperCase() === "PASS" && coverage.allSatisfied
        ? "PASS"
        : "FAIL";
    if (lines.at(-1)![1]!.toUpperCase() === "PASS" && !coverage.allSatisfied)
      answer.reason = `요구사항 증거가 부족합니다: ${coverage.unresolved.join(", ")}`;
    if (lines.at(-1)![1]!.toUpperCase() === "PASS" && missingOnly)
      return fail(`요구사항 증거 형식이 누락되었거나 잘못되었습니다: ${coverage.missing.join(", ")}. 기존 결과를 보존하고 모든 REQ의 올바른 증거 블록과 VERDICT를 포함한 전체 최종 보고를 다시 반환하세요.`);
  }
  if (node.type === "review" || node.type === "approval") {
    const lines = [...output.matchAll(/^(?:\*\*|__)?(APPROVED|REJECTED)\b.*$/gim)];
    if (!lines.length) return fail("APPROVED 또는 REJECTED 행이 필요합니다.");
    answer.verdict =
      lines.at(-1)![1]!.toUpperCase() === "APPROVED" && coverage.allSatisfied
        ? "APPROVED"
        : "REJECTED";
    if (
      lines.at(-1)![1]!.toUpperCase() === "APPROVED" &&
      !coverage.allSatisfied
    )
      answer.reason = `요구사항 증거가 부족합니다: ${coverage.unresolved.join(", ")}`;
    if (lines.at(-1)![1]!.toUpperCase() === "APPROVED" && missingOnly)
      return fail(`요구사항 증거 형식이 누락되었거나 잘못되었습니다: ${coverage.missing.join(", ")}. 기존 결과를 보존하고 모든 REQ의 올바른 증거 블록과 승인 판정을 포함한 전체 최종 보고를 다시 반환하세요.`);
  }
  if (answer.verdict === "PASS" || answer.verdict === "APPROVED") {
    const failed = failedVerificationCommand(commands);
    if (failed) {
      answer.verdict = node.type === "test" ? "FAIL" : "REJECTED";
      answer.reason = `관측된 검증 명령이 성공하지 않았습니다: ${failed.command} (exit ${failed.exitCode ?? "unknown"}).`;
      return answer;
    }
  }
  if (answer.verdict === "PASS") {
    const records = new Map(parseRequirementEvidence(output).map(r => [r.requirementId, r]));
    const unverified = requirements.filter(r => {
      const command = records.get(r.id)?.checkCommand;
      return !command || !commands.some(c => checkCommandKey(c.command) === checkCommandKey(command) && c.exitCode === 0 && !c.environmentError && isVerificationCommand(c.command));
    });
    if (!commands.some(c => c.exitCode === 0 && isVerificationCommand(c.command)) || unverified.length)
      return fail(`관측된 성공 검증 명령이 필요합니다 (${unverified.map(r => r.id).join(", ")}). 각 요구사항 블록에 CHECK_COMMAND: 실제 실행 명령을 적으세요. 설명이나 저장된 로그 파일만으로 PASS를 판정할 수 없습니다.`);
  }
  if (answer.verdict === "APPROVED" && !priorTestProof.some(c => c.exitCode === 0 && !c.environmentError && isVerificationCommand(c.command))) {
    answer.verdict = "REJECTED";
    answer.reason = "현재 구현에 대한 테스트 역할의 관측된 PASS 기록이 없습니다. 검증을 실행한 뒤 승인해야 합니다.";
  }
  return answer;
}
