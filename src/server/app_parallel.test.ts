import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { launch, minimal, setup, wait } from "./app_harness.test";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function withParts(s: Awaited<ReturnType<typeof setup>>) {
  const graph = await minimal(s);
  graph.nodes.find((n) => n.id === "implementation")!.parallelTasks = [
    "alpha",
    "beta",
  ];
  return s.store.saveGraph(graph.id, graph, graph.revision);
}
async function commitTarget(target: string) {
  git(target, "init", "-q");
  git(target, "config", "core.autocrlf", "false");
  git(target, "config", "user.name", "t");
  git(target, "config", "user.email", "t@example.com");
  // The fixture keeps its call count here, which is not part of the project.
  await fs.writeFile(path.join(target, ".gitignore"), ".fixture-*\n");
  git(target, "add", ".");
  git(target, "commit", "-q", "-m", "base");
}

test("parallel parts merge into the project, then a normal attempt finishes the work", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await commitTarget(s.target);
  const head = git(s.target, "rev-parse", "HEAD");
  const id = await launch(s, await withParts(s), "fixture:parallel build");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  const attempts = done.visits[0]!.attempts;
  assert.deepEqual(
    attempts.map((a) => [a.mode, a.task, a.status]),
    [
      ["parallel_part", "alpha", "succeeded"],
      ["parallel_part", "beta", "succeeded"],
      ["standard", undefined, "succeeded"],
    ],
  );
  assert.equal(
    await fs.readFile(path.join(s.target, "alpha.txt"), "utf8"),
    "alpha\n",
  );
  assert.equal(
    await fs.readFile(path.join(s.target, "beta.txt"), "utf8"),
    "beta\n",
  );
  assert.equal(git(s.target, "rev-parse", "HEAD"), head);
  assert.equal(git(s.target, "branch", "--list", "agent-graph/*"), "");
  assert.equal(git(s.target, "worktree", "list").split("\n").length, 1);
});

test("without a clean repository the same node runs as one normal attempt", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await withParts(s), "fixture:parallel build");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.deepEqual(
    done.visits[0]!.attempts.map((a) => a.mode),
    ["standard"],
  );
});

test("stopping during parts ends all of them and leaves no checkout", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await commitTarget(s.target);
  const id = await launch(
    s,
    await withParts(s),
    "fixture:parallel-hang build",
    {
      idleTimeoutMs: 2500,
      transportTimeoutMs: 2500,
    },
  );
  const running = async () =>
    (await s.store.readSession(id)).visits[0]?.attempts.filter((a) => a.pid)
      .length === 2;
  const end = Date.now() + 8000;
  while (!(await running()) && Date.now() < end)
    await new Promise((r) => setTimeout(r, 30));
  const stop = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: "11111111-1111-4111-8111-111111111111",
    type: "stop",
  });
  assert.ok(stop.statusCode < 300, stop.body);
  const done = await wait(() => s.store.readSession(id), "STOPPED");
  assert.deepEqual(
    done.visits[0]!.attempts.map((a) => a.mode),
    ["parallel_part", "parallel_part"],
  );
  for (const attempt of done.visits[0]!.attempts)
    assert.notEqual(attempt.status, "running");
  assert.equal(git(s.target, "branch", "--list", "agent-graph/*"), "");
});

test("parallel tasks are limited to implementation nodes and to 2 to 4 tasks", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s);
  const node = graph.nodes.find((n) => n.id === "implementation")!;
  node.parallelTasks = ["only one"];
  await assert.rejects(
    s.store.saveGraph(graph.id, graph, graph.revision),
    /2~4/,
  );
  node.parallelTasks = ["a", "b", "c", "d", "e"];
  await assert.rejects(
    s.store.saveGraph(graph.id, graph, graph.revision),
    /2~4/,
  );
  delete node.parallelTasks;
  graph.nodes.find((n) => n.id === "test")!.parallelTasks = ["a", "b"];
  await assert.rejects(
    s.store.saveGraph(graph.id, graph, graph.revision),
    /2~4/,
  );
});
