import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { MaintenanceService, assertNoMaintenanceInProgress } from "./maintenance-service";
import type { RootSet } from "../../root_set";

test("maintenance dry-run is read-only and reset preserves user configuration", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-loop-maintenance-"));
  const roots: RootSet = {
    codeRoot: process.cwd(),
    configRoot: path.join(base, "config"),
    projectRoot: path.join(base, "project"),
    dataRoot: path.join(base, "data"),
  };
  try {
    await mkdir(path.join(roots.dataRoot, "runs", "session_one"), { recursive: true });
    await mkdir(roots.configRoot, { recursive: true });
    await writeFile(path.join(roots.dataRoot, "runs", "session_one", "state.json"), "state", "utf8");
    const settings = JSON.stringify({ "$schema": "loop_config.schema.json", "defaults": { "maxCycles": 7 } });
    await writeFile(path.join(roots.configRoot, "loop_config.json"), settings, "utf8");
    const service = new MaintenanceService(roots.codeRoot);
    const preview = await service.preview(roots);
    assert.deepEqual(preview.sessionIds, ["session_one"]);
    assert.equal(await readFile(path.join(roots.configRoot, "loop_config.json"), "utf8"), settings);
    const result = await service.upgrade(roots, { resetSessions: true });
    assert.deepEqual(result.sessionIds, ["session_one"]);
    assert.equal(await readFile(path.join(roots.configRoot, "loop_config.json"), "utf8"), settings);
    assert.equal(await readFile(path.join(roots.dataRoot, "sessions_index.json"), "utf8").then((value) => JSON.parse(value).version), 4);
    assert.equal(await readFile(path.join(roots.configRoot, "init_manifest.v1.json"), "utf8").then((value) => JSON.parse(value).schemaVersion), 1);
    assert.equal(await readFile(path.join(roots.dataRoot, "maintenance"), "utf8").catch(() => null), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("normal startup fails closed while maintenance is locked or journaled", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-loop-maintenance-guard-"));
  const maintenanceRoot = path.join(base, "maintenance");
  try {
    await mkdir(maintenanceRoot, { recursive: true });
    await writeFile(path.join(maintenanceRoot, "maintenance.lock"), "{}", "utf8");
    await assert.rejects(
      () => assertNoMaintenanceInProgress(base),
      /Maintenance is in progress or requires recovery/u
    );
    await rm(path.join(maintenanceRoot, "maintenance.lock"), { force: true });
    await writeFile(
      path.join(maintenanceRoot, "upgrade_test.journal.json"),
      JSON.stringify({ schemaVersion: 1, operationId: "upgrade_test", stage: "sessions_moved" }),
      "utf8"
    );
    await assert.rejects(
      () => assertNoMaintenanceInProgress(base),
      /Maintenance is incomplete/u
    );
    await writeFile(
      path.join(maintenanceRoot, "upgrade_test.journal.json"),
      JSON.stringify({ schemaVersion: 1, operationId: "upgrade_test", stage: "completed" }),
      "utf8"
    );
    await assertNoMaintenanceInProgress(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("maintenance refuses a sessions root that could contain its own journal", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-loop-maintenance-overlap-"));
  const roots: RootSet = {
    codeRoot: process.cwd(),
    configRoot: path.join(base, "config"),
    projectRoot: path.join(base, "project"),
    dataRoot: base,
  };
  try {
    const service = new MaintenanceService(roots.codeRoot);
    await assert.rejects(
      () => service.preview(roots, "maintenance/sessions"),
      /must not overlap the maintenance journal/u
    );
    await assert.rejects(
      () => service.upgrade(roots, { resetSessions: true, sessionsRoot: "sessions/.." }),
      /must not overlap the maintenance journal|unsafe/u
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("maintenance freezes registry/index/history targets and scans a legacy index without normalizing it", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-loop-maintenance-legacy-"));
  const roots: RootSet = {
    codeRoot: process.cwd(),
    configRoot: path.join(base, "config"),
    projectRoot: path.join(base, "project"),
    dataRoot: path.join(base, "data"),
  };
  try {
    await mkdir(path.join(roots.dataRoot, "runs", "legacy_session"), { recursive: true });
    await mkdir(path.join(roots.dataRoot, "loop_history", "old"), { recursive: true });
    await mkdir(roots.projectRoot, { recursive: true });
    await mkdir(roots.configRoot, { recursive: true });
    await writeFile(path.join(roots.dataRoot, "runs", "legacy_session", "state.json"), "old-state", "utf8");
    await writeFile(path.join(roots.dataRoot, "sessions_index.json"), JSON.stringify({ version: 3, sessions: ["legacy_session"] }), "utf8");
    await writeFile(path.join(roots.dataRoot, "sessions_registry.json"), JSON.stringify({ legacy_session: true }), "utf8");
    await writeFile(path.join(roots.dataRoot, "loop_history", "old", "event.json"), "history", "utf8");
    const settings = JSON.stringify({
      "$schema": "loop_config.schema.json",
      "defaults": { "maxCycles": 7, "profileFallbackModels": { "opencode": "legacy-model" } },
      "providers": {
        "opencode": { "label": "OpenCode", "adapter": "opencode", "binary": "opencode", "enabled": true, "modelsArgs": ["models"], "fallbackModels": ["legacy-model"] },
      },
    });
    await writeFile(path.join(roots.configRoot, "loop_config.json"), settings, "utf8");
    await writeFile(path.join(roots.configRoot, "model_variants.json"), "{\"keep\":true}", "utf8");
    await writeFile(path.join(roots.projectRoot, "working.txt"), "keep-project", "utf8");

    const service = new MaintenanceService(roots.codeRoot);
    const preview = await service.preview(roots);
    assert.equal(preview.statuses.index, "legacy");
    assert.deepEqual(preview.sessionIds, ["legacy_session"]);
    assert.equal(preview.statuses.registry, "present");
    assert.equal(preview.statuses.history, "present");
    assert.ok(preview.deletionTargets.includes(path.join(roots.dataRoot, "sessions_registry.json")));
    assert.ok(preview.deletionTargets.includes(path.join(roots.dataRoot, "sessions_index.json")));
    assert.ok(preview.deletionTargets.includes(path.join(roots.dataRoot, "loop_history")));
    assert.equal(await readFile(path.join(roots.dataRoot, "sessions_index.json"), "utf8").then((value) => JSON.parse(value).version), 3);

    await service.upgrade(roots, { resetSessions: true });
    await assert.rejects(() => stat(path.join(roots.dataRoot, "sessions_registry.json")));
    await assert.rejects(() => stat(path.join(roots.dataRoot, "loop_history")));
    assert.equal(await readFile(path.join(roots.dataRoot, "sessions_index.json"), "utf8").then((value) => JSON.parse(value).version), 4);
    const migratedSettings = JSON.parse(await readFile(path.join(roots.configRoot, "loop_config.json"), "utf8")) as Record<string, any>;
    assert.equal(migratedSettings.defaults.maxCycles, 7);
    assert.equal(migratedSettings.defaults["profile" + "Fallback" + "Models"], undefined);
    assert.deepEqual(migratedSettings.providers.opencode.modelCatalog, { source: "command", args: ["models"] });
    assert.equal(await readFile(path.join(roots.configRoot, "model_variants.json"), "utf8"), "{\"keep\":true}");
    assert.equal(await readFile(path.join(roots.projectRoot, "working.txt"), "utf8"), "keep-project");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("maintenance fails closed on malformed index, live owner, residual files, and malformed journal", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-loop-maintenance-fail-closed-"));
  const roots: RootSet = {
    codeRoot: process.cwd(),
    configRoot: path.join(base, "config"),
    projectRoot: path.join(base, "project"),
    dataRoot: path.join(base, "data"),
  };
  try {
    const service = new MaintenanceService(roots.codeRoot);
    await mkdir(path.join(roots.dataRoot, "runs"), { recursive: true });
    await writeFile(path.join(roots.dataRoot, "runs", "unsafe file"), "unexpected", "utf8");
    await assert.rejects(() => service.preview(roots), /unsafe session id/u);
    await rm(path.join(roots.dataRoot, "runs", "unsafe file"), { force: true });
    await writeFile(path.join(roots.dataRoot, "sessions_index.json"), "{", "utf8");
    await assert.rejects(() => service.preview(roots), /malformed and cannot be safely migrated/u);

    await writeFile(path.join(roots.dataRoot, "sessions_index.json"), JSON.stringify({ version: 3 }), "utf8");
    await mkdir(path.join(roots.dataRoot, "runs", "live"), { recursive: true });
    await writeFile(path.join(roots.dataRoot, "runs", "live", "session_owner.lock"), JSON.stringify({ ownerPid: process.pid }), "utf8");
    await assert.rejects(() => service.upgrade(roots, { resetSessions: true }), /still owned/u);
    await rm(path.join(roots.dataRoot, "runs", "live"), { recursive: true, force: true });

    await mkdir(path.join(roots.dataRoot, "runs", "fixed"), { recursive: true });
    await writeFile(path.join(roots.dataRoot, "runs", "fixed", "state.json"), "state", "utf8");
    await mkdir(path.join(roots.dataRoot, "runs", "unexpected"), { recursive: true });
    await assert.rejects(() => service.upgrade(roots, { resetSessions: true }), /changed after target freeze/u);

    const maintenanceRoot = path.join(roots.dataRoot, "maintenance");
    await mkdir(maintenanceRoot, { recursive: true });
    await writeFile(path.join(maintenanceRoot, "broken.journal.json"), "{", "utf8");
    await assert.rejects(() => service.upgrade(roots, { resetSessions: true }), /journal is malformed/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("maintenance resumes the same frozen target list after a stage fault", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-loop-maintenance-resume-"));
  const roots: RootSet = {
    codeRoot: process.cwd(),
    configRoot: path.join(base, "config"),
    projectRoot: path.join(base, "project"),
    dataRoot: path.join(base, "data"),
  };
  try {
    await mkdir(path.join(roots.dataRoot, "runs", "resume"), { recursive: true });
    await writeFile(path.join(roots.dataRoot, "runs", "resume", "state.json"), "state", "utf8");
    let injected = false;
    const service = new MaintenanceService(roots.codeRoot);
    await assert.rejects(
      () => service.upgrade(roots, {
        resetSessions: true,
        faultInjector: async (stage) => {
          if (stage === "sessions_moved" && !injected) {
            injected = true;
            throw new Error("injected stage fault");
          }
        },
      }),
      /injected stage fault/u
    );
    const journalFiles = await (await import("node:fs/promises")).readdir(path.join(roots.dataRoot, "maintenance"));
    assert.ok(journalFiles.some((name) => name.endsWith(".journal.json")));
    // Recovery must use the frozen journal target list even if the current
    // index is damaged after the interruption.
    await writeFile(path.join(roots.dataRoot, "sessions_index.json"), "{", "utf8");
    const result = await service.upgrade(roots, { resetSessions: true, sessionsRoot: "different-current-root" });
    assert.deepEqual(result.sessionIds, ["resume"]);
    assert.equal(await readFile(path.join(roots.dataRoot, "sessions_index.json"), "utf8").then((value) => JSON.parse(value).version), 4);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
