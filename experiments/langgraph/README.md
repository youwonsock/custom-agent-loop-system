# LangGraph.js structural comparison

This private package compares LangGraph routing with the v4 compiled workflow. It is excluded from the
root TypeScript build, npm package, and Windows desktop installer.

```powershell
npm run evaluate:langgraph
```

The experiment loads the production `CompiledWorkflowBundle` and verifies transition parity. It has no
provider execution, aggregate mutation, effect mapping, retries, or checkpointer. It therefore cannot
be selected as a production engine; its only output is a local comparison report under
`artifacts/framework-evaluation/`.
