import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentLoopExtensionApi } from "../extension";
import {
  namespacedMcpSecretStorageKey,
  protectMcpCredentialValue,
} from "../mcpSecurityPolicy";
import { decideRecoveryAction } from "../resilience";
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

function fixtureProjection(sessionId: string, targetProjectPath: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    projectionSchemaVersion: 1,
    stateVersion: 4,
    sessionId,
    runId: sessionId,
    definitionHash: "a".repeat(64),
    revision: 7,
    fencingEpoch: 2,
    status: "WAITING_USER",
    statusReason: "Plan approval required.",
    phase: "PLAN_APPROVAL",
    currentNodeId: "PLAN_APPROVAL",
    currentAgentId: null,
    activeActivation: {
      activationId: "activation_plan_gate",
      nodeId: "PLAN_APPROVAL",
      status: "waiting_user",
      workflowStep: 2,
      attemptIds: [],
      sideEffect: "none",
    },
    pendingInput: {
      requestId: "request_activation_plan_gate",
      kind: "plan_approval",
      nodeId: "PLAN_APPROVAL",
      activationId: "activation_plan_gate",
      prompt: "Select a plan.",
      allowedSignals: ["approved", "revision_requested", "cancelled"],
      context: {},
      createdAt: now,
    },
    goal: "Exercise Extension Host v4 projection boundaries.",
    targetProjectPath,
    additionalAllowedPaths: [],
    awaitingPlanApproval: true,
    planApproved: false,
    selectedPlanChoiceId: null,
    planChoices: [{ id: "plan-1", title: "Bounded plan", body: "Verify every host boundary." }],
    interruptBriefing: null,
    requirements: [{ id: "REQ-001", text: "Verify every host boundary." }],
    requirementEvidence: [],
    budgets: {
      workflowSteps: { consumed: 2, limit: 100, remaining: 98 },
      cycles: { consumed: 0, completed: 0, limit: 20, remaining: 20 },
    },
    latestEvent: null,
    events: [],
    createdAt: now,
    updatedAt: now,
  };
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
  assert.equal(launchCount, 1);

  const sessionId = "extension-host-e2e";
  const sessionDir = await api.store.getSessionDir(sessionId);
  const paths = await api.store.getPathsConfig();
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, paths.sessionFileNames.state),
    JSON.stringify(
      fixtureProjection(
        sessionId,
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? dataRoot
      )
    ),
    "utf8"
  );
  await fs.writeFile(
    await api.store.getPlanChoicesPath(sessionId),
    JSON.stringify([{ id: "plan-1", title: "Bounded plan", body: "Verify every host boundary." }]),
    "utf8"
  );

  const projected = await api.store.readState(sessionId);
  assert.equal(projected?.stateVersion, 4);
  assert.equal(projected?.awaitingPlanApproval, true);
  await api.store.selectPlanChoice(sessionId, "plan-1");
  const approval = await api.store.approvePlan(sessionId);
  assert.equal(approval.selectedPlanChoiceId, "plan-1");
  assert.equal("updateState" in api.store, false);
  assert.equal(typeof api.client.stopSession, "function");
  assert.equal(typeof api.client.interruptSession, "function");

  const settings = await api.store.readSystemSettings();
  settings.toolAccess.webSearch.enabled = !settings.toolAccess.webSearch.enabled;
  await api.store.saveSystemSettings(settings);
  assert.equal(
    (await api.store.readSystemSettings()).toolAccess.webSearch.enabled,
    settings.toolAccess.webSearch.enabled
  );
  await configuration.update("pollIntervalMs", 321, vscode.ConfigurationTarget.Global);
  await waitFor(() => api.getConfig().pollIntervalMs === 321);

  const currentKey = namespacedMcpSecretStorageKey(
    "extension-host-e2e-namespace",
    "server",
    "headers",
    "Authorization"
  );
  const protectedReference = await protectMcpCredentialValue(
    "host-secret-sentinel",
    currentKey,
    api.context.secrets
  );
  assert.equal(protectedReference, `\${secret:${currentKey}}`);
  assert.equal(await api.context.secrets.get(currentKey), "host-secret-sentinel");
  await api.context.secrets.delete(currentKey);

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
  assert.equal(decideRecoveryAction("RUNNING", 4, runtime.disposition, false), "recover");

  console.log(
    "Extension Host E2E passed: trust gate, v4 projection, read-only state, plan selection, " +
    "settings, SecretStorage, and ownership recovery."
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}
