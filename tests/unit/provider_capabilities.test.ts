import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderCapability } from "../../src/runtime/providers/provider-capabilities";
import { DEFAULT_PROVIDERS, buildProviderInvocation } from "../../src/runtime/providers/provider-runtime";

test("provider capability decisions require an exact CLI version and supported OS cell", () => {
  const verified = resolveProviderCapability("opencode", "tools-none", {
    cliVersion: "OpenCode 1.18.14",
    platform: "linux",
    architecture: "x64",
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.cliVersion, "1.18.14");

  const versionMismatch = resolveProviderCapability("opencode", "tools-none", {
    cliVersion: "1.18.15",
    platform: "linux",
    architecture: "x64",
  });
  assert.equal(versionMismatch.status, "unverified");
  assert.match(versionMismatch.reason, /1\.18\.14/u);

  const unsupportedPlatform = resolveProviderCapability("opencode", "tools-none", {
    cliVersion: "1.18.14",
    platform: "aix",
    architecture: "x64",
  });
  assert.equal(unsupportedPlatform.status, "unsupported");

  const codexToolsNone = resolveProviderCapability("codex", "tools-none", {
    cliVersion: "0.146.1",
    platform: "win32",
    architecture: "x64",
  });
  assert.equal(codexToolsNone.status, "unverified");
});

test("tool-free invocations require a runtime-owned exact capability decision", () => {
  const options = {
    model: "opencode/test",
    targetProjectPath: process.cwd(),
    prompt: "format only",
    fullAccess: false,
    readOnly: true,
    workspaceMode: "none" as const,
    webSearch: false,
    mcpServers: [],
  };
  assert.throws(
    () => buildProviderInvocation(DEFAULT_PROVIDERS.opencode, options),
    /verified tools-none capability/u
  );
  const decision = resolveProviderCapability("opencode", "tools-none", {
    cliVersion: "1.18.14",
    platform: process.platform,
    architecture: process.arch,
  });
  if (decision.status !== "verified") return;
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.opencode, {
    ...options,
    toolsNoneCapability: decision,
  });
  assert.ok(invocation.args.includes("run"));
  const runtime = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT) as { permission: Record<string, string> };
  assert.equal(runtime.permission["*"], "deny");
});

test("tool-free capability evidence is bound to the current adapter and host", () => {
  const decision = resolveProviderCapability("opencode", "tools-none", {
    cliVersion: "1.18.14",
    platform: process.platform,
    architecture: process.arch,
  });
  if (decision.status !== "verified") return;
  const options = {
    model: "opencode/test",
    targetProjectPath: process.cwd(),
    prompt: "format only",
    fullAccess: false,
    readOnly: true,
    workspaceMode: "none" as const,
    webSearch: false,
    mcpServers: [],
  };
  assert.throws(
    () => buildProviderInvocation(DEFAULT_PROVIDERS.opencode, {
      ...options,
      toolsNoneCapability: { ...decision, adapter: "kilo" },
    }),
    /verified tools-none capability/u
  );
  assert.throws(
    () => buildProviderInvocation(DEFAULT_PROVIDERS.opencode, {
      ...options,
      readOnly: false,
      toolsNoneCapability: decision,
    }),
    /verified tools-none capability/u
  );
});
