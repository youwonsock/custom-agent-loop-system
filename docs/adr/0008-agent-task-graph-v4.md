# ADR 0008: Adopt the product-owned Agent/Task graph architecture

- Status: Accepted
- Date: 2026-08-16
- Product version: 4.0.0
- Supersedes: the implementation structure described by ADR 0005 and the spike shape in ADR 0006
- Note: the VS Code GUI delivery described in this ADR is superseded by ADR 0009; core protocol and
  state contracts remain in force.

## Context

The 3.x implementation coupled six stage-specific executors, text completion parsers, workflow
transitions, and aggregate mutations. CrewAI demonstrates a useful separation between the Agent that
performs work and the Task that defines the expected result. LangGraph demonstrates explicit state,
nodes, edges, reducers, checkpoints, and human interrupts.

The product also has constraints that make direct framework adoption costly: provider processes can
mutate a real workspace, unknown mutation outcomes must not be replayed, one fenced aggregate must be
authoritative, and the existing Node 18 CLI/VSIX distribution must remain self-contained.

## Decision

Implement the useful concepts directly in the TypeScript core:

1. `AgentDefinition` defines identity, instructions, runtime defaults, access, and maximum tool policy.
2. `TaskDefinition` defines schemas, signals, side-effect class, guardrails, effect mapper, and retry
   policy without naming an Agent.
3. A Workflow node combines one Agent and one Task and binds only named, provenance-preserving inputs.
4. Every model task executes through one `AgentTaskRunner`.
5. The last assistant response must be a JSON-only `TaskResultEnvelopeV1`. Core validation produces the
   only transition-eligible outcome.
6. Effect mappers return a closed `DomainEffect` union. Only `RunReducer` mutates `RunAggregate`.
7. `WorkflowCompiler` validates references, permissions, signals, reachability, cycles, approval paths,
   and budgets, then the entire compiled bundle is snapshotted into each run.
8. Activations and attempts are reserved before provider execution. Results and transitions commit once
   under expected revision and fencing epoch.
9. Human approval is a separate node. Access approval pauses the current activation and resumes it with
   a new attempt. Ambiguous mutation outcomes are never automatically replayed.
10. VS Code uses versioned commands and a read-only projection.

CrewAI and LangGraph are not production dependencies. The LangGraph package remains only in the private
`experiments/langgraph` structural comparison, with no checkpointer, provider execution, or state write
access.

## Rejected alternatives

- Keep six specialized executors: duplicates orchestration and validation behavior.
- Use unvalidated text markers with structured fallback: creates two completion authorities.
- Let Task definitions directly name Agents: prevents clean Task reuse across Agents and nodes.
- Allow generic JSON state patches: bypasses domain invariants and auditability.
- Use framework checkpoint replay for workspace mutations: can repeat an external side effect whose
  prior outcome is unknown.
- Keep migration and dual-read paths: preserves obsolete contracts and prevents the v4 state boundary
  from being enforceable.

## Consequences

- Version 4 starts definition, aggregate, and result schemas at version 1 and does not read 3.x data.
- Adding a model task normally requires definitions plus schema/guardrail/effect registry entries, not a
  new executor.
- Sequential deterministic workflows and explicit gates are supported; fan-out/join, subgraphs, manager
  delegation, and long-term agent memory remain out of scope.
- Framework adoption can be reconsidered only for a concrete graph-native or autonomous-team feature
  that removes more product-owned orchestration than it adds while preserving mutation safety.
