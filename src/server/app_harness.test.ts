// Shared server/session harness for the app_*.test.ts scenario files.
// The .test suffix keeps it out of the npm package; it declares no tests.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "./app";
import { AgentGraphDocument, SessionState } from "../shared/domain";
import { delay } from "../core/resilience";
export const origin = "http://127.0.0.1:4317",
  host = "127.0.0.1:4317",
  binary = path.resolve(__dirname, "../../../test/fixture_cli.cjs");
// ConPTY drains output for about a second per role before reporting process exit;
// seven-role autonomous workflows measured up to ~20s on a loaded Windows host.
export const sessionWaitMs = process.platform === "win32" ? 45_000 : 10_000;
export const execute = promisify(execFile);
// Match production's worker isolation: ConPTY may retain native handles in the
// calling process even after every runtime assertion and lease release passes.
export async function runManualRuntime(
  root: string,
  id: string,
): Promise<void> {
  await execute(
    process.execPath,
    [path.join(__dirname, "worker.js"), root, id, "manual"],
    {
      timeout: sessionWaitMs,
      windowsHide: true,
    },
  );
}
export const quickSettings = {
  maxAgentAttempts: 1,
  maxCompletionRecoveryAttempts: 1,
  maxAutomaticRecoveryCycles: 0,
  phaseTimeoutMs: 3000,
  idleTimeoutMs: 1000,
  toolTimeoutMs: 1000,
  transportTimeoutMs: 1000,
  phaseRecoveryBudgetMs: 6000,
  retryBackoffMs: [10, 20],
  terminationGraceMs: 50,
  killTimeoutMs: 1000,
  heartbeatIntervalMs: 100,
  leaseTtlMs: 500,
};
export async function setup(monitor = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-api-")),
    target = path.join(root, "project");
  await fs.mkdir(target);
  const server = await createServer({
    root,
    origin,
    defaultTarget: target,
    monitor,
  });
  const response = await server.app.inject({
    url: "/api/bootstrap",
    headers: { host },
  });
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    server.app.inject({
      method,
      url,
      headers: { host, origin, cookie },
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: {
              host,
              origin,
              cookie,
              "content-type": "application/json",
            },
          }),
    });
  const cleanup = async () => {
    await server.app.close();
    await fs.rm(root, { recursive: true, force: true });
  };
  await server.store.saveConnection({
    id: "fixture",
    label: "Fixture CLI",
    type: "codex",
    binary,
  });
  let graph = (await server.store.graphs())[0]!;
  graph.defaultBinding = { connectionId: "fixture", modelId: "fixture-model" };
  graph = await server.store.saveGraph(graph.id, graph, graph.revision);
  return { ...server, root, target, graph, request, cleanup };
}
export async function wait(
  read: () => Promise<SessionState>,
  status: SessionState["status"],
  timeout = sessionWaitMs,
): Promise<SessionState> {
  const end = Date.now() + timeout;
  let s = await read();
  while (Date.now() < end) {
    s = await read();
    if (s.status === status) return s;
    if (["FAILED", "BLOCKED"].includes(s.status))
      throw new Error(s.statusReason ?? s.status);
    await delay(30);
  }
  throw new Error(
    `status ${s.status}: ${s.statusReason}; visits ${JSON.stringify(s.visits.map((v) => ({ node: v.nodeId, status: v.status, attempts: v.attempts.map((a) => ({ status: a.status, activity: a.activity, pid: a.pid, failure: a.failureKind })) })))}`,
  );
}
export async function minimal(s: Awaited<ReturnType<typeof setup>>) {
  const g = s.graph;
  g.nodes = g.nodes.filter((n) =>
    ["implementation", "test", "approval", "interrupt"].includes(n.id),
  );
  g.edges = g.edges
    .filter((e) => g.nodes.some((n) => n.id === e.source))
    .map((e) =>
      e.source === "test"
        ? {
            ...e,
            target: e.outcome === "success" ? "approval" : "implementation",
          }
        : e,
    );
  g.entrypoints = {
    start: "implementation",
    reentry: "implementation",
    interrupt: "interrupt",
    cycleCompletion: "implementation",
  };
  return s.store.saveGraph(g.id, g, g.revision);
}
export async function launch(
  s: Awaited<ReturnType<typeof setup>>,
  graph: AgentGraphDocument,
  goal: string,
  settings: Partial<SessionState["settings"]> = {},
) {
  const response = await s.request("POST", "/api/sessions", {
    requestId: randomUUID(),
    graphId: graph.id,
    expectedRevision: graph.revision,
    goal,
    targetProjectPath: s.target,
    settings: { ...quickSettings, ...settings },
  });
  assert.equal(response.statusCode, 202, response.body);
  return response.json<SessionState>().id;
}
export async function resumeHeld(
  s: Awaited<ReturnType<typeof setup>>,
  id: string,
) {
  // A settled state is saved before the worker exits, and resume refuses a live worker.
  const deadline = Date.now() + 10000;
  for (;;) {
    const response = await s.request("POST", `/api/sessions/${id}/actions`, {
      requestId: randomUUID(),
      type: "resume",
    });
    if (
      response.statusCode !== 409 ||
      !response.body.includes("아직 실행 중") ||
      Date.now() > deadline
    ) {
      assert.equal(response.statusCode, 200, response.body);
      return;
    }
    await delay(50);
  }
}
export async function setModelPricing(
  s: Awaited<ReturnType<typeof setup>>,
  metadata: Record<string, unknown>,
) {
  await fs.writeFile(
    path.join(s.target, ".fixture-model-metadata.json"),
    JSON.stringify(metadata),
  );
}

export async function automaticPlans(s: Awaited<ReturnType<typeof setup>>) {
  const graph = s.graph;
  graph.nodes.find((n) => n.type === "planning")!.planning!.requiresApproval =
    false;
  return s.store.saveGraph(graph.id, graph, graph.revision);
}
export async function contracted(
  s: Awaited<ReturnType<typeof setup>>,
  supplied = true,
  failing = false,
  second = false,
) {
  let graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.authoredNodeTests = false; // Legacy frozen-check profile; own-suite cases have dedicated coverage.
  graph.automation!.browserVerification = false;
  graph.automation!.maxRepairCycles = 1;
  graph.defaultBinding = s.graph.defaultBinding;
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  if (supplied) {
    await fs.mkdir(path.join(s.target, ".agent-graph"));
    await fs.mkdir(path.join(s.target, "tests"));
    await fs.writeFile(
      path.join(s.target, "tests/verify-acceptance.mjs"),
      `import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('artifact.txt','utf8'), ${JSON.stringify(failing ? "incorrect artifact\n" : "implemented goal\n")});`,
    );
    const check = {
      id: "acceptance",
      command: "node tests/verify-acceptance.mjs",
      requirements: ["REQ-001"],
    };
    await fs.writeFile(
      path.join(s.target, ".agent-graph/verification.json"),
      JSON.stringify({
        version: 1,
        protectedFiles: ["tests/verify-acceptance.mjs"],
        checks: [
          check,
          ...(second
            ? [
                {
                  ...check,
                  id: "second",
                  command: "node tests/verify-acceptance.mjs --second",
                },
              ]
            : []),
        ],
      }),
    );
  }
  return graph;
}
export async function nativeScopeContract(
  s: Awaited<ReturnType<typeof setup>>,
) {
  const graph = await contracted(s);
  // These fixtures exercise native policy events, not isolated program execution.
  // Keep scope auditing enabled without depending on a locally prepared VM.
  graph.automation!.programIoGuard = false;
  assert.equal(graph.automation!.targetScopeGuard, true);
  return s.store.saveGraph(graph.id, graph, graph.revision);
}
