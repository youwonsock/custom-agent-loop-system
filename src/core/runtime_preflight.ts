import { AgentNode, NodeVisit } from "../shared/domain";
import { isAuditRole, isReadOnly, isVerifierRole } from "../shared/node_roles";
import { deliverableProblem } from "./deliverables";
import { messageOf } from "./errors";
import { runPolicy } from "./run_policy";
import { GateHost } from "./runtime_gates";
import {
  Completed,
  Stopped,
  completed,
  failedPreparation,
} from "./runtime_steps";
import { currentVerificationSources, testSources } from "./test_source_guard";
import {
  lockContract,
  verificationRunnerProblem,
} from "./verification_contract";
import { productionHashes } from "./verification_sources";

/** What must hold before a node's CLI starts. Ready carries its source snapshot. */
export async function preflight(
  host: GateHost,
  node: AgentNode,
  visit: NodeVisit,
): Promise<
  | Stopped
  | Completed
  | { step: "ready"; sourceInputs: Record<string, string> | null }
> {
  const policy = runPolicy(host.state.graph),
    sourceGuard = policy.testSourceGuard;
  if (sourceGuard && isAuditRole(node.type)) {
    const expected = currentVerificationSources(host.state, visit);
    if (!expected)
      return completed(
        host.verificationFailure(
          node,
          "현재 테스트 역할의 고정 소스 snapshot이 없습니다. 구현과 전체 테스트를 다시 수행해야 합니다.",
        ),
      );
    const changed = await host.sourceChanges(expected);
    if (changed.length)
      return completed(
        host.verificationFailure(
          node,
          `테스트 이후 소스가 변경되어 증거를 무효화했습니다: ${changed.join(", ")}. 구현과 모든 등록 검사를 다시 수행해야 합니다.`,
        ),
      );
  }
  if (
    policy.verificationContract &&
    node.type === "test" &&
    host.state.verificationContract?.status !== "locked"
  ) {
    try {
      host.state.verificationContract = await lockContract(
        host.state,
        "implementation",
      );
      await host.save();
    } catch (error) {
      return completed(
        failedPreparation(
          `검증 계약 준비 실패: ${messageOf(error)}`,
          `검증 계약 준비 실패: ${messageOf(error)}\n구현 역할에서 .agent-graph/verification.json과 인수 검사를 준비하세요.`,
        ),
      );
    }
  }
  if (node.type === "test") {
    const problem = await verificationRunnerProblem(host.state);
    if (problem)
      return completed(
        failedPreparation(
          problem,
          `검증 runner 준비 실패: ${problem}\n구현 역할에서 필수 runner를 수정한 뒤 다시 검증하세요.`,
        ),
      );
  }
  if (isVerifierRole(node.type)) {
    const problem = await deliverableProblem(host.state);
    if (problem) return completed(host.verificationFailure(node, problem));
  }
  // Audit roles under the source guard are compared with the test role's snapshot.
  const watchReadOnly =
    isReadOnly(node.type) && !(sourceGuard && isAuditRole(node.type));
  if (!policy.automated || (node.type !== "test" && !watchReadOnly))
    return { step: "ready", sourceInputs: null };
  try {
    return {
      step: "ready",
      sourceInputs:
        sourceGuard || watchReadOnly
          ? await testSources(host.state.targetProjectPath)
          : await productionHashes(host.state.targetProjectPath),
    };
  } catch (error) {
    return host.halt(
      visit,
      "WAITING_USER",
      `검증 전 소스 읽기가 차단됐습니다. 경로·권한을 확인하세요: ${messageOf(error)}`,
      { pauseVisit: true, clearRecovery: false },
    );
  }
}
