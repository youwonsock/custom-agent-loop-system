import assert from "node:assert/strict";
import test from "node:test";
import { resolveRootSet, validateLocalRootPath } from "../../src/interfaces/cli/root-set";

test("RootSet uses explicit roots and never discovers data from the working directory", () => {
  const roots = resolveRootSet(
    {
      "code-root": "/opt/agent-loop",
      "config-root": "/etc/agent-loop",
      "data-root": "/var/lib/agent-loop",
      target: "/work/project",
    },
    {
      platform: "linux",
      env: {},
      homeDir: "/home/tester",
      currentWorkingDirectory: "/work/contains-a-registry",
      scriptPath: "/opt/agent-loop/dist/core/entrypoints/loop-orchestrator.js",
    }
  );

  assert.deepEqual(roots, {
    codeRoot: "/opt/agent-loop",
    configRoot: "/etc/agent-loop",
    projectRoot: "/work/project",
    dataRoot: "/var/lib/agent-loop",
  });
});

test("RootSet derives OS application roots when explicit data paths are absent", () => {
  const roots = resolveRootSet(
    {},
    {
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/config", XDG_DATA_HOME: "/data" },
      homeDir: "/home/tester",
      currentWorkingDirectory: "/work/project",
      scriptPath: "/opt/agent-loop/dist/core/entrypoints/loop-orchestrator.js",
    }
  );

  assert.equal(roots.codeRoot, "/opt/agent-loop");
  assert.equal(roots.configRoot, "/config/custom-agent-loop-system");
  assert.equal(roots.dataRoot, "/data/custom-agent-loop-system");
  assert.equal(roots.projectRoot, "/work/project");
});

test("removed legacy root fails instead of enabling compatibility mode", () => {
  assert.throws(() => resolveRootSet(
    { root: "/removed" },
    {
      platform: "linux",
      env: {},
      homeDir: "/home/tester",
      currentWorkingDirectory: "/work/project",
      scriptPath: "/opt/agent-loop/dist/core/entrypoints/loop-orchestrator.js",
    }
  ), /removed in v8/);
});

test("path policy rejects device paths, UNC, ADS, and reserved Windows names", () => {
  for (const unsafe of [
    "\\\\?\\C:\\data",
    "\\\\.\\C:\\data",
    "\\\\server\\share",
    "C:\\data:stream",
    "C:\\CON\\data",
    "C:\\safe\\LPT1.txt",
  ]) {
    assert.throws(() => validateLocalRootPath(unsafe, "win32"), /not supported/);
  }
  assert.doesNotThrow(() => validateLocalRootPath("C:\\AgentLoop\\data", "win32"));
});
