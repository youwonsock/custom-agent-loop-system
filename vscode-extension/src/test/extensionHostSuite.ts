import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentLoopExtensionApi } from "../extension";
import {
  legacyMcpSecretStorageKey,
  namespacedMcpSecretStorageKey,
  protectMcpCredentialValue,
} from "../mcpSecurityPolicy";
import { decideRecoveryAction } from "../resilience";
import type { LoopState } from "../types";
import { launchTrusted } from "../workspaceExecutionPolicy";

const EXTENSION_ID = "custom-agent-loop.agent-loop-vscode";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Extension Host condition did not become true within ${timeoutMs}ms.`);
}

function fixtureState(sessionId: string, targetProjectPath: string): LoopState {
  const now = new Date().toISOString();
  return {
    stateVersion: 2,
    sessionId,
    status: "WAITING_USER",
    statusReason: "Plan approval required.",
    phase: "PLANNING",
    goal: "Exercise Extension Host lifecycle boundaries.",
    targetProjectPath,
    createdAt: now,
    updatedAt: now,
    accessMode: "ask",
    additionalAllowedPaths: [],
    pendingAccessRequest: {
      requestId: "access_e2e",
      requestedPaths: [path.join(targetProjectPath, "outside")],
      requestedAt: now,
      sourcePhase: "PLANNING",
      reason: "E2E access request",
    },
    awaitingPlanApproval: true,
    planApproved: false,
    selectedPlanChoiceId: null,
    planPath: null,
    artifactRefs: {},
    lastFailure: null,
    lastFailureDigest: null,
    activeAttempt: null,
    automaticRecovery: null,
    agentStates: {},
  } as unknown as LoopState;
}

async function readQueuedTypes(
  requestDir: string
): Promise<Array<"STOP" | "INTERRUPT">> {
  const names = await fs.readdir(requestDir).catch(() => [] as string[]);
  const types: Array<"STOP" | "INTERRUPT"> = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const value = JSON.parse(await fs.readFile(path.join(requestDir, name), "utf8")) as {
      type: "STOP" | "INTERRUPT";
    };
    types.push(value.type);
  }
  return types;
}

export async function run(): Promise<void> {
  const dataRoot = process.env.AGENT_LOOP_E2E_DATA_ROOT;
  assert.ok(dataRoot, "AGENT_LOOP_E2E_DATA_ROOT is required");
  const configuration = vscode.workspace.getConfiguration("agentLoop");
  await configuration.update("rootDir", dataRoot, vscode.ConfigurationTarget.Global);
  await configuration.update("leaseTtlMs", 120_000, vscode.ConfigurationTarget.Global);
  await configuration.update("heartbeatIntervalMs", 60_000, vscode.ConfigurationTarget.Global);

  const extension = vscode.extensions.getExtension<AgentLoopExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not loaded.`);
  const api = await extension.activate();
  assert.ok(api, "Trusted Extension Host activation did not return the extension API.");
  assert.equal(vscode.workspace.isTrusted, true);

  let launchCount = 0;
  assert.throws(
    () => launchTrusted(false, "newSession", () => { launchCount += 1; }),
    /untrusted workspace/
  );
  launchTrusted(true, "newSession", () => { launchCount += 1; });
  assert.equal(launchCount, 1, "Trust transition must permit exactly the trusted launch.");

  const sessionId = "extension-host-e2e";
  const sessionDir = await api.store.getSessionDir(sessionId);
  const paths = await api.store.getPathsConfig();
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, paths.sessionFileNames.state),
    JSON.stringify(fixtureState(sessionId, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? dataRoot)),
    "utf8"
  );
  await fs.writeFile(
    await api.store.getPlanChoicesPath(sessionId),
    JSON.stringify([{ id: 1, title: "Bounded plan", body: "1. Verify every host boundary." }]),
    "utf8"
  );

  await api.store.selectPlanChoice(sessionId, 1);
  let state = await api.store.approvePlan(sessionId);
  assert.equal(state.selectedPlanChoiceId, 1);
  assert.equal(state.planApproved, true);
  state = await api.store.updateAccessMode(sessionId, "full_access");
  assert.equal(state.accessMode, "full_access");
  assert.equal(state.pendingAccessRequest, null);

  const settings = await api.store.readSystemSettings();
  settings.toolAccess.webSearch.enabled = !settings.toolAccess.webSearch.enabled;
  await api.store.saveSystemSettings(settings);
  assert.equal(
    (await api.store.readSystemSettings()).toolAccess.webSearch.enabled,
    settings.toolAccess.webSearch.enabled
  );
  await configuration.update("pollIntervalMs", 321, vscode.ConfigurationTarget.Global);
  await waitFor(() => api.getConfig().pollIntervalMs === 321);

  const namespace = "extension-host-e2e-namespace";
  const legacyKey = legacyMcpSecretStorageKey("server", "headers", "Authorization");
  const currentKey = namespacedMcpSecretStorageKey(
    namespace,
    "server",
    "headers",
    "Authorization"
  );
  await api.context.secrets.store(legacyKey, "host-secret-sentinel");
  const protectedReference = await protectMcpCredentialValue(
    `\${secret:${legacyKey}}`,
    currentKey,
    legacyKey,
    api.context.secrets
  );
  assert.equal(protectedReference, `\${secret:${currentKey}}`);
  assert.equal(await api.context.secrets.get(currentKey), "host-secret-sentinel");
  await Promise.all([
    api.context.secrets.delete(legacyKey),
    api.context.secrets.delete(currentKey),
  ]);

  await api.store.updateState(sessionId, (candidate) => {
    candidate.status = "RECOVERING";
    candidate.statusReason = "Scheduled E2E recovery.";
    candidate.automaticRecovery = {
      sourcePhase: candidate.phase,
      failureKind: "network",
      cycle: 1,
      maxCycles: 2,
      resumeAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "E2E transient failure",
    };
  }, "e2e_recovering");
  assert.equal(await api.client.stopSession(sessionId), true);
  state = (await api.store.readState(sessionId))!;
  assert.equal(state.status, "STOPPED");

  await api.store.updateState(sessionId, (candidate) => {
    candidate.status = "RUNNING";
    candidate.statusReason = null;
  }, "e2e_running");
  const now = new Date().toISOString();
  const ownerId = "extension-host-owner";
  await fs.writeFile(
    path.join(sessionDir, paths.leaseFileName),
    JSON.stringify({
      ownerId,
      ownerPid: process.pid,
      childPid: null,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(sessionDir, paths.ownerLockFileName),
    JSON.stringify({ ownerId, ownerPid: process.pid, createdAt: now }),
    "utf8"
  );
  await api.client.interruptSession(sessionId, "Produce a bounded E2E briefing.");
  const requestDir = path.join(sessionDir, paths.controlDirName, "requests");
  assert.ok((await readQueuedTypes(requestDir)).includes("INTERRUPT"));

  const deadPid = 2_147_483_647;
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(
    path.join(sessionDir, paths.leaseFileName),
    JSON.stringify({
      ownerId: "dead-owner",
      ownerPid: deadPid,
      childPid: null,
      acquiredAt: expiredAt,
      heartbeatAt: expiredAt,
      expiresAt: expiredAt,
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(sessionDir, paths.ownerLockFileName),
    JSON.stringify({ ownerId: "dead-owner", ownerPid: deadPid, createdAt: expiredAt }),
    "utf8"
  );
  const runtime = await api.store.inspectLease(sessionId);
  assert.equal(runtime.disposition, "recoverable");
  assert.equal(
    decideRecoveryAction("RUNNING", 2, runtime.disposition, false, null),
    "recover"
  );

  console.log(
    "Extension Host E2E passed: trust, plan/access approval, STOP/INTERRUPT, " +
    "crash recovery, settings, and SecretStorage migration."
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}
