import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function source(fileName: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", "src", fileName), "utf8");
}

function media(fileName: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", "media", fileName), "utf8");
}

test("plan review sidebar contains controls but no plan body previews", () => {
  const planReview = source("planReviewView.ts");
  assert.doesNotMatch(planReview, /choice-preview/);
  assert.doesNotMatch(planReview, /plan-preview/);
  assert.doesNotMatch(planReview, /c\.body/);
  assert.match(planReview, /openPlanOverview/);
  assert.match(planReview, /openSelectedPlan/);
  assert.match(planReview, /selectedPlanChoiceId/);
});

test("plan documents render as Markdown previews in the center editor column", () => {
  const planReview = source("planReviewView.ts");
  const mainPanel = source("webviewPanel.ts");
  assert.match(planReview, /viewColumn:\s*vscode\.ViewColumn\.One/);
  assert.match(mainPanel, /viewColumn:\s*vscode\.ViewColumn\.One/);
  assert.match(planReview, /executeCommand\("markdown\.showPreview",\s*documentUri\)/);
  assert.match(mainPanel, /executeCommand\("markdown\.showPreview",\s*document\.uri\)/);
  assert.doesNotMatch(planReview, /ViewColumn\.Beside/);
  assert.doesNotMatch(mainPanel, /ViewColumn\.Beside/);
});

test("the main panel reopens the selected plan instead of the choices overview", () => {
  const mainPanel = source("webviewPanel.ts");
  assert.match(
    mainPanel,
    /state\.selectedPlanChoiceId === null[\s\S]*state\.planOverviewPath/
  );
});

test("extension recovery is recurring and wakes immediately after a core exit", () => {
  const extension = source("extension.ts");
  const client = source("loopClient.ts");
  assert.match(extension, /startRecoveryMonitor/);
  assert.match(extension, /setInterval\(wakeup,\s*intervalMs\)/);
  assert.match(client, /this\.recoveryWakeup\?\.\(\)/);
});

test("access approval and full-access modes flow from the panel through state and CLI", () => {
  const panel = source("webviewPanel.ts");
  const store = source("stateStore.ts");
  const client = source("loopClient.ts");
  const webview = media("webview.js");
  assert.match(webview, /Ask when needed/);
  assert.match(webview, /Allow &amp; Resume/);
  assert.match(webview, /Allow Full Access &amp; Resume/);
  assert.match(webview, /command:\s*"resolveAccessRequest"/);
  assert.doesNotMatch(webview, /composer-allowed-paths|session-allowed-paths/);
  assert.match(panel, /handleResolveAccessRequest/);
  assert.match(store, /updateAccessMode/);
  assert.match(client, /args\.push\("--approve-access"\)/);
  assert.match(client, /args\.push\("--full-access"\)/);
});

test("completion recovery configuration and activity mode reach the CLI and status UI", () => {
  const client = source("loopClient.ts");
  const types = source("types.ts");
  const webview = media("webview.js");
  assert.match(client, /--completion-recovery-attempts/);
  assert.match(types, /maxCompletionRecoveryAttempts/);
  assert.match(webview, /completion recovery/);
  assert.match(webview, /completionRecoveryNumber/);
});

test("token-aware hold statuses and scheduled recovery reach the extension UI", () => {
  const client = source("loopClient.ts");
  const extension = source("extension.ts");
  const types = source("types.ts");
  const webview = media("webview.js");
  assert.match(client, /--automatic-recovery-cycles/);
  assert.match(client, /--automatic-recovery-backoff/);
  assert.match(extension, /state\.status !== "RECOVERING"/);
  assert.match(types, /"WAITING_USER"/);
  assert.match(types, /"RECOVERING"/);
  assert.match(types, /"STOPPED"/);
  assert.match(types, /"BLOCKED"/);
  assert.match(webview, /statusReason/);
  assert.match(webview, /automaticRecovery/);
  assert.match(webview, /Cancel Recovery/);
  assert.match(client, /Operator cancelled the scheduled automatic recovery/);
});

test("locked reference identity is visible in session status", () => {
  const types = source("types.ts");
  const webview = media("webview.js");
  assert.match(types, /referenceIdentity/);
  assert.match(types, /candidateCount/);
  assert.match(webview, /st\.referenceIdentity\?\.packageId/);
  assert.match(webview, />Reference</);
  assert.match(webview, /identityMatch/);
});

test("settings support role and stage editing with split configuration files", () => {
  const panel = source("webviewPanel.ts");
  const store = source("stateStore.ts");
  const client = source("loopClient.ts");
  const types = source("types.ts");
  const extension = source("extension.ts");
  const webview = media("webview.js");
  const css = media("webview.css");
  assert.match(webview, /Model providers \/ agent CLIs/);
  assert.match(webview, /Each provider is the installed agent CLI/);
  assert.match(webview, /Models reported by the selected provider only/);
  assert.match(webview, /buildProviderModelOptions\(provider, current\)/);
  assert.doesNotMatch(webview, /data-field="model-provider"/);
  assert.doesNotMatch(panel, /modelCatalog\.js/);
  assert.match(webview, /Agent model assignments/);
  assert.match(webview, /MCP servers/);
  assert.match(webview, /applied to every agent in the pipeline/);
  assert.doesNotMatch(webview, /Agent tool access/);
  assert.match(webview, /Add MCP server/);
  assert.match(webview, /data-settings-tab="models"/);
  assert.match(webview, /data-settings-tab="tools"/);
  assert.match(webview, /settingsSection === "models"/);
  assert.match(webview, /settingsSection === "tools"/);
  assert.match(webview, /data-settings-tab="stages"/);
  assert.match(extension, /agentLoopPlanReview\.focus/);
  assert.doesNotMatch(panel, /agentLoop\.planReviewView\.focus/);
  assert.doesNotMatch(panel, /pipelineEditor\.js/);
  assert.match(webview, /data-field="provider"/);
  assert.match(webview, /provider\.available === true/);
  assert.match(webview, /Models reported by the selected provider only/);
  assert.match(webview, /settings-model-select/);
  assert.match(webview, /Select a provider first/);
  assert.match(webview, /provider\.modelLabels/);
  assert.match(webview, /provider\.modelVariants/);
  assert.match(webview, /providerMapping/);
  assert.match(css, /\.model-choice-select/);
  assert.match(css, /min-height:\s*34px/);
  assert.match(css, /\.model-assignment-grid/);
  assert.match(webview, /command:\s*"saveSystemSettings"/);
  assert.match(panel, /handleSaveSystemSettings/);
  assert.match(store, /saveSystemSettings/);
  assert.match(store, /fixedPipelineDefinition/);
  assert.match(store, /combinePipelineDefinitions/);
  assert.match(store, /agent_roles\.json/);
  assert.match(store, /agent_loop\.json/);
  assert.match(store, /normalizePipelineStageTypes/);
  assert.match(types, /ProviderAdapter/);
  assert.match(client, /--provider-mapping/);
  assert.doesNotMatch(client, /--pipeline/);
  assert.doesNotMatch(types, /pipelineConfigPath:\s*string;/);
  assert.doesNotMatch(extension, /openPipelineConfig/);
});
