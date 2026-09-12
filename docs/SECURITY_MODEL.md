# Security model

## Trust boundaries

- Target repositories, model output, provider events, tool output, and MCP responses are untrusted.
- Packaged core code, validated definitions, the composition root, and the configured data root are
  trusted control-plane inputs.
- Provider capabilities are adapter-owned facts; configuration cannot elevate them.
- The desktop renderer is a command client and read-only projection consumer, not state authority; the
  main process validates every bridge request before invoking core.

## Workflow authority

Only the v8 core can advance a workflow. The final assistant response must be one JSON object matching
`TaskResultEnvelopeV1`; the task payload schema, allowed signal, and guardrails are validated before an
effect mapper runs. Provider text, prompt echoes, tool events, and completion markers cannot directly
select transitions.

Effect mappers return a closed `DomainEffect` union and cannot import repositories or routers.
`RunReducer` is the sole aggregate mutation boundary. Results, effects, transition, activation
completion, and events are committed together under revision CAS and fencing checks.

For v8 definitions, a successful terminal additionally requires a core-owned verification proof,
the approved contract and baseline hashes, a clean process tree, and QA/master approvals that refer
to the same proof revision. Model output can report findings or feedback, but cannot create a proof
or mark convergence. A changed protected file, command, test, or execution policy creates a hashed
same-session reapproval candidate; stale request IDs and candidate hashes are rejected.

## Mutation and recovery

- A node activation and attempt are durably reserved before provider dispatch.
- Completed mutation tasks are never replayed to reconstruct state.
- A crash, stop, or interrupt with an ambiguous mutation outcome records `unknown_mutation`; automatic
  resume fails closed until an operator reconciles the workspace.
- A provider permission boundary may wait for explicit access approval and continue the same activation
  with a new recorded attempt.
- Verification commands run sequentially with bounded output and durable reserve/start/complete
  checkpoints. A normal non-zero exit is a recorded verification failure; timeout, interruption,
  tree-cleanup uncertainty, or an unknown mutation stops the remaining commands and fails closed.
- Workspace fingerprints include untracked files, content, type, and mode. A watcher is a conservative
  signal: an observed change or watcher error permanently invalidates the current proof.
- A project lease covers the target and approved additional roots across data roots; it is checked
  again before approvals, review, and success.
- Human-gate request IDs and control command IDs are idempotent.
- LangGraph checkpoint/replay is not used in production.

## Filesystem and access

- The mutable data root must be outside provider-writable project roots.
- Internal paths use validated identifiers, containment checks, and atomic writes.
- Read-only Agents require an enforceable provider/OS read-only mode; prose instructions are not an
  isolation boundary.
- Task tool policy can only narrow Agent policy.
- Full access runs with the host user's privileges and is explicitly not isolated from host data or the
  control plane.
- Symlink and realpath checks reduce path escapes but cannot defeat every same-user race without native
  OS isolation.

## Secrets

- Agent definitions and compiled bundles store secret references, never resolved values.
- Resolved values are passed only at runtime, registered with streaming redaction, and removed from the
  launch environment after use.
- Secrets must not appear in arguments, aggregate state, registry, projections, logs, artifacts, or
  diagnostics.
- Remote MCP credentials require HTTPS except for supported loopback development endpoints.
- Removed pre-v4 secret namespaces are rejected rather than migrated.

## Process and control safety

All provider processes pass through the supervised runtime, which owns bounded output, watchdogs,
interactive prompt handling, control polling, redaction, and process-tree termination. Stop and
interrupt commands use a durable per-run queue and are acknowledged only after the corresponding state
commit. Session ownership combines a lease with fencing epochs to prevent stale writers.

## Unsupported guarantees

- Exactly-once third-party or remote side effects after a host crash
- Isolation from a same-user full-access child process
- Protection from every symlink-swap or PID-reuse race without native primitives
- Detection of transformed or provider-retained secret copies
- Behavioral guarantees for untested future provider CLI versions

Authenticated provider checks are described in [Provider capability conformance](./PROVIDER_CONFORMANCE.md).
