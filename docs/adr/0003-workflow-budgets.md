# ADR 0003: Workflow budget semantics

- Status: Proposed
- Date: 2026-08-08

## Decision

Keep three separate counters:

- `maxCycles`, `cyclesStarted`, and `cyclesCompleted` represent user-visible implementation-to-verification cycles.
- `maxWorkflowSteps` and `workflowStepsConsumed` are the hard fuse that bounds every automatic graph.
- `maxAgentAttempts` bounds retries within one stage activation.

A workflow step and any new cycle are durably reserved immediately before dispatch. Re-entering a stage through the graph consumes another workflow step; retrying the same activation consumes only an attempt. Waiting-state polling consumes no budget.

`cyclesCompleted` is an observation and is never the sole termination guard. Budget exhaustion produces `PAUSED/BUDGET_EXHAUSTED` and permits no further automatic spawn.

If a crash leaves a mutation-capable provider attempt with an unknown outcome, the attempt remains charged and the session pauses for reconciliation instead of replaying it automatically.

