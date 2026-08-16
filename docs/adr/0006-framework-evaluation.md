# ADR 0006: Retain a product-owned workflow engine

- Status: Superseded by ADR 0008
- Date: 2026-08-16

## Historical decision

The first framework evaluation rejected LangGraph.js and CrewAI as core runtime dependencies. A safe
LangGraph wrapper had to disable its checkpointer and retries and delegate persistence, provider
execution, mutation safety, budgets, controls, and transitions back to the product. It therefore added
a second orchestration layer without removing meaningful production code. CrewAI also required a
Python runtime and addressed autonomous delegation that the sequential product workflow did not need.

## v4 disposition

[ADR 0008](0008-agent-task-graph-v4.md) incorporates the useful concepts directly: explicit
Agent/Task/Workflow definitions, graph compilation, reducer-owned state changes, checkpoints, and human
gates. The old executor-wrapper spike was removed.

`experiments/langgraph` now performs structure comparison only. It loads the v4
`CompiledWorkflowBundle`, checks transition parity, and has no provider execution, effect mapping,
aggregate writes, retries, or checkpointer. Framework packages remain excluded from npm and VSIX
production artifacts.

Reconsider a production framework only for a concrete need such as parallel graph branches, reusable
subgraphs, or bounded autonomous delegation, and only if the implementation preserves one state
authority and unknown-mutation replay safety while deleting more custom orchestration than it adds.
