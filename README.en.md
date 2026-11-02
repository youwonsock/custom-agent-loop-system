# Agent Graph Studio

[한국어](README.md)

A standalone web app that connects local coding CLIs into an agent graph. You edit roles and success and failure paths in the browser, and a Node.js worker on your computer runs Codex, Claude Code, OpenCode or Kilo. VS Code is not required.

The interface is available in Korean and English: use the language button at the top of the screen. Run reasons written during a session, model prompts and the documents in `docs/` are in Korean only.

## Start

You need Node.js 24 or later, and at least one coding CLI installed and signed in.

```sh
npm ci
npm start
```

The app runs at `http://127.0.0.1:4317` and opens your browser. Closing the browser does not stop a run. Press Ctrl+C in the terminal to stop the server.

```sh
node dist/src/server/cli.js ui --no-open
node dist/src/server/cli.js ui --port 4320 --root /absolute/path/to/workspace
```

After installing the npm package, run `agent-loop ui`. Data is stored in `~/.agent-loop/graph-workspace`. Data from earlier versions is not read or converted: an earlier session or graph stays on disk but does not appear in the list.

On macOS you can build a launcher with `npm run build:launcher:mac` and open **Agent Graph Studio.app** from the project folder. It needs the Xcode Command Line Tools and uses the Node.js from your login shell.

## What has been verified

Only **Claude Code** (Haiku 5.5) has been run through the whole flow with a real model. Codex, OpenCode and Kilo connections are available but have not been verified to the same level. See [the verification record](docs/VERIFICATION.md).

**Claude runs have no OS isolation by default.** The tool allow list the app passes to Claude exists so runs can proceed unattended, and because it allows `node`, it cannot stop arbitrary code. Run it on projects you trust, and use Claude Code's Bash sandbox as well.

Turn on **Run Claude commands in a VM** in graph settings to run Claude's Bash commands in the same VM as Kilo. A hook sees every tool call first, holds the file tools to the target project and refuses other tools. The VM has no network and parallel tasks are not available. Dependencies cannot be installed inside the VM, and native modules built on the host do not work there.

The VM needs Apple Silicon macOS 26 and Apple container 1.6.0. On Linux the same isolation uses rootless Podman, which is a container sharing the host kernel, so a weaker boundary. After installing `container` or `podman`, run `npm run sandbox:prepare`. It needs network access and at least 8 GiB free. Without it, Kilo nodes stop before any model call.

## Build a graph

1. Duplicate the default cross-check loop or create a new graph.
2. Select a node and edit its name, role, instructions and run type.
3. Drag the success and failure handles to connect nodes.
4. Under CLI connections, register a service and query the models for your target project. **Find installed CLIs** looks on your PATH when you press it.
5. Choose the graph's common model. A node can use a different connection and model.
6. Enter a goal and a target project, and run the graph.

Node types are plan, implementation, test, review, final approval and interrupt handling. Nodes run one at a time. An implementation node can list 2 to 4 **parallel tasks**: on its first visit each runs in its own Git checkout, the results merge into uncommitted changes, and a normal attempt finishes the work and is what gets judged. With uncommitted changes, outside a Git repository, or on Kilo with its target scope guard, they run as one attempt.

For an unattended build, create an **Autonomous build graph**. It picks one plan, freezes the checks in `.agent-graph/verification.json`, and returns failures to implementation. A session succeeds only with evidence from real test runs and a final approval.

## Limits you can set

The run form has limits for total time, total attempts and tool time. Raise the tool limit for projects with long tests.

The spending limit uses the cost each CLI reports and is checked between attempts, so one attempt can go over it. An attempt with no reported cost stops the session. Codex reports no cost, so the limit cannot be used with it. Reported cost can differ from a subscription charge.

## License

[MIT](LICENSE)
