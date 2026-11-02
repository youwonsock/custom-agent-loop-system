import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkOutParts, mergeParts, removeParts } from "./parallel_parts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function repository(t: { after(fn: () => Promise<unknown>): void }) {
  // Not resolved: on macOS the temporary folder sits behind a symlink, as a session's does.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "project");
  await fs.mkdir(target);
  git(target, "init", "-q");
  git(target, "config", "user.name", "t");
  git(target, "config", "user.email", "t@example.com");
  await fs.writeFile(path.join(target, "base.txt"), "base\n");
  git(target, "add", ".");
  git(target, "commit", "-q", "-m", "base");
  return { target, parts: path.join(root, "parts") };
}

test("merged parts land as uncommitted changes, and nothing else is left", async (t) => {
  const { target, parts } = await repository(t);
  const head = git(target, "rev-parse", "HEAD");
  const out = (await checkOutParts(target, parts, "agent-graph/v", [
    "alpha",
    "beta",
  ]))!;
  await fs.writeFile(path.join(out.parts[0]!.directory, "a.txt"), "a\n");
  await fs.writeFile(path.join(out.parts[1]!.directory, "b.txt"), "b\n");
  assert.deepEqual(await mergeParts(target, out, out.parts), {
    merged: ["alpha", "beta"],
    conflicts: [],
  });
  assert.equal(await fs.readFile(path.join(target, "a.txt"), "utf8"), "a\n");
  assert.equal(await fs.readFile(path.join(target, "b.txt"), "utf8"), "b\n");
  assert.equal(git(target, "rev-parse", "HEAD"), head);
  await removeParts(target, parts, "agent-graph/v");
  assert.equal(git(target, "branch", "--list", "agent-graph/*"), "");
  assert.equal(git(target, "worktree", "list").split("\n").length, 1);
  await assert.rejects(fs.access(parts));
});

test("a conflicting part is reported and leaves the project with the parts that fit", async (t) => {
  const { target, parts } = await repository(t);
  const out = (await checkOutParts(target, parts, "agent-graph/v", [
    "alpha",
    "beta",
  ]))!;
  await fs.writeFile(path.join(out.parts[0]!.directory, "base.txt"), "a\n");
  await fs.writeFile(path.join(out.parts[1]!.directory, "base.txt"), "b\n");
  assert.deepEqual(await mergeParts(target, out, out.parts), {
    merged: ["alpha"],
    conflicts: ["beta"],
  });
  assert.equal(await fs.readFile(path.join(target, "base.txt"), "utf8"), "a\n");
  await removeParts(target, parts, "agent-graph/v");
});

test("a part that did not finish is left out", async (t) => {
  const { target, parts } = await repository(t);
  const out = (await checkOutParts(target, parts, "agent-graph/v", [
    "alpha",
    "beta",
  ]))!;
  await fs.writeFile(path.join(out.parts[1]!.directory, "b.txt"), "b\n");
  assert.deepEqual(await mergeParts(target, out, [out.parts[0]!]), {
    merged: ["alpha"],
    conflicts: [],
  });
  await assert.rejects(fs.access(path.join(target, "b.txt")));
  await removeParts(target, parts, "agent-graph/v");
});

test("parts need a repository with nothing uncommitted", async (t) => {
  const { target, parts } = await repository(t);
  await fs.writeFile(path.join(target, "dirty.txt"), "dirty\n");
  assert.equal(
    await checkOutParts(target, parts, "agent-graph/v", ["a", "b"]),
    null,
  );
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "not-a-repo-"));
  t.after(() => fs.rm(plain, { recursive: true, force: true }));
  assert.equal(
    await checkOutParts(plain, parts, "agent-graph/v", ["a", "b"]),
    null,
  );
});
