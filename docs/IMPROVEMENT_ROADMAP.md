# Improvement roadmap

This roadmap evolves the existing TypeScript orchestrator without replacing its provider-process,
security, or recovery guarantees. Framework adoption is a later evidence-based decision, not a
prerequisite for the architecture work.

- Last reviewed: 2026-08-15
- Baseline package version: 3.4.1

## Decision summary

- Keep `ProcessSupervisor`, provider adapters, access controls, completion contracts, and recovery
  behavior as product-owned capabilities.
- Make workflow orchestration replaceable behind explicit interfaces before evaluating another
  workflow runtime.
- Keep one authoritative per-session aggregate. Do not introduce a second checkpoint authority.
- Preserve existing CLI, VS Code extension, config, and state compatibility while extracting
  boundaries.
- Evaluate LangGraph.js only after the workflow and repository boundaries are stable.
- Do not adopt CrewAI as the core runtime. Reconsider it only for an optional stage that has a
  demonstrated need for autonomous delegation and can justify a Python runtime boundary.

## Planning principles

1. **Characterize before moving code.** A refactor PR must not also redefine runtime behavior.
2. **One authority, one writer protocol.** Snapshots, WAL records, the session index, and extension
   views are representations or projections of one aggregate, not competing state stores.
3. **Reserve before dispatch.** Workflow steps, cycles, and attempts are charged durably before a
   provider can perform side effects.
4. **Unknown mutation outcomes are not replayed automatically.** They require reconciliation.
5. **Migrate explicitly.** State/config migrations are versioned, idempotent, backed up, and never
   performed against a live leased session.
6. **Fail closed at capability boundaries.** Unsupported read-only, MCP, sandbox, or path guarantees
   prevent provider launch.
7. **Keep framework experiments outside the critical path.** No production dependency is added
   until the same crash, security, packaging, and compatibility tests pass.

## Historical baseline before Milestone 0

- The core TypeScript typecheck passed.
- The core test suite contained 113 passing tests.
- Pipeline roles and transitions were configurable, but stage behavior was selected by a
  built-in executor switch.
- Session state was atomically written under a short file lock and active execution was protected
  by a lease, but commits did not use aggregate revision CAS and owner fencing epochs.
- The mutable legacy root was rejected when it was inside a provider write root, but the full
  `RootSet` model was not implemented.
- `maxIterations` and per-stage attempt recovery existed, but there was no durable hard fuse
  covering every automatic workflow step.

This baseline was captured with 3.4.0 and 3.4.1 state/config fixtures before state-format changes
began.

## Current verified baseline after Milestone 8

- The core suite has 174 passing tests with 83.32% line, 71.18% branch, and 82.33% function
  coverage.
- The extension suite has 40 passing tests with 86.36% line, 69.82% branch, and 84.21% function
  coverage, plus a real Extension Host lifecycle test.
- Revision CAS, owner fencing, WAL recovery, immutable artifacts, explicit `RootSet` boundaries,
  compiled workflow invariants, and separate durable execution budgets are implemented.
- CI builds one npm candidate and four native VSIX candidates, tests those exact bytes, and makes
  the protected provider matrix and provenance verification mandatory for promotion.

## Security hotfix release lane

Release-blocking security fixes must not wait for the architectural milestones. This lane may run
in parallel with M0 and M1, but it must remain compatibility-preserving and complete before M2-M4
state or protocol migrations ship.

1. Restore a green, pinned CI baseline and retain 3.4.0/3.4.1 fixtures.
2. Gate every extension process launch on Workspace Trust and remove automatic extension-side
   provider discovery.
3. Validate control identifiers and paths, quarantine malformed requests, preserve explicit path
   dialect handling, and reject a mutable root inside the project.
4. Fail closed for read-only capabilities a provider cannot enforce, disable generic automatic
   confirmation, and redact every resolved secret.
5. Make extension spawn/stop state truthful, isolate log buffers by session, and namespace secrets
   by data/config identity.
6. Build the candidate artifact once, unpack and test its bundled core and native PTY, and promote
   that exact artifact only after every declared Tier-1 target passes.

This lane does not migrate state, introduce a journal, add a workflow framework, or change the
documented session-authority model. Deeper conformance and isolation work remains in M5.

## Dependency order

```text
M0 Baseline and characterization
  -> M1 Compatibility-preserving seams
  -> M2 RootSet and shared contracts
  -> M3 Authoritative session repository
  -> M4 Compiled workflow and durable budgets
  -> M5 Provider capability and process isolation
  -> M6 Structured outcomes, events, and extension integration
  -> M7 Framework evaluation
  -> M8 Release hardening and promotion
```

M2 contract work and pure M4 graph-analysis prototypes may be developed in parallel after M1, but
durable budget reservation must not ship before M3 provides revisioned repository commits.

## Milestone 0: baseline and characterization

### Scope

1. Preserve representative legacy state and config fixtures, including RUNNING, WAITING_USER,
   RECOVERING, STOPPED, BLOCKED, and SUCCESS sessions.
2. Add characterization tests for every built-in executor and transition outcome.
3. Add fault-injection coverage at these boundaries:
   - immediately before provider spawn;
   - after durable attempt reservation but before spawn;
   - after a mutation-capable provider starts but before a completion result is committed;
   - while a phase result is committed;
   - during lease expiry and concurrent resume;
   - during plan/access approval while an owner is active.
4. Record package, VSIX, startup, peak-memory, and representative pipeline timing baselines.
5. Add an ADR defining module boundaries and confirming that the session aggregate is the only
   workflow state authority.

### Exit gate

- Existing and new characterization tests pass on the supported development OS.
- No user-visible behavior, state schema, CLI flag, or extension protocol changes.
- Each crash point has an explicit expected state and replay policy.

## Milestone 1: compatibility-preserving seams

This milestone moves behavior without redesigning it. It must precede the larger state and graph
changes; otherwise those changes would add more responsibilities to the current monolith.

### Deliverables

1. Introduce pure domain types for `LoopState`, `StageOutcome`, `TransitionDecision`, and failure
   classifications.
2. Introduce these interfaces with adapters backed by the current implementation:
   - `StageExecutor`;
   - `WorkflowEngine`;
   - `AgentRuntime`;
   - `SessionRepository`;
   - `ControlRepository`.
3. Replace the stage executor switch with a registry while preserving the six built-in executor
   semantics.
4. Extract one executor per PR in this order: planning, interrupt, test, review, approval,
   implementation. Mutation-capable implementation moves last.
5. Move CLI parsing/composition, graph transitions, stage behavior, provider execution, persistence,
   and reporting into separate modules.
6. Keep compatibility exports until all tests and the extension use the new modules directly.

### Constraints

- No state-schema migration.
- No provider argument changes.
- No completion-contract format changes.
- No new workflow framework dependency.

### Exit gate

- The orchestrator entry point contains composition and lifecycle control, not stage-specific
  business logic.
- Every executor and transition rule is independently unit-testable.
- Existing CLI, package, VSIX, and state fixtures remain compatible.

## Milestone 2: RootSet and shared contracts

Implement [ADR 0001](adr/0001-root-and-trust-boundaries.md) and the applicable path rules from
[ADR 0002](adr/0002-path-policy.md).

### Deliverables

1. Resolve explicit `codeRoot`, `configRoot`, `projectRoot`, and `dataRoot` values.
2. Use explicit CLI/extension input followed by an OS application-data default. Remove discovery
   from the current working directory, workspace files, or registry presence.
3. Keep `--root` as a deprecated compatibility input with warnings and an explicit migration path.
4. Define shared core/extension schemas for paths, provider capabilities, control messages, and
   protocol versions.
5. Add a core capability/version handshake before the extension can launch a process.
6. Implement explicit path dialect handling and reject unsupported device paths, ADS, reserved
   names, and non-local data roots.
7. Build an idempotent migration command that copies through staging, validates checksums and
   schemas, atomically promotes within `dataRoot`, and writes a migration manifest.

### Exit gate

- No mutable control or session data is placed under a provider write root.
- A live leased session is never migrated or taken over.
- Legacy `--root` sessions remain readable through the documented compatibility path.
- Core and extension reject protocol/capability mismatches before provider spawn.

## Milestone 3: authoritative session repository

Implement [ADR 0004](adr/0004-session-state-authority.md) before adding durable workflow budgets.

### Deliverables

1. Store a monotonic aggregate revision and owner fencing epoch with every commit.
2. Implement `commit(nextState, expectedRevision, fencingEpoch)` with compare-and-swap semantics.
3. Persist the highest valid complete record using an atomic snapshot plus a bounded recovery WAL.
4. Keep plans and other large artifacts as immutable, hash-addressed blobs referenced by the
   aggregate.
5. Replace `sessions_registry.json` authority with a rebuildable `sessions_index.json` projection.
6. Quarantine corrupt aggregate data and mark the session BLOCKED; never synthesize empty state.
7. Make STOP, INTERRUPT, approvals, and permitted offline updates idempotent by request ID.
8. Route extension offline writes through repository transactions and online writes through the
   control queue owned by the fenced core.
9. Provide versioned, idempotent state migration with backup and validation before promotion.

### Rollout rule

Use read-old/migrate/write-new, not indefinite dual-write. Once a session is promoted to the new
aggregate version, only the repository writes it. The backup remains available for operator-led
rollback, but it is not a second live authority.

### Exit gate

- A stale owner cannot commit after a new fencing epoch is issued.
- The latest valid revision survives interruption at every repository fault-injection point.
- The session index is fully rebuildable from aggregates.
- Concurrent extension/core updates are serialized or rejected with a revision conflict.

## Milestone 4: compiled workflow and durable budgets

Implement [ADR 0003](adr/0003-workflow-budgets.md).

### Pipeline compiler

Compile and freeze a validated graph snapshot when a session is created. Validate:

- required stages and terminal reachability;
- unreachable stages;
- transitions to unknown targets;
- strongly connected components that can run without consuming a workflow step or cycle;
- paths that can reach SUCCESS without the configured approval gate;
- mutation executors assigned to read-only roles;
- stage-type and completion-contract compatibility;
- the existence of a bounded route to PAUSED, BLOCKED, or SUCCESS from every reachable stage.

Existing sessions continue to use their stored validated graph snapshot. Editing config files must
not silently change a live session.

### Durable budgets

1. Replace overloaded iteration counting with:
   - `maxCycles`, `cyclesStarted`, and `cyclesCompleted`;
   - `maxWorkflowSteps` and `workflowStepsConsumed`;
   - `maxAgentAttempts` per stage activation.
2. Reserve a workflow step, a new cycle when applicable, and an attempt before provider dispatch.
3. Treat retrying one activation as a new attempt but not a new workflow step.
4. Charge re-entry through a graph edge as another workflow step.
5. Do not charge waiting-state polling.
6. Produce `PAUSED/BUDGET_EXHAUSTED` before any spawn that would exceed a limit.
7. Pause for reconciliation when a crash leaves a mutation-capable attempt outcome unknown.

### Exit gate

- A custom non-counting cycle cannot execute indefinitely.
- No automatic spawn occurs without a committed reservation.
- Crash recovery never refunds an uncertain mutation attempt.
- Legacy `maxIterations` values migrate deterministically to the documented cycle policy.

## Milestone 5: provider capability and process isolation

### Deliverables

1. Replace adapter-name assumptions with an explicit provider capability model covering:
   - read-only sandboxing;
   - workspace writes and additional write roots;
   - CLI session resume;
   - web search modes;
   - MCP isolation and tool side-effect classification;
   - process-tree containment;
   - structured event support.
2. Reject unsupported role/provider/capability combinations before spawn.
3. Add read-only/write/unknown side-effect metadata to MCP tools; expose only enforceable tools to
   read-only roles.
4. Keep Codex read-only disabled until an isolated configuration home can exclude inherited MCP
   servers and authenticated conformance tests pass.
5. Unify provider launch and descendant containment through `AgentRuntime` and
   `ProcessSupervisor`.
6. Add raw-log backpressure, slow-filesystem, finalization-failure, and descendant-escape tests.
7. Run authenticated sandbox conformance tests for every supported provider and Tier-1 OS.

### Exit gate

- Unsupported security guarantees fail closed before provider launch.
- No unknown or destructive prompt receives an affirmative automatic response.
- No exact secret sentinel appears in arguments, output, state, logs, temporary files, or
  diagnostics.
- Mutation by a read-only role is prevented by the provider boundary and rejected by completion
  validation as defense in depth.

## Milestone 6: structured outcomes, events, and extension integration

### Deliverables

1. Introduce a versioned `StageOutcome` envelope containing status, decision, requirement evidence,
   artifacts, and failure details.
2. Keep `[PHASE_DONE]`, verdict, and approval text parsing as a compatibility fallback until every
   supported provider passes structured-output conformance tests.
3. Emit bounded domain events such as workflow/stage/attempt started, progressed, completed,
   paused, resumed, and failed.
4. Derive progress summaries and the extension timeline from domain events and aggregate state,
   not from raw terminal text.
5. Surface remaining cycle, workflow-step, attempt, and recovery budgets in the CLI and extension.
6. Add Extension Host end-to-end tests for trust transitions, plan/access approval, Stop/Interrupt,
   crash recovery, settings changes, and SecretStorage migration.

### Exit gate

- Operators can identify the current stage, active attempt, next permitted action, and pause reason
  without inspecting raw logs.
- Event retention is bounded and events are not a second state authority.
- Structured outcomes and legacy completion contracts produce identical transition decisions in
  compatibility tests.

## Milestone 7: framework evaluation gate

Framework adoption starts only after M1-M6 interfaces and invariants are stable.

### LangGraph.js spike

Implement a non-production `WorkflowEngine` adapter that reuses the existing `StageExecutor`,
`AgentRuntime`, and `SessionRepository`. Run the same transition, crash, replay, security, packaging,
and extension integration tests against both engines.

Adopt LangGraph.js only if all of these are true:

- the session aggregate remains the sole state authority, or LangGraph cleanly becomes that
  authority without duplicate checkpoints;
- mutation-capable stages are never replayed automatically after an unknown outcome;
- provider processes, leases, budgets, and control requests retain existing guarantees;
- the adapter removes meaningful custom orchestration code instead of adding a parallel state
  machine;
- VSIX bundling and every Tier-1 OS pass;
- measured startup, memory, and representative workflow regressions stay within the accepted CI
  performance budget;
- tracing, subgraphs, parallelism, or ecosystem integration provide a documented product benefit.

If any state-authority or unsafe-replay condition fails, reject the integration regardless of
developer-experience benefits.

### CrewAI gate

Do not evaluate CrewAI for the core runtime. Approve an optional subprocess-stage spike only when a
concrete use case requires autonomous delegation inside one bounded stage and accepts:

- a Python runtime and packaging boundary;
- explicit TypeScript/Python cancellation and result protocols;
- the existing TypeScript core retaining session, process, security, and budget authority;
- no direct CrewAI writes to core session data.

### Evaluation result (2026-08-16)

Milestone 7 is complete with a **retain-current-engine** decision. The isolated LangGraph.js 1.4.10
adapter passed transition, authority, crash/replay, fencing, and extension-projection conformance,
but removed no production orchestration code, exceeded the performance budget, and its current peer
stack raises the runtime floor from Node 18 to Node 20. CrewAI remains deferred because no concrete
bounded stage currently requires autonomous inner-agent delegation. See
[ADR 0006](adr/0006-framework-evaluation.md) and run `npm run evaluate:langgraph` to reproduce the
spike report.

## Milestone 8: release hardening and promotion

1. Pin third-party GitHub Actions to immutable commit SHAs with automated update review.
2. Build each target artifact once, then unpack and test that exact artifact, including bundled core
   and native PTY lifecycle.
3. Add a tag/manual promotion workflow that promotes tested artifacts without rebuilding.
4. Generate and verify checksums, SBOMs, signatures, or attestations before publication.
5. Apply core and extension coverage thresholds and execute the protected Windows/Linux/macOS
   matrix before promotion.
6. Reverify the minimum declared Node.js runtime on every packaged target.
7. Require an explicit unsafe-mode disclosure until full-access providers run under a separate OS
   identity or enforceable native deny boundary.

### Implementation result (2026-08-16)

Milestone 8 is implemented. CI pins Actions by SHA, applies core and extension coverage thresholds,
builds one npm candidate plus four native VSIX candidates, tests the exact artifacts and native PTY
on their Tier-1 targets including Node 18, and emits checksums, digest-bound CycloneDX SBOMs,
source-commit manifests, and push-run attestations. Promotion downloads a successful push CI bundle,
requires the protected 24-report provider matrix for the same commit, verifies all evidence, and
publishes without rebuilding. Full access now has CLI disclosure and extension modal confirmation.
See [ADR 0007](adr/0007-build-once-artifact-promotion.md) and
[the release guide](RELEASE.md).

## Cross-cutting verification matrix

Every milestone must select the applicable rows and record evidence in CI:

| Area | Required verification |
|---|---|
| Compatibility | Legacy config/state fixtures, CLI flags, extension protocol, migration rollback |
| Workflow | Transition, approval bypass, cycle analysis, budget reservation, resume |
| Recovery | Crash injection, stale owner, orphan child, unknown mutation outcome |
| Security | Path containment, workspace trust, provider sandbox, MCP capabilities, secret sentinel |
| Process | PTY startup, progress, timeout classification, termination, log finalization |
| Packaging | npm package, VSIX contents, native PTY, generated defaults, checksums |
| Performance | Startup, peak memory, state commit latency, long-output backpressure |

A regression above 10% in a recorded performance baseline requires an explicit reviewed waiver or a
fix before promotion. Correctness and security gates cannot be waived through this mechanism.

Use deterministic fake-provider scenarios for relative CI performance checks. Record at least five
post-warmup runs and compare medians in the same job environment; authenticated provider timings are
diagnostic evidence, not a release threshold.

## Risk register

| Risk | Likely failure | Mitigation and stop condition |
|---|---|---|
| Big-bang orchestrator split | Behavior changes are hidden by file movement | One executor per PR; implementation moves last; stop if characterization parity is lost |
| Dual state authority | Resume selects conflicting checkpoints | Repository is authoritative; no indefinite dual-write; stop framework work if this cannot hold |
| Migration data loss | Existing sessions become unreadable | Idempotent staging, schema/checksum validation, backup, manifest, and live-lease refusal |
| Unknown mutation replay | Provider edits are applied twice | Persist reservation before spawn and pause for reconciliation after an unknown outcome |
| Core/extension version skew | Old extension sends unsafe or incompatible requests | Capability/version handshake and backward-compatibility fixtures before launch |
| Provider CLI drift | Sandbox or event assumptions silently stop holding | Authenticated capability conformance, pinned tested ranges, and fail-closed unknown versions |
| Native PTY platform drift | Packaged process lifecycle differs from source tests | Test the exact VSIX/npm artifact on every Tier-1 OS before promotion |
| Framework scope creep | A spike becomes a second production runtime | M7 entry criteria, time-boxed adapter, no production dependency, explicit adopt/reject ADR |

## Global release gates

- No untrusted-workspace process launch.
- No internal path escape or malformed control request execution.
- No mutable session/control root inside a provider write root.
- No stale owner commit after fencing changes.
- No automatic provider spawn without a durable workflow/attempt reservation.
- No automatic replay of an unknown mutation-capable attempt.
- No path to SUCCESS that bypasses the required independent approval gate.
- No read-only mutation for supported provider profiles; unsupported profiles fail closed.
- No affirmative answer to an unknown or destructive prompt.
- No exact secret sentinel in arguments, output, state, logs, temporary files, or diagnostics.
- Native installed-artifact PTY lifecycle succeeds for every declared Tier-1 target.
- Tested artifacts are promoted without rebuilding.

## Completed implementation sequence

Implementation followed the planned dependency order: characterization and module boundaries,
domain seams and executor extraction, shared root/protocol contracts, the revisioned repository and
WAL, the pipeline compiler and durable budgets, provider hardening, extension integration, framework
evaluation, and finally artifact promotion. Future changes should continue to have one primary
architectural purpose and include a rollback or compatibility note whenever they change persisted
data, provider invocation, or the extension protocol.

## Deferred and explicit non-goals

- General event sourcing: the bounded WAL stores complete recovery records only.
- Exactly-once semantics for third-party provider or remote MCP side effects after host failure.
- Claiming full-access isolation while a child runs as the same unrestricted OS user.
- Replacing provider/process supervision with an agent framework.
- Installing LangGraph.js or CrewAI before the framework evaluation gate.
