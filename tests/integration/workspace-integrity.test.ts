import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { FileWorkspaceIntegrity } from "../../src/infrastructure/workspace-integrity";

test("workspace fingerprints include untracked files and the watcher stays dirty after a change is reverted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-integrity-"));
  try {
    const file = path.join(root, "untracked.txt");
    await writeFile(file, "before", "utf8");
    const integrity = new FileWorkspaceIntegrity();
    const first = await integrity.fingerprint(root, [], []);
    assert.equal(first.files, 1);
    assert.equal(first.paths.length, 1);
    const watch = integrity.watch(root, [], []);
    await writeFile(file, "after", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await writeFile(file, "before", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(watch.dirty(), true);
    watch.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated output exclusions are applied consistently to fingerprints and watch events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-integrity-exclude-"));
  try {
    await mkdir(path.join(root, "generated"));
    await writeFile(path.join(root, "generated", "out.txt"), "one", "utf8");
    const integrity = new FileWorkspaceIntegrity();
    const first = await integrity.fingerprint(root, [], ["generated"]);
    assert.equal(first.files, 0);
    const watch = integrity.watch(root, [], ["generated"]);
    await writeFile(path.join(root, "generated", "out.txt"), "two", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(watch.dirty(), false);
    watch.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated output exclusions remain relative to the project root while recursing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-integrity-nested-"));
  try {
    await mkdir(path.join(root, "generated"));
    await mkdir(path.join(root, "src", "generated"), { recursive: true });
    await writeFile(path.join(root, "generated", "out.txt"), "excluded", "utf8");
    await writeFile(path.join(root, "src", "generated", "source.txt"), "protected", "utf8");
    const fingerprint = await new FileWorkspaceIntegrity().fingerprint(root, [], ["generated"]);
    assert.equal(fingerprint.paths.some((value) => value.endsWith(path.join("generated", "out.txt"))), false);
    assert.equal(fingerprint.paths.some((value) => value.endsWith(path.join("src", "generated", "source.txt"))), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked verification root is rejected", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "agent-loop-integrity-link-"));
  const target = path.join(parent, "target");
  const link = path.join(parent, "link");
  try {
    await mkdir(target);
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      test.skip("The current account cannot create directory links.");
      return;
    }
    await assert.rejects(() => new FileWorkspaceIntegrity().fingerprint(link, [], []), /symbolic link|link or alias/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
