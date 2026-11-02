import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionBudget,
  sessionBudgetReason,
  pauseForBudget,
} from "./session_budget";
import { executionSettings, autonomousExecutionSettings } from "./settings";
import { SessionState } from "../../shared/domain";
import { observeCost } from "../verification/event_evidence";
import { prepareManualResume } from "./session_transitions";
test("whole-session deadlines and native attempts include report retries without renewal", () => {
  const settings = executionSettings({
    sessionTimeoutMs: 1000,
    maxSessionAttempts: 2,
  });
  const b = createSessionBudget(settings, 10000);
  const s = {
    settings,
    executionBudget: b,
    visits: [
      {
        id: "v",
        status: "running",
        attempts: [{ mode: "standard" }, { mode: "completion_recovery" }],
      },
    ],
    activeVisitId: "v",
    automaticRecovery: { count: 1, resumeAt: "later" },
    currentNodeId: "test",
    visitLimit: 100,
    iterationLimit: 20,
    completedIterations: 0,
  } as unknown as SessionState;
  assert.equal(sessionBudgetReason(s, false, 10500), null);
  assert.match(sessionBudgetReason(s, true, 10500)!, /2회/);
  assert.match(sessionBudgetReason(s, false, 11000)!, /시간/);
  pauseForBudget(s, "exhausted");
  assert.equal(s.status, "PAUSED");
  assert.equal(s.automaticRecovery, null);
  assert.equal(sessionBudgetReason(s), "exhausted");
  const copy = JSON.stringify(b);
  s.visits = [];
  s.activeVisitId = null;
  prepareManualResume(s, 20000);
  assert.equal(JSON.stringify(b), copy);
  assert.equal(autonomousExecutionSettings().maxAutomaticRecoveryCycles, 1);
  assert.equal(autonomousExecutionSettings().phaseTimeoutMs, 600000);
  const longer = autonomousExecutionSettings({ toolTimeoutMs: 1200000 });
  assert.equal(longer.toolTimeoutMs, 1200000);
  assert.equal(longer.phaseTimeoutMs, 1500000);
  assert.ok(longer.phaseRecoveryBudgetMs >= 3 * 1500000);
  assert.equal(
    autonomousExecutionSettings({ toolTimeoutMs: 60000 }).phaseTimeoutMs,
    600000,
    "a shorter limit leaves the window alone",
  );
  const explicit = autonomousExecutionSettings({
    phaseTimeoutMs: 1000,
    phaseRecoveryBudgetMs: 1200,
    transportTimeoutMs: 600,
    idleTimeoutMs: 600,
    toolTimeoutMs: 600,
    maxAgentAttempts: 1,
  });
  assert.equal(explicit.phaseTimeoutMs, 1000, "limits that fit stay as given");
  assert.equal(explicit.phaseRecoveryBudgetMs, 1200);
});
test("a spending limit stops on reported cost, and on any attempt with no cost", () => {
  const attempt = (costUsd?: number) => ({
    endedAt: "2026-11-02T00:00:00.000Z",
    ...(costUsd === undefined ? {} : { costUsd }),
  });
  const state = (attempts: unknown[], maxCostUsd: number | null) =>
    ({
      visits: [{ attempts }],
      executionBudget: {
        ...createSessionBudget(autonomousExecutionSettings()),
        maxCostUsd,
      },
    }) as unknown as SessionState;
  assert.equal(sessionBudgetReason(state([attempt(0.4)], 1)), null);
  assert.match(
    sessionBudgetReason(state([attempt(0.6), attempt(0.5)], 1))!,
    /\$1/,
  );
  assert.match(sessionBudgetReason(state([attempt()], 1))!, /보고하지 않은/);
  assert.equal(
    sessionBudgetReason(state([attempt()], null)),
    null,
    "no limit, nothing to know",
  );
  assert.equal(
    sessionBudgetReason(state([{ endedAt: null }], 1)),
    null,
    "a running attempt has nothing to report yet",
  );
});
test("cost comes from Claude's run total and from Kilo's steps", () => {
  assert.equal(observeCost({ type: "assistant" }, null), null);
  assert.equal(
    observeCost({ type: "result", total_cost_usd: 0.25 }, 0.1),
    0.25,
  );
  const step = { type: "step_finish", part: { cost: 0.5 } };
  assert.equal(observeCost(step, observeCost(step, null)), 1);
  assert.equal(
    observeCost({ type: "step_finish", part: {} }, null),
    null,
    "a step without a cost reports nothing",
  );
});
