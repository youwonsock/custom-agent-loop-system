# LangGraph.js evaluation spike

This is a private, non-production package used by ADR 0006. It is intentionally excluded from the
root npm package, VSIX bundle, root TypeScript build, and declared Node 18 runtime.

Run from the repository root:

```powershell
npm run evaluate:langgraph
```

The command installs the pinned experiment-only dependencies, builds the production core, compiles
the adapter separately, runs its conformance tests, and writes a local JSON report under
`artifacts/framework-evaluation/`.

The adapter has two non-negotiable constraints:

1. `SessionRepository` remains the only persistent state authority; no LangGraph checkpointer is
   configured.
2. A mutation-capable activation marked `unknown_mutation` is rejected before a stage executor can
   run.

Passing those constraints does not make the adapter production-eligible. Adoption also requires
meaningful code removal, supported packaging/runtime targets, a measured performance pass, and a
concrete graph-native product benefit.
