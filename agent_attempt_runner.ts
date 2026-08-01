import { AttemptFailure } from "./resilience";

export interface RetryPolicySettings {
  maxAttempts: number;
  retryBackoffMs: number[];
}

export interface RetryDecision {
  retry: boolean;
  reconnect: boolean;
  delayMs: number;
  reason: string;
}

export interface RetryDecisionInput {
  failure: AttemptFailure;
  attemptNumber: number;
  budgetRemainingMs: number;
  cliSessionId: string | null;
  reconnectUsed: boolean;
  retryAfterMs?: number | null;
}

export class AgentAttemptRunner {
  constructor(
    private readonly settings: RetryPolicySettings,
    private readonly random: () => number = Math.random
  ) {}

  decideRetry(input: RetryDecisionInput): RetryDecision {
    if (!input.failure.retryable) {
      return { retry: false, reconnect: false, delayMs: 0, reason: "non_retryable" };
    }
    if (input.attemptNumber >= this.settings.maxAttempts) {
      return { retry: false, reconnect: false, delayMs: 0, reason: "attempts_exhausted" };
    }
    if (input.budgetRemainingMs <= 0) {
      return { retry: false, reconnect: false, delayMs: 0, reason: "budget_exhausted" };
    }

    const reconnect =
      !input.reconnectUsed &&
      Boolean(input.cliSessionId) &&
      ["network", "transport_timeout", "idle_timeout"].includes(input.failure.kind);
    const configured =
      input.failure.kind === "rate_limited"
        ? input.retryAfterMs ?? 30_000
        : this.settings.retryBackoffMs[
            Math.min(input.attemptNumber - 1, this.settings.retryBackoffMs.length - 1)
          ] ?? 5_000;
    const jittered = Math.max(0, Math.round(configured * (0.8 + this.random() * 0.4)));
    const capped =
      input.failure.kind === "rate_limited" ? Math.min(120_000, jittered) : jittered;
    return {
      retry: true,
      reconnect,
      delayMs: Math.min(input.budgetRemainingMs, capped),
      reason: reconnect ? "reconnect_existing_session" : "start_fresh_session",
    };
  }
}
