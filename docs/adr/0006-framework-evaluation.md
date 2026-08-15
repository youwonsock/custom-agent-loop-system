# ADR 0006: Retain the product-owned workflow engine

- Status: Accepted
- Date: 2026-08-16
- Decision: Reject LangGraph.js and CrewAI as core runtime dependencies for this release line

## Context

Milestones 1-6 established explicit workflow, executor, provider-runtime, repository, outcome, and
extension-projection boundaries. Milestone 7 therefore evaluates whether a framework replaces
meaningful product-owned orchestration while preserving the guarantees in
[ADR 0004](0004-session-state-authority.md) and
[ADR 0005](0005-module-boundaries-and-workflow-authority.md).

LangGraph models state, nodes, and edges and runs them in super-steps. Its persistence layer writes
graph checkpoints at super-step boundaries, and replay intentionally re-executes nodes after the
selected checkpoint. Its own guidance requires side effects to be idempotent because interrupted or
failed work can execute again. See the official
[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api),
[persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence),
[time-travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel), and
[Functional API idempotency guidance](https://docs.langchain.com/oss/javascript/langgraph/functional-api).

Those semantics are valuable for graph-native applications, but this product already persists a
fenced aggregate before provider dispatch and deliberately refuses automatic replay when a
mutation-capable provider may have produced an unknown side effect.

## Spike

The non-production adapter in `experiments/langgraph` uses LangGraph 1.4.10 and the existing:

- `WorkflowEngine` transition contract;
- `StageExecutorRegistry` and stage executors;
- `AgentRuntime` provider-process boundary;
- `SessionRepository` aggregate authority;
- extension operator projection.

It compiles the graph without a LangGraph checkpointer, disables node retries, reloads the
authoritative aggregate before dispatch, checks aggregate revision and fencing epoch across graph
super-steps, and rejects `unknown_mutation` before executor invocation. The spike and all framework
packages live in an isolated private package and are excluded from root and VSIX production builds.

The conformance suite passed seven cases covering transition parity, reserved dispatch, injected
crash and replay, revision/fencing races, extension projection parity, dependency isolation, and
the declared Node runtime floor.

## Findings

| Gate | Result | Evidence |
|---|---|---|
| One state authority | Pass in the constrained spike | LangGraph checkpointer disabled; `SessionRepository` remains authoritative |
| Unknown mutation replay | Pass in the constrained spike | A replay after `unknown_mutation` is rejected before executor dispatch |
| Existing process, lease, budget, and control guarantees | Pass by delegation | All behavior remains in existing components outside LangGraph |
| Meaningful custom-code removal | Fail | The adapter removes 0 production lines; 33 non-blank transition-engine lines remain and the adapter adds 228 non-blank lines |
| Packaging and Tier-1 compatibility | Fail | Latest selected LangGraph supports Node 18, but its required `@langchain/core` 1.1.48 peer requires Node 20 while the product declares Node 18 |
| Performance budget | Fail | The measured module-load and heap deltas exceed the 10% roadmap budget |
| Documented product benefit | Fail | No current requirement needs parallel branches, graph-native subgraphs, or graph checkpoint replay |

On the Windows/Node 22 evaluation host, five post-warmup medians measured approximately 4.56 ms
and 0.56 MiB to load the current transition module versus 334.39 ms and 15.95 MiB for LangGraph.
The synthetic no-op stage-dispatch wrapper added about 1.78 ms per invocation. The dispatch ratio is
dominated by the near-zero current baseline and is not a claim about provider latency; the absolute
startup, memory, compatibility, and zero-code-removal results are the relevant gate evidence.
Re-run `npm run evaluate:langgraph` to generate a machine-readable local report.

## Decision

Retain the current TypeScript workflow engine and continue improving its explicit contracts.
LangGraph is rejected as a production dependency for this release line because the safe adapter is
only a parallel wrapper: enabling LangGraph persistence would introduce another checkpoint
authority, while disabling it leaves repository, recovery, process supervision, budgets, controls,
and stage transitions in custom code.

This is not a permanent rejection of LangGraph. Reopen the decision only when a concrete feature
requires graph-native parallelism, reusable subgraphs, or ecosystem tracing and a prototype can
delete more product-owned orchestration than it adds without weakening replay safety.

CrewAI is not evaluated as the core runtime. CrewAI describes itself as a Python framework whose
Crews target autonomous collaboration and whose Flows target structured orchestration; see its
official [concept overview](https://docs.crewai.com/core-concepts/Agents). There is no current
bounded stage that requires an autonomous inner team. A future CrewAI experiment requires that
specific use case and must run as a supervised subprocess behind `AgentRuntime`, use an explicit
cancellation/result protocol, and have no session-state write access.

## Consequences

- Production dependencies, runtime state, CLI behavior, and extension protocol do not change.
- The isolated spike remains reproducible evidence and cannot be imported by the production build.
- Framework features are evaluated against product requirements, not adopted as an architectural
  goal by themselves.
- Milestone 8 can harden one runtime and one state authority rather than ship two orchestration
  paths.
