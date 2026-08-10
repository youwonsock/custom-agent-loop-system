import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertSafeRelativePath,
  assertPathOutsideBases,
  resolveContainedPath,
  resolveConfiguredDataRoot,
  runWithIsolatedDataRoot,
  validateLoopPathsConfig,
} from "./pathSafety";

const defaultPaths = {
  sessionsRoot: ".goal/sessions",
  registryFileName: "sessions_registry.json",
  variantsConfigFileName: "model_variants.json",
  loopHistoryDirName: "loop_history",
  controlDirName: "control",
  ownerLockFileName: "session_owner.lock",
  stateLockFileName: "state_write.lock",
  leaseFileName: "session_lease.json",
  registryLockFileName: "registry.lock",
  attemptLogsDirName: "attempt_logs",
  sessionFileNames: {
    state: "loop_state.json",
    progressNotes: "progress_notes.txt",
    finalSummary: "final_summary.json",
    plan: "plan.md",
    planChoices: "plan_choices.json",
    planOverview: "plan_options.md",
    planOptionsDir: "plan_options",
    interruptMessage: "interrupt_message.txt",
    stopRequest: "stop_request.txt",
  },
  roomFileNames: {
    state: "state.json",
    skills: "skills.json",
    input: "input.json",
    output: "output.json",
  },
  roomDirNames: { planner: "0_planner" },
};

test("path settings reject portable absolute, traversal, drive-relative, and multi-segment file names", () => {
  for (const unsafe of ["../outside", "a/../outside", "/tmp/outside", "C:\\outside", "C:outside", "\\\\server\\share"]) {
    assert.throws(() => assertSafeRelativePath(unsafe, "test.path"));
  }
  assert.throws(() => assertSafeRelativePath("nested/file.json", "test.file", true));
  assert.doesNotThrow(() => validateLoopPathsConfig(defaultPaths));
});

test("configured data roots reject dot and other relative paths", () => {
  for (const configuredRoot of [".", "..", "relative/data"]) {
    assert.throws(() => resolveConfiguredDataRoot(configuredRoot), /must be empty or an absolute path/);
  }
  assert.equal(resolveConfiguredDataRoot(path.resolve(os.tmpdir())), path.resolve(os.tmpdir()));
});

test("portable segments reject Windows device names, forbidden characters, controls, and ambiguous suffixes", () => {
  const unsafeSegments = [
    "CON", "con.txt", "PRN", "AUX.md", "NUL", "COM1", "com9.log", "LPT1", "lpt9.txt",
    "name.", "name ", " leading", "bad<name", "bad>name", 'bad"name', "bad|name", "bad?name",
    "bad*name", "bad:name", "line\nbreak", "line\rbreak", "control\u0001name", "delete\u007fname",
  ];
  for (const segment of unsafeSegments) {
    assert.throws(
      () => assertSafeRelativePath(`safe/${segment}`, "test.path"),
      /unsafe path segment/,
      `expected unsafe segment to be rejected: ${JSON.stringify(segment)}`
    );
  }
  for (const safe of ["console", "com10", "lpt10.txt", ".goal", "name.txt", "safe/nested"]) {
    assert.doesNotThrow(() => assertSafeRelativePath(safe, "test.path"));
  }
});

test("contained paths reject lexical traversal", async () => {
  const base = path.join(os.tmpdir(), "agent-loop-path-base");
  await assert.rejects(
    resolveContainedPath(base, "../outside", "test path"),
    /escapes its allowed directory/
  );
});

test("contained paths reject an existing symlink or junction that leaves the base", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-path-test-"));
  const base = path.join(temp, "base");
  const outside = path.join(temp, "outside");
  await fs.mkdir(base);
  await fs.mkdir(outside);
  const link = path.join(base, "link");
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      const nativeGateRequired = Boolean(process.env.CI) ||
        process.env.AGENT_LOOP_REQUIRE_NATIVE_PATH_TESTS === "1";
      if (nativeGateRequired) {
        assert.fail(`Native symlink/junction path test is required but unavailable: ${code}`);
      }
      t.skip(`Symlink creation is unavailable: ${code}`);
      await fs.rm(temp, { recursive: true, force: true });
      return;
    }
    throw err;
  }
  try {
    await assert.rejects(
      resolveContainedPath(base, path.join("link", "state.json"), "session file"),
      /symbolic link or junction/
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("data-root isolation resolves an existing junction parent before a missing leaf and performs zero writes", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-root-isolation-"));
  const workspace = path.join(temp, "workspace");
  const externalSentinel = path.join(temp, "sentinel.txt");
  const link = path.join(temp, "link-to-workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(externalSentinel, "unchanged", "utf8");
  try {
    await fs.symlink(workspace, link, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      const nativeGateRequired = Boolean(process.env.CI) ||
        process.env.AGENT_LOOP_REQUIRE_NATIVE_PATH_TESTS === "1";
      if (nativeGateRequired) {
        assert.fail(`Native symlink/junction root-isolation test is required but unavailable: ${code}`);
      }
      t.skip(`Symlink creation is unavailable: ${code}`);
      await fs.rm(temp, { recursive: true, force: true });
      return;
    }
    throw err;
  }
  const missingRoot = path.join(link, "new-data");
  let writes = 0;
  try {
    await assert.rejects(
      runWithIsolatedDataRoot(missingRoot, [workspace], async () => {
        writes += 1;
        await fs.mkdir(missingRoot, { recursive: true });
      }),
      /must be outside/
    );
    assert.equal(writes, 0);
    assert.equal(await fs.stat(path.join(workspace, "new-data")).catch(() => null), null);
    assert.equal(await fs.readFile(externalSentinel, "utf8"), "unchanged");
    await assert.rejects(
      assertPathOutsideBases(missingRoot, [workspace], "Agent Loop data root"),
      /must be outside/
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
