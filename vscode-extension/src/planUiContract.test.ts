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

function manifest(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")) as Record<string, unknown>;
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
  assert.match(webview, /Unsafe mode: the provider/);
  assert.match(webview, /command:\s*"resolveAccessRequest"/);
  assert.doesNotMatch(webview, /composer-allowed-paths|session-allowed-paths/);
  assert.match(panel, /handleResolveAccessRequest/);
  assert.match(panel, /confirmUnsafeFullAccess/);
  assert.match(panel, /Enable Unsafe Full Access/);
  assert.match(panel, /not a filesystem security boundary/);
  assert.match(store, /updateAccessMode/);
  assert.match(client, /args\.push\("--approve-access"\)/);
  assert.match(client, /args\.push\("--full-access"\)/);
});

test("operator status and timeline are projected from aggregate domain events", () => {
  const panel = source("webviewPanel.ts");
  const store = source("stateStore.ts");
  const webview = media("webview.js");
  const readBundle = store.match(/async readBundle[\s\S]*?\n  }/)?.[0] ?? "";
  assert.match(panel, /deriveExtensionOperatorSnapshot\(state\)/);
  assert.match(panel, /timeline = state\?\.domainEvents \?\? \[\]/);
  assert.doesNotMatch(readBundle, /readHistory/);
  assert.match(webview, /Domain Timeline/);
  assert.match(webview, /state\.timeline/);
  assert.doesNotMatch(webview, /state\.history/);
  assert.match(webview, /Next action/);
  assert.match(webview, /Cycle budget/);
  assert.match(webview, /Workflow steps/);
  assert.match(webview, /Stage attempts/);
  assert.match(webview, /Completion recovery/);
  assert.match(webview, /Phase recovery/);
});

test("the real Extension Host E2E runner covers all lifecycle boundaries", () => {
  const suite = source(path.join("test", "extensionHostSuite.ts"));
  const packageJson = manifest() as { scripts?: Record<string, string> };
  assert.match(packageJson.scripts?.["test:host"] ?? "", /runExtensionHostE2E/);
  assert.match(suite, /launchTrusted\(false/);
  assert.match(suite, /selectPlanChoice/);
  assert.match(suite, /approvePlan/);
  assert.match(suite, /updateAccessMode/);
  assert.match(suite, /stopSession/);
  assert.match(suite, /interruptSession/);
  assert.match(suite, /decideRecoveryAction/);
  assert.match(suite, /saveSystemSettings/);
  assert.match(suite, /protectMcpCredentialValue/);
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

test("settings omit the graph editor while supporting split file-only loop configuration", () => {
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
  assert.doesNotMatch(webview, /Add agent|Add stage|Stage types|data-settings-tab="stages"/);
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

test("external process entry points are trust-gated and model discovery is explicit", () => {
  const extension = source("extension.ts");
  const client = source("loopClient.ts");
  const panel = source("webviewPanel.ts");
  const types = source("types.ts");
  assert.match(extension, /vscode\.workspace\.isTrusted/);
  assert.ok(
    extension.indexOf("if (!activationAllowed)") < extension.indexOf("config = readExtensionConfig()"),
    "the trust gate must run before configuration reads"
  );
  assert.match(
    extension,
    /runWithIsolatedDataRoot\(root,[\s\S]*await store!\.ensureInitialized\(\)/
  );
  assert.doesNotMatch(types, /cfg\.update\(/);
  assert.match(client, /assertWorkspaceTrusted\("discover models"\)/);
  assert.match(client, /assertWorkspaceTrusted\("start a session"\)/);
  assert.match(client, /assertWorkspaceTrusted\(recovery \? "recover a session" : "resume a session"\)/);
  assert.match(client, /assertWorkspaceTrusted\("revise a plan"\)/);
  assert.doesNotMatch(panel, /ensureProviderCatalog/);
  assert.doesNotMatch(panel, /Automatic provider discovery/);
});

test("manifest disables unsafe workspace modes and declares every context command", () => {
  const pkg = manifest() as {
    capabilities?: { untrustedWorkspaces?: { supported?: boolean }; virtualWorkspaces?: { supported?: boolean } };
    contributes?: {
      commands?: Array<{ command?: string }>;
      viewsContainers?: { activitybar?: Array<{ icon?: string }> };
      configuration?: { properties?: Record<string, { scope?: string; restricted?: boolean }> };
    };
  };
  assert.equal(pkg.capabilities?.untrustedWorkspaces?.supported, false);
  assert.equal(pkg.capabilities?.virtualWorkspaces?.supported, false);
  assert.ok(pkg.contributes?.commands?.some((entry) => entry.command === "agentLoop.openProgressNotes"));
  assert.equal(pkg.contributes?.viewsContainers?.activitybar?.[0]?.icon, "media/icon.svg");
  const properties = pkg.contributes?.configuration?.properties ?? {};
  for (const setting of ["agentLoop.cliBinary", "agentLoop.cliProfile", "agentLoop.rootDir", "agentLoop.nodeBinary", "agentLoop.orchestratorScript"]) {
    assert.equal(properties[setting]?.scope, "machine", `${setting} must be machine-scoped`);
    assert.equal(properties[setting]?.restricted, true, `${setting} must be restricted`);
  }
});

test("logs and busy completion are isolated by session and operation", () => {
  const webview = media("webview.js");
  const planReview = source("planReviewView.ts");
  assert.match(webview, /const logBuffers = Object\.create\(null\)/);
  assert.match(webview, /logBuffers\[sessionId\]/);
  assert.doesNotMatch(webview, /let logBuffer =/);
  assert.match(planReview, /operation:\s*"interruptSession"/);
  assert.match(planReview, /msg\.operation === "revisePlan" \|\| msg\.operation === "interruptSession"/);
});
