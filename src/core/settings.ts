import defaults from "../../runtime_defaults.json";
import { ExecutionSettings } from "../shared/domain";
import { AppError } from "./errors";
export function executionSettings(
  overrides?: Partial<ExecutionSettings>,
): ExecutionSettings {
  const s: ExecutionSettings = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(s)) {
    if (key === "pollIntervalMs") continue;
    if (Array.isArray(value)) {
      if (!value.length || value.some((v) => !Number.isSafeInteger(v) || v < 1))
        throw new AppError(400, `${key}는 양수 지연 목록이어야 합니다.`);
    } else if (
      !Number.isSafeInteger(value) ||
      value <
        ([
          "maxAutomaticRecoveryCycles",
          "maxCompletionRecoveryAttempts",
        ].includes(key)
          ? 0
          : 1)
    )
      throw new AppError(400, `${key} 값이 잘못되었습니다.`);
  }
  if (
    s.maxIterations > 1000 ||
    s.maxAgentAttempts > 10 ||
    s.maxCompletionRecoveryAttempts > 3 ||
    s.maxAutomaticRecoveryCycles > 10
  )
    throw new AppError(400, "실행 횟수 한도를 초과했습니다.");
  if ((s.sessionTimeoutMs ?? 0) > 7*86400000 || (s.maxSessionAttempts ?? 0) > 10000)
    throw new AppError(400, "전체 실행 예산은 7일·10000회 이하이어야 합니다.");
  if (s.heartbeatIntervalMs >= s.leaseTtlMs)
    throw new AppError(400, "heartbeat 간격은 lease TTL보다 짧아야 합니다.");
  if (
    [s.transportTimeoutMs, s.idleTimeoutMs, s.toolTimeoutMs].some(
      (t) => t > s.phaseTimeoutMs,
    )
  )
    throw new AppError(400, "진행 timeout은 단계 timeout 이하여야 합니다.");
  if (
    s.maxInMemoryOutputBytes < 1024 ||
    s.maxInMemoryOutputBytes > 16 * 1024 * 1024
  )
    throw new AppError(400, "출력 보존 한도는 1KiB~16MiB이어야 합니다.");
  if (s.retryBackoffMs.length < s.maxAgentAttempts - 1)
    throw new AppError(400, "재시도 지연 수가 부족합니다.");
  if (
    s.phaseRecoveryBudgetMs <
    s.phaseTimeoutMs * s.maxAgentAttempts +
      Math.ceil(
        s.retryBackoffMs
          .slice(0, s.maxAgentAttempts - 1)
          .reduce((a, b) => a + b, 0) * 1.2,
      )
  )
    throw new AppError(
      400,
      "복구 예산은 모든 attempt와 재시도 지연을 포함해야 합니다.",
    );
  return s;
}

/** The tested web workflow profile, while legacy/manual defaults stay readable. */
export function autonomousExecutionSettings(overrides?: Partial<ExecutionSettings>): ExecutionSettings {
  return executionSettings({ maxIterations: 10, phaseTimeoutMs: 600000,
    toolTimeoutMs: 300000, phaseRecoveryBudgetMs: 1860000,
    maxAutomaticRecoveryCycles: 1, automaticRecoveryBackoffMs: [15000], ...overrides });
}
