import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import test from "node:test";
import { migrateLegacyRoot } from "./root_migration";

const migrationPaths = {
  registryFileName: "sessions_registry.json",
  sessionsRoot: "sessions",
  ownerLockFileName: "session_owner.lock",
  leaseFileName: "session_lease.json",
};

test("legacy root migration is checksummed, promoted, and idempotent", async (context) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-migration-"));
  context.after(() => fsp.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "legacy");
  const dataRoot = path.join(base, "data");
  const configRoot = path.join(base, "config");
  await fsp.mkdir(path.join(sourceRoot, "sessions", "s1"), { recursive: true });
  await fsp.writeFile(
    path.join(sourceRoot, "sessions_registry.json"),
    JSON.stringify({ version: 1, activeSessionIds: ["s1"], sessionMetas: [] })
  );
  await fsp.writeFile(
    path.join(sourceRoot, "sessions", "s1", "state.json"),
    JSON.stringify({ stateVersion: 2, sessionId: "s1" })
  );
  await fsp.writeFile(path.join(sourceRoot, "agent_loop.json"), JSON.stringify({ version: 1 }));

  const roots = {
    codeRoot: path.join(base, "code"),
    configRoot,
    projectRoot: path.join(base, "project"),
    dataRoot,
    legacyRoot: null,
    warnings: [],
  };
  const first = await migrateLegacyRoot(sourceRoot, roots, migrationPaths);
  const second = await migrateLegacyRoot(sourceRoot, roots, migrationPaths);

  assert.deepEqual(second, first);
  assert.ok(first.files.some((file) => file.relativePath.endsWith("state.json")));
  assert.equal(
    JSON.parse(await fsp.readFile(path.join(dataRoot, "sessions", "s1", "state.json"), "utf8")).sessionId,
    "s1"
  );
  assert.equal(
    JSON.parse(await fsp.readFile(path.join(configRoot, "agent_loop.json"), "utf8")).version,
    1
  );
});

test("legacy root migration refuses a potentially live owner", async (context) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-live-migration-"));
  context.after(() => fsp.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "legacy");
  const sessionDir = path.join(sourceRoot, "sessions", "s1");
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(
    path.join(sessionDir, migrationPaths.ownerLockFileName),
    JSON.stringify({ ownerId: "live", ownerPid: process.pid, createdAt: new Date().toISOString() })
  );

  await assert.rejects(
    () =>
      migrateLegacyRoot(
        sourceRoot,
        {
          codeRoot: path.join(base, "code"),
          configRoot: path.join(base, "config"),
          projectRoot: path.join(base, "project"),
          dataRoot: path.join(base, "data"),
          legacyRoot: null,
          warnings: [],
        },
        migrationPaths
      ),
    /owner pid .* may be alive/
  );
});

