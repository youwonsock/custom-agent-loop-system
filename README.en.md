# Agent Graph Studio

[한국어](README.md)

A web app that connects local coding CLIs into an agent graph. You edit roles and success and failure paths in the browser, and a Node.js worker on your computer runs Codex, Claude Code, OpenCode or Kilo. The interface is in Korean and English (language button at the top). Run reasons, model prompts and the documents in `docs/` are in Korean only.

## Start

You need Node.js 24 or later and at least one coding CLI installed and signed in.

```sh
npm ci
npm start
```

The app opens at `http://127.0.0.1:4317`. Closing the browser does not stop a run; press Ctrl+C in the terminal to stop the server.

```sh
node dist/src/server/cli.js ui --no-open
node dist/src/server/cli.js ui --port 4320 --root /absolute/path/to/workspace
```

- After installing the npm package, run `agent-loop ui`.
- Data is stored in `~/.agent-loop/graph-workspace`.
- Data from earlier versions is not read or converted. It stays on disk but does not appear in the list.
- macOS launcher: build **Agent Graph Studio.app** with `npm run build:launcher:mac` and double-click it. It needs the Xcode Command Line Tools and uses the Node.js from your login shell.

## What has been verified

- **Claude Code** (Haiku 5.5) is the only CLI run through the whole flow with a real model.
- Codex and Kilo have passed small scenarios only.
- OpenCode has not completed a run with a free model, so it is unverified.

See [the verification record](docs/VERIFICATION.md).

## Isolation

**Claude runs have no OS isolation by default.** The tool allow list the app passes exists so runs can proceed unattended, and because it allows `node`, it cannot stop arbitrary code. Run it on projects you trust, and use Claude Code's Bash sandbox as well.

Turn on **Run Claude commands in a VM** in graph settings to run Claude's Bash commands in the same VM as Kilo.

- A hook sees every tool call first, holds the file tools to the target project and refuses other tools.
- The VM has no network. Parallel tasks are not available, and dependencies cannot be installed inside it.

| Platform | Isolation |
| --- | --- |
| Apple Silicon macOS 26 | A VM through Apple container 1.6.0 |
| Linux | A rootless Podman container. It shares the host kernel, so the boundary is weaker than a VM |

After installing `container` or `podman`, run `npm run sandbox:prepare`. It needs network access and at least 8 GiB free. Without it, Kilo nodes stop before any model call. See [isolation settings](docs/AUTONOMOUS_WORKFLOW.md#kilo-프로그램-내부-io-격리).

## Build a graph

1. Duplicate the default cross-check loop or create a new graph.
2. Select a node and edit its name, role, instructions and run type.
3. Drag the success and failure handles to connect nodes.
4. Under **CLI connections**, register a service and query the models for your target project. **Find installed CLIs** looks for them on your PATH.
5. Choose the graph's common model. A node can use a different connection and model.
6. Enter a goal and a target project, and run the graph.

Node types are plan, implementation, test, review, final approval and interrupt handling. Nodes run one at a time.

An implementation node can list 2 to 4 **parallel tasks**.
- On its first visit each task runs in its own Git checkout, and the results merge into uncommitted changes.
- A normal implementation attempt then finishes the work, and that attempt is what gets judged.
- With uncommitted changes, outside a Git repository, or on Kilo with its target scope guard, the node runs as one attempt.

You can only pick models that a registered connection returned. The app never switches to another model on its own, and settings such as API keys, MCP and skills stay in each CLI.

## Autonomous builds

An **↻ Autonomous build graph** is for unattended runs.
- It picks one plan.
- It freezes the checks in `.agent-graph/verification.json`.
- It returns failed checks to implementation, within a set number of repairs.

A session reaches `SUCCESS` only when:
- every required requirement has evidence,
- the tests it actually ran passed,
- and the final approval accepted the work.

It also works on existing projects. A project's own `test` script is never overwritten. See [the autonomous workflow](docs/AUTONOMOUS_WORKFLOW.md) and [success, failure and retry conditions](docs/EXECUTION_CONDITIONS.md).

## Limits you can set

| Limit | Behaviour |
| --- | --- |
| Total time, total attempts | The session stops as `PAUSED` when either runs out |
| Tool time limit | 5 minutes by default for autonomous graphs. Raise it for projects with long tests |
| Spending limit | Checks the cost each CLI reports, between attempts, so one attempt can go over it. Not available with Codex, which reports no cost |

Extra automatic recovery after the repair limit applies only to models confirmed free. Paid models and models with unknown pricing stop and wait for you.

## Run states

| State | Meaning |
| --- | --- |
| `RUNNING` | In progress |
| `WAITING_USER` | Needs a decision: plan approval, path access, sign-in or an environment problem |
| `RECOVERING` | Extra recovery is scheduled for a free model |
| `PAUSED` | A limit ran out or the success conditions were not met. Resume after checking |
| `STOPPED` | Stopped by you |
| `BLOCKED` | Process or isolation evidence could not be confirmed, so the run is held |
| `SUCCESS` | Requirement evidence, current tests and final approval all passed |
| `FAILED` | An unhandled runtime error |

## CLI

```sh
agent-loop init
agent-loop graphs
agent-loop models --connection CONNECTION_ID --target /absolute/project
agent-loop run --graph GRAPH_ID --goal "goal" --target /absolute/project
agent-loop resume --session SESSION_ID
agent-loop verify-node-tests --target /absolute/project
```

Use `--root` to share a workspace with the app.

## Development

```sh
npm run verify:platform   # format, types, unit tests, package checks
npx playwright install chromium
npm run verify:browser    # browser scenarios
npm run verify:vm         # real VM tests on macOS
```

- **Fake CLIs:** tests use fake CLIs that speak each CLI's protocol, so they cost no model usage.
- **Real-model regression:** run `node scripts/real-cli-regression.js claude|codex|opencode|kilo` separately.
- **Golden files:** `test/golden/` fixes prompts and CLI arguments. Update them with `UPDATE_GOLDEN=1 npm test` only for an intended change.
- **VM results:** CI cannot run the macOS VM. A pull request that changes execution or isolation code must state `verify:vm N/N @ <commit>` in its body.
- **Seatbelt tests:** they need the official Node 24 build from nodejs.org and are skipped on Homebrew Node.

## Documents

The documents are in Korean.

| Document | Contents |
| --- | --- |
| [Autonomous workflow](docs/AUTONOMOUS_WORKFLOW.md) | Preparing autonomous graphs, the verification contract, isolation |
| [Execution conditions](docs/EXECUTION_CONDITIONS.md) | Success, failure and retry conditions and default limits |
| [Architecture](docs/ARCHITECTURE.md) | Internal structure for people changing the code |
| [Glossary](docs/GLOSSARY.md) | Terms and limit values |
| [Status](docs/STATUS.md) | Current state and remaining risks |
| [Verification](docs/VERIFICATION.md) | Latest verification results; older records in `docs/verification/` |

## License

[MIT](LICENSE)
