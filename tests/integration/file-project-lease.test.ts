import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { FileProjectLease } from "../../src/infrastructure/file-project-lease";

test("project lease conflicts are shared across independent data roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-lease-project-"));
  const registry = await mkdtemp(path.join(os.tmpdir(), "agent-loop-lease-registry-"));
  const otherDataRoot = await mkdtemp(path.join(os.tmpdir(), "agent-loop-lease-data-"));
  try {
    const first = await new FileProjectLease({ directory: registry }).acquire([root], "first", 5000);
    const generation = first.generation;
    const updatedAt = first.updatedAt;
    assert.equal(typeof generation, "string");
    assert.match(generation, /^[a-f0-9]{32}$/u);
    assert.equal(typeof updatedAt, "number");
    assert.ok(Number.isFinite(updatedAt));
    const leaseFile = (await readdir(registry)).find((name) => name.endsWith(".json"));
    assert.ok(leaseFile);
    const persisted = JSON.parse(await readFile(path.join(registry, leaseFile!), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.generation, generation);
    assert.equal(persisted.updatedAt, updatedAt);
    // The project path is the identity; a caller's separate session/data
    // directory must not create a second lease registry.
    void otherDataRoot;
    const second = new FileProjectLease({ directory: registry });
    await assert.rejects(() => second.acquire([root], "second", 5000), /already leased/u);
    assert.ok(first.assertOwned);
    await first.assertOwned();
    await first.release();
    const afterRelease = await second.acquire([root], "second", 5000);
    await afterRelease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(registry, { recursive: true, force: true });
    await rm(otherDataRoot, { recursive: true, force: true });
  }
});

test("nested project roots are treated as the same leased workspace", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "agent-loop-lease-nested-"));
  const child = path.join(parent, "child");
  const registry = path.join(parent, "registry");
  try {
    await mkdir(child);
    const lease = await new FileProjectLease({ directory: registry }).acquire([parent], "owner", 5000);
    await assert.rejects(
      () => new FileProjectLease({ directory: registry }).acquire([child], "other", 5000),
      /already leased/u
    );
    await lease.release();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
