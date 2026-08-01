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
});
