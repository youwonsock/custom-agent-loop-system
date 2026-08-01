# Agent Loop Orchestrator

VS Code controls the Custom Agent Loop System: an autonomous, multi-role coding
loop in which implementation, testing, QA, and final approval agents
cross-check one another until the configured goal is complete.

## Version 3.2

- Configure any number of stages and specialized roles in
  `agent_pipeline.json`.
- Assign each role to a built-in model slot or an explicit model/variant.
- Configure success/failure transitions, iteration boundaries, and optional
  plan approval.
- Review complete plan options as rendered Markdown previews in the center editor while
  the Plan Review sidebar stays focused on option selection, revision, and
  approval controls.
- Inspect the active attempt, reconnect state, last meaningful progress,
  retry time, failure category, and owner lease from the dashboard.
- Recover stale `RUNNING` sessions after abnormal shutdown and automatically
  resume due `RECOVERING` sessions.
- Gracefully stop active sessions during normal VS Code shutdown.
- Queue concurrent Stop and Interrupt requests without overwriting them.
- Use Codex-style filesystem access controls: **Ask when needed** enters `WAITING_USER` with a
  concrete approval request, while **Full access** can be granted per session.
- Reserve `PAUSED` for repeated token-consuming non-convergence. Transient
  token-free failures use delayed `RECOVERING`; explicit Stop uses `STOPPED`;
  unsafe orphan ownership uses `BLOCKED`.

Use **Agent Loop: Open Pipeline Configuration** to open the root pipeline file,
or set `agentLoop.pipelineConfigPath` to another JSON file.

## Requirements

- Node.js 18 or newer.
- A built core at `<rootDir>/dist/loop_orchestrator.js`.
- An authenticated coding CLI (`opencode` or `kilo` by default).

The extension blocks session startup when core TypeScript sources are newer
than `dist` and tells you to run `npm run build`.

## Main settings

- `agentLoop.rootDir`
- `agentLoop.orchestratorScript`
- `agentLoop.pipelineConfigPath`
- `agentLoop.cliBinary`
- `agentLoop.cliProfile`
- `agentLoop.maxIterations`
- `agentLoop.phaseTimeoutMs`
- `agentLoop.transportTimeoutMs`
- `agentLoop.idleTimeoutMs`
- `agentLoop.toolTimeoutMs`
- `agentLoop.phaseRecoveryBudgetMs`
- `agentLoop.maxAgentAttempts`
- `agentLoop.maxCompletionRecoveryAttempts`
- `agentLoop.maxAutomaticRecoveryCycles`
- `agentLoop.automaticRecoveryBackoffMs`
- `agentLoop.retryBackoffMs`
- `agentLoop.heartbeatIntervalMs`
- `agentLoop.leaseTtlMs`
