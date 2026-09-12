import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";

import { DEFAULT_PROVIDERS } from "../../src/runtime/providers/provider-runtime";
import { getDefaultConfig } from "../../src/config/runtime-config";
import { SUPERVISED_AGENT_RUNTIME } from "../../src/runtime/agent-runtime";
import { SupervisedAgentRuntime } from "../../src/runtime/supervised-agent-runtime";
import type { AgentRuntimeRequest } from "../../src/application/ports/agent-runtime-port";
import type { ProviderCapabilityRuntimePort } from "../../src/application/ports/provider-capability-runtime-port";
import type { RunControlCommand, RunControlCommandPort } from "../../src/application/ports/control-command";

const now = "2026-09-10T00:00:00.000Z";

function request(root: string, overrides: Partial<AgentRuntimeRequest> = {}): AgentRuntimeRequest {
  return {
    runId: "runtime-run",
    nodeId: "IMPLEMENTATION",
    activationId: "activation-1",
    attemptId: "attempt-1",
    taskId: "implement_changes",
    agent: {
      id: "implementer",
      role: "implementer",
      objective: "make the change",
      instructions: "work carefully",
      access: "workspace_write",
      runtimeDefaults: { provider: "opencode", model: "coverage" },
      runtime: { provider: "opencode", model: "coverage" },
      toolPolicy: { workspace: "write", webSearch: false, mcpServers: [] },
    },
    prompt: "do the task",
    toolPolicy: { workspace: "write", webSearch: false, mcpServers: [] },
    mode: "task",
    workspaceMode: "write",
    targetProjectPath: root,
    additionalAllowedPaths: [],
    fullAccess: true,
    ...overrides,
  };
}

function capability(status: "verified" | "unverified" | "unsupported"): ProviderCapabilityRuntimePort {
  return { inspect: async () => ({ status, adapter: "opencode", binary: process.execPath, mode: "tools-none", key: "coverage", reason: status, expectedCliVersion: "coverage", cliVersion: "coverage", platform: process.platform, architecture: process.arch, resolvedBinary: process.execPath, diagnostic: null }) };
}

function failureOf(response: Awaited<ReturnType<SupervisedAgentRuntime["execute"]>>) {
  return response.status === "failed" ? response.failure : null;
}

function controls(command?: RunControlCommand, failRecover = false): RunControlCommandPort {
  return {
    enqueue: async () => command!,
    recover: async () => { if (failRecover) throw new Error("control recovery failed"); },
    claim: async () => command ?? null,
    complete: async () => undefined,
  };
}

function runtime(root: string, extra: Partial<ConstructorParameters<typeof SupervisedAgentRuntime>[0]> = {}) {
  return new SupervisedAgentRuntime({
    providers: { opencode: { ...DEFAULT_PROVIDERS.opencode, binary: process.execPath } },
    toolAccess: { webSearch: { enabled: false, mode: "live" }, mcpServers: [] },
    defaults: getDefaultConfig().defaults,
    destructivePrompts: [],
    runDataRoot: root,
    ...extra,
  });
}

test("supervised runtime validates identity and capability failures before spawning", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-supervised-"));
  try {
    const instance = runtime(root, { providers: {} });
    const unsafeRun = await instance.execute(request(root, { runId: "../escape" }));
    assert.equal(failureOf(unsafeRun)?.kind, "security");
    const unsafeAttempt = await instance.execute(request(root, { attemptId: "../attempt" }));
    assert.equal(failureOf(unsafeAttempt)?.kind, "security");
    const missingProvider = await instance.execute(request(root, { agent: { ...request(root).agent, runtime: { provider: "missing", model: "x" } } }));
    assert.equal(failureOf(missingProvider)?.providerStarted, false);
    const unverified = await runtime(root, { providerCapabilityRuntime: capability("unverified") }).execute(request(root, { mode: "format_recovery", workspaceMode: "none" }));
    assert.equal(failureOf(unverified)?.kind, "permission");
    assert.match(failureOf(unverified)?.message ?? "", /Tool-free recovery/u);
    const inspectionError = await runtime(root, { providerCapabilityRuntime: { inspect: async () => { throw new Error("inspect failed"); } } }).execute(request(root, { mode: "format_recovery", workspaceMode: "none" }));
    assert.match(failureOf(inspectionError)?.message ?? "", /inspection failed/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supervised runtime releases inputs and maps success, provider failure, and controls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-supervised-launch-"));
  try {
    await fs.mkdir(path.join(root, "runtime-run", "attempt_logs"), { recursive: true });
    const launch = mock.method(SUPERVISED_AGENT_RUNTIME, "launch", async () => ({
      outcome: "succeeded" as const, exitCode: 0, failureKind: null, failureMessage: null,
      assistantText: "assistant", output: "transcript", events: [], pid: 42, signal: null,
    }));
    const success = await runtime(root).execute(request(root));
    assert.equal(success.status, "succeeded");
    assert.equal(success.assistantText, "assistant");
    launch.mock.restore();

    mock.method(SUPERVISED_AGENT_RUNTIME, "launch", async () => ({
      outcome: "failed" as const, exitCode: 2, failureKind: "process_exit" as const, failureMessage: "bad exit",
      assistantText: "partial", output: "diagnostic", events: [], pid: 11, signal: null,
    }));
    const failed = await runtime(root).execute(request(root));
    assert.equal(failed.status, "failed");
    assert.equal(failureOf(failed)?.retryable, true);
    mock.restoreAll();

    const command: RunControlCommand = { schemaVersion: 1, requestId: "stop-1", runId: "runtime-run", type: "stop", message: "stop", createdAt: now };
    mock.method(SUPERVISED_AGENT_RUNTIME, "launch", async (options: { pollControl?: () => Promise<unknown> }) => {
      await options.pollControl?.();
      return { outcome: "succeeded" as const, exitCode: 0, failureKind: null, failureMessage: null, assistantText: "partial", output: "", events: [], pid: 9, signal: null };
    });
    const controlled = await runtime(root, { controls: controls(command) }).execute(request(root));
    assert.equal(failureOf(controlled)?.kind, "stopped");
    assert.equal(failureOf(controlled)?.controlCommand?.requestId, "stop-1");
    mock.restoreAll();

    const recoverFailure = await runtime(root, { controls: controls(undefined, true) }).execute(request(root));
    assert.equal(failureOf(recoverFailure)?.kind, "security");
    assert.match(failureOf(recoverFailure)?.message ?? "", /recovery failed/u);
  } finally {
    mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supervised runtime enforces tool-free Kilo transport and writes large runtime inputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-supervised-inputs-"));
  try {
    await fs.mkdir(path.join(root, "runtime-run", "runtime_inputs"), { recursive: true });
    await fs.mkdir(path.join(root, "runtime-run", "attempt_logs"), { recursive: true });
    const kiloProvider = { ...DEFAULT_PROVIDERS.kilo, binary: process.execPath };
    const longPrompt = "x".repeat(9_000);
    const kilo = runtime(root, { providers: { kilo: kiloProvider }, providerCapabilityRuntime: { inspect: async () => ({ status: "verified", adapter: "kilo", binary: process.execPath, mode: "tools-none", key: "kilo", reason: "verified", expectedCliVersion: "coverage", cliVersion: "coverage", platform: process.platform, architecture: process.arch, resolvedBinary: process.execPath, diagnostic: null }) } });
    const tooLong = await kilo.execute(request(root, { prompt: longPrompt, mode: "format_recovery", workspaceMode: "none", agent: { ...request(root).agent, runtime: { provider: "kilo", model: "coverage" } } }));
    assert.equal(failureOf(tooLong)?.kind, "permission");
    mock.method(SUPERVISED_AGENT_RUNTIME, "launch", async () => ({ outcome: "succeeded" as const, exitCode: 0, failureKind: null, failureMessage: null, assistantText: "ok", output: "", events: [], pid: 1, signal: null }));
    const normal = await kilo.execute(request(root, { prompt: longPrompt, agent: { ...request(root).agent, runtime: { provider: "kilo", model: "coverage" } }, toolPolicy: { workspace: "write", webSearch: false, mcpServers: [] } }));
    assert.equal(normal.status, "succeeded");
  } finally {
    mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});
