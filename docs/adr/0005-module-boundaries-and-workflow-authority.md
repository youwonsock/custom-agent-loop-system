# ADR 0005: Module boundaries and workflow authority

- Status: Accepted
- Date: 2026-08-16

## Context

The current orchestrator combines CLI composition, workflow dispatch, stage-specific behavior,
provider execution, process supervision, persistence, recovery, and reporting in one module. The
system has strong provider-process and safety behavior, but those responsibilities are difficult to
change independently and make a workflow-framework experiment likely to create a second state
machine.

The refactor needs stable boundaries before `RootSet`, revisioned persistence, durable workflow
budgets, or another workflow runtime can be introduced. It must also preserve the existing CLI,
extension protocol, provider invocation, completion contracts, and version-2 session fixtures while
the boundaries are extracted.

## Decision

Use six dependency layers, wired by a small composition root:

1. **Domain** owns serializable state and outcome types. It has no filesystem, process, provider, or
   UI dependencies.
2. **Workflow** validates the stored graph and maps a prior state plus `StageOutcome` to a
   `TransitionDecision`. It does not spawn providers or persist state.
3. **Stage executors** prepare stage-specific input and interpret successful agent output. They do
   not select the next stage or write authoritative session state.
4. **Agent runtime** resolves provider capabilities and executes one bounded attempt through the
   existing provider adapters and `ProcessSupervisor`. It does not own workflow transitions.
5. **Session and control repositories** are the only durable-write boundary. The session repository
   commits the authoritative aggregate; control requests are idempotent inputs to the active owner.
6. **Interfaces** such as the CLI and VS Code extension invoke the composition root and render
   aggregate state or derived events. They do not mutate session files directly.

The intended interfaces are:

```ts
interface StageExecutor {
  execute(context: StageContext): Promise<StageOutcome>;
}

interface WorkflowEngine {
  next(state: LoopState, outcome: StageOutcome): TransitionDecision;
}

interface AgentRuntime {
  executeAttempt(request: AttemptRequest): Promise<AttemptOutcome>;
}

interface SessionRepository {
  load(sessionId: string): Promise<SessionAggregate>;
  commit(
    next: SessionAggregate,
    expectedRevision: number,
    fencingEpoch: number
  ): Promise<SessionAggregate>;
}
```

These are architectural contracts. Their initial adapters may delegate to the current
implementation so extraction can proceed without a state-schema or behavior change.

## State authority

The per-session aggregate is the only logical workflow authority, consistent with
[ADR 0004](0004-session-state-authority.md). In particular:

- a workflow engine may calculate transitions but cannot maintain an independent durable
  checkpoint history;
- domain events, room files, logs, plans, and the session index are artifacts or projections, not
  competing workflow state;
- an active fenced core is the only online aggregate writer;
- a provider process never writes Agent Loop session or control data;
- a mutation-capable attempt with an unknown outcome is not safe to replay automatically.

Any future LangGraph.js adapter must either use the session repository as its checkpoint authority
or replace that authority completely after compatibility and recovery proof. Running LangGraph
checkpoints beside the aggregate as a second source of truth is rejected. CrewAI is not a core
runtime dependency; a future CrewAI integration may only execute as a bounded optional stage behind
`AgentRuntime` and cannot write session state directly.

## Extraction sequence

1. Add characterization tests and current-behavior adapters.
2. Replace the executor switch with a registry.
3. Extract planning and interrupt first because they do not mutate the target project.
4. Extract test, review, and approval.
5. Extract implementation last.
6. Remove compatibility exports only after the core and extension use the new boundaries.

Each extraction PR has one primary purpose and does not also change persisted formats, provider
arguments, completion contracts, or transition policy.

## Verification

- The complete built-in stage/role/executor/contract/transition table is characterized.
- User-waiting and recovery normalization rules are characterized.
- Existing provider, PTY, lease, completion, integration, package, and extension tests remain green.
- Later repository and budget milestones add crash injection around reservation, spawn, side-effect,
  and commit boundaries before changing replay policy.

## Consequences

The refactor gains independently testable workflow, executor, runtime, and repository seams and can
evaluate another workflow engine without replacing provider supervision. During migration, adapter
layers and compatibility exports add temporary code. Some existing helpers must remain in the
composition module until their owning layer is clear; moving code is incremental rather than a
single large rewrite.

