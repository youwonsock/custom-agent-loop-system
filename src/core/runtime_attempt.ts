import * as path from "node:path";
import { AttemptRecord, ModelPricing, SessionState } from "../shared/domain";
import { modelPricing } from "./model_pricing";
import { nodeTestScript } from "./node_test_policy";
import { buildNodePrompt } from "./prompt";
import { InvocationOptions, Stage } from "./runtime_steps";
import { StudioStore } from "./store";

export const sessionDeadline = (state: SessionState): number =>
  Date.parse(state.executionBudget.deadlineAt);

export function invocationOptionsFor(
  state: SessionState,
  store: StudioStore,
  { node, visit, connection, policy, deadline }: Stage,
  id: string,
  recoveryMessage: string | undefined,
  nextResume: string | undefined,
): InvocationOptions {
  const contract = state.verificationContract;
  return {
    prompt: buildNodePrompt(state, node, visit, recoveryMessage),
    cwd: state.targetProjectPath,
    fullAccess: state.accessMode === "full_access",
    allowedPaths: state.additionalAllowedPaths,
    nativeApprovalReview: policy.nativeApprovalReview,
    localHttpAccess: policy.localHttpAccess,
    testSourcesReadOnly: policy.automated && node.type === "test",
    guardOwnedProcesses: policy.automated,
    ...(policy.claudeUnattended
      ? {
          claudeUnattended: {
            browserVerification: policy.browserVerification,
          },
        }
      : {}),
    ...(policy.kiloScopeGuard
      ? {
          scopeRoots: [
            state.targetProjectPath,
            ...state.additionalAllowedPaths,
          ],
        }
      : {}),
    ...(policy.kiloProgramIo
      ? {
          programIoGuard: {
            directory: path.join(
              store.visitDir(state.id, visit.id),
              `${id}-io`,
            ),
            providerHome: path.join(
              store.sessionDir(state.id),
              "provider-home",
            ),
            protectedFiles: [
              ".agent-graph/verification.json",
              ...(contract?.manifest?.protectedFiles ?? []),
            ],
            expiresAt: Math.min(deadline, sessionDeadline(state)),
          },
        }
      : {}),
    ...(contract?.manifest?.nodeTests
      ? {
          verificationAliases: {
            [nodeTestScript(contract.manifest.nodeTests)]:
              contract.manifest.checks.find(
                (c) => c.id === contract.manifest!.nodeTests!.suiteCheckId,
              )!.command,
          },
        }
      : {}),
    ...(policy.verificationContract && contract?.status === "locked"
      ? {
          verificationCommands: contract.manifest!.checks.map((c) => c.command),
        }
      : {}),
    // A repeated write-schema failure on this CLI selects the bounded Kilo fallback.
    disableWrite: state.visits.some(
      (v) =>
        state.bindings[v.nodeId]?.connectionId === connection.id &&
        v.attempts.some(
          (a) =>
            a.failureKind === "tool_arguments" &&
            /for the "write" tool/.test(a.message ?? ""),
        ),
    ),
    ...(nextResume ? { resumeId: nextResume } : {}),
  };
}
export function newAttemptRecord(
  state: SessionState,
  store: StudioStore,
  pricing: ModelPricing | undefined,
  { visit, binding, deadline }: Stage,
  id: string,
  completionRecovery: boolean,
  nextResume: string | undefined,
): AttemptRecord {
  return {
    id,
    number: visit.attempts.length + 1,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    pid: null,
    cliSessionId: null,
    reconnectUsed: Boolean(nextResume),
    mode: completionRecovery ? "completion_recovery" : "standard",
    failureKind: null,
    message: null,
    logPath: path.join(store.visitDir(state.id, visit.id), `${id}.log`),
    lastProgressAt: null,
    activity: "initial_transport",
    deadlineAt: new Date(
      Math.min(
        Date.now() + state.settings.phaseTimeoutMs,
        deadline,
        sessionDeadline(state),
      ),
    ).toISOString(),
    requestedModelId: binding.modelId,
    actualModelId: null,
    pricing: pricing ?? modelPricing(),
    assistantTextBytes: 0,
    maxTokens: 0,
  };
}
