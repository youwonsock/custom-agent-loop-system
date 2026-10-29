import { AgentGraphDocument, LocalConnection } from "../shared/domain";

/**
 * Runtime decisions derived from a graph's opt-in automation flags and the
 * CLI bound to the current node. Graph validation and the editor keep using
 * the raw flags; only the orchestrator's combined decisions live here.
 */
export interface RunPolicy {
  /** Any automation preset is enabled. */
  automated: boolean;
  testSourceGuard: boolean;
  verificationContract: boolean;
  reserveFinalizationBudget: boolean;
  nativeApprovalReview: boolean;
  guardOwnedProcesses: boolean;
  /** Codex local HTTP for browser verification (proxy-restricted to loopback). */
  localHttpAccess: boolean;
  /** Kilo native filesystem tools restricted to the target roots. */
  kiloScopeGuard: boolean;
  /** Kilo tool programs confined to an isolated VM. */
  kiloProgramIo: boolean;
}

export function runPolicy(
  graph: Pick<AgentGraphDocument, "automation">,
  connection?: Pick<LocalConnection, "type">,
): RunPolicy {
  const a = graph.automation;
  return {
    automated: !!a,
    testSourceGuard: !!a?.testSourceGuard,
    verificationContract: !!a?.verificationContract,
    reserveFinalizationBudget: !!a?.reserveFinalizationBudget,
    nativeApprovalReview: !!a?.nativeApprovalReview,
    guardOwnedProcesses: !!a?.guardOwnedProcesses,
    localHttpAccess: connection?.type === "codex" && !!a?.browserVerification,
    kiloScopeGuard: connection?.type === "kilo" && !!a?.targetScopeGuard,
    kiloProgramIo: connection?.type === "kilo" && !!a?.programIoGuard,
  };
}
