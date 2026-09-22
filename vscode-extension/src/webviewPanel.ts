import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  WebviewMessage,
  WebviewStatePayload,
  LoopState,
  LoopHistoryEntry,
  FinalSummary,
  ModelMapping,
  VariantMapping,
  ProviderMapping,
  SystemSettings,
  AccessMode,
  ExtensionConfig,
  readExtensionConfig,
  loadLoopVariantDefaults,
  loadCliProfilesConfig,
} from "./types";
import { StateStore } from "./stateStore";
import { LoopClient, LogEntry } from "./loopClient";

export class LoopWebviewPanel {
  private static instance: LoopWebviewPanel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private selectedSessionId: string | null = null;
  private lastOpenedPlanDocument: string | null = null;
  private providerCatalogRefresh: Promise<void> | null = null;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: StateStore,
    private readonly client: LoopClient,
    private readonly config: ExtensionConfig
  ) {
    this.store.onChange(() => this.refresh());
  }

  static getInstance(context: vscode.ExtensionContext, store: StateStore, client: LoopClient, config: ExtensionConfig): LoopWebviewPanel {
    if (!LoopWebviewPanel.instance) {
      LoopWebviewPanel.instance = new LoopWebviewPanel(context, store, client, config);
    }
    return LoopWebviewPanel.instance;
  }

  show(): void {
    void this.ensureProviderCatalog();
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "agentLoopPanel",
      "Agent Loop Orchestrator",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
          vscode.Uri.joinPath(this.context.extensionUri, "out"),
        ],
      }
    );

    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, undefined, this.context.subscriptions);

    this.refresh();
  }

  private async ensureProviderCatalog(): Promise<void> {
    if (this.providerCatalogRefresh) return this.providerCatalogRefresh;
    const operation = (async () => {
      const registry = await this.store.readRegistry();
      const entries = Object.values(registry.providerCatalog ?? {});
      const discoveredAtMs = Date.parse(registry.modelsDiscoveredAt ?? "");
      const catalogIsStale =
        !Number.isFinite(discoveredAtMs) || Date.now() - discoveredAtMs > 5 * 60 * 1000;
      const needsDiscovery =
        catalogIsStale ||
        entries.length === 0 ||
        entries.some((entry) => typeof entry.available !== "boolean");
      if (!needsDiscovery) return;
      const result = await this.client.discoverModels();
      if (result.exitCode !== 0) {
        console.warn(`[agentLoop] Automatic provider discovery failed: ${result.stderr}`);
      }
      await this.refresh();
    })();
    this.providerCatalogRefresh = operation;
    try {
      await operation;
    } finally {
      if (this.providerCatalogRefresh === operation) this.providerCatalogRefresh = null;
    }
  }

  postNewSession(opts: { goal: string; targetProjectPath: string }): void {
    this.show();
    const modelMapping: Partial<ModelMapping> = {};
    this.handleMessage({
      command: "newSession",
      requestId: `command-${Date.now()}`,
      goal: opts.goal,
      targetProjectPath: opts.targetProjectPath,
      accessMode: "ask",
      modelMapping,
    });
  }

  postResumeSession(sessionId: string): void {
    this.show();
    this.handleMessage({ command: "resumeSession", sessionId });
  }

  postDiscoverModels(): void {
    this.show();
    this.handleMessage({ command: "discoverModels" });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.command) {
      case "requestState":
        await this.refresh();
        break;
      case "newSession":
        await this.handleNewSession(msg);
        break;
      case "openPlanReview":
        await vscode.commands.executeCommand("agentLoop.openPlanReview", msg.sessionId);
        break;
      case "resumeSession":
        await this.handleResume(msg);
        break;
      case "resolveAccessRequest":
        await this.handleResolveAccessRequest(msg);
        break;
      case "setAccessMode":
        await this.handleSetAccessMode(msg);
        break;
      case "stopSession":
        await this.requestStopSession(msg.sessionId);
        vscode.window.showInformationMessage(`Agent Loop: Session ${msg.sessionId} stopped.`);
        await this.refresh();
        break;
      case "discoverModels":
        await this.handleDiscoverModels();
        break;
      case "setCliProfile": {
        const cfg = vscode.workspace.getConfiguration("agentLoop");
        const currentProfile = cfg.get<string>("cliProfile", "opencode");
        if (msg.profile && msg.profile !== currentProfile) {
          await cfg.update("cliProfile", msg.profile, vscode.ConfigurationTarget.Global);
          const profileDefaults: Record<string, string> = { opencode: "opencode", kilo: "kilo", codex: "codex", claude: "claude" };
          const expectedBinary = profileDefaults[msg.profile];
          if (expectedBinary) {
            const currentBinary = cfg.get<string>("cliBinary", "opencode");
            if (expectedBinary !== currentBinary) {
              await cfg.update("cliBinary", expectedBinary, vscode.ConfigurationTarget.Global);
            }
          }
        }
        break;
      }
      case "saveSystemSettings":
        await this.handleSaveSystemSettings(msg.settings);
        break;
      case "selectSession":
        this.selectedSessionId = msg.sessionId;
        await this.refresh();
        {
          const bundle = await this.store.readBundle(msg.sessionId);
          if (bundle.state?.cliProfile) {
            const cfg = vscode.workspace.getConfiguration("agentLoop");
            const currentProfile = cfg.get<string>("cliProfile", "opencode");
            if (bundle.state.cliProfile !== currentProfile) {
              await cfg.update("cliProfile", bundle.state.cliProfile, vscode.ConfigurationTarget.Global);
              const profileDefaults: Record<string, string> = { opencode: "opencode", kilo: "kilo", codex: "codex", claude: "claude" };
              const expectedBinary = profileDefaults[bundle.state.cliProfile];
              if (expectedBinary) {
                const currentBinary = cfg.get<string>("cliBinary", "opencode");
                if (expectedBinary !== currentBinary) {
                  await cfg.update("cliBinary", expectedBinary, vscode.ConfigurationTarget.Global);
                }
              }
            }
          }
        }
        break;
      case "refreshModels":
        await this.handleDiscoverModels();
        break;
      case "openProgressNotes":
        await this.openProgressNotes(msg.sessionId);
        break;
      case "openFinalSummary":
        await this.openFinalSummary(msg.sessionId);
        break;
      case "deleteSession":
        await this.handleDeleteSession(msg.sessionId);
        break;
      case "openSessionFolder": {
        const sessionDir = await this.store.getSessionDir(msg.sessionId);
        await fs.promises.mkdir(sessionDir, { recursive: true });
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(sessionDir));
        break;
      }
      case "interruptSession": {
        const sessionDir = await this.store.getSessionDir(msg.sessionId);
        const cfg = await this.store.getPathsConfig();
        await this.client.interruptSession(msg.sessionId, msg.message);
        const statePath = path.join(sessionDir, cfg.sessionFileNames.state);
        let planPath: string | null = null;
        let fallbackContent: string | null = null;
        try {
          const stateRaw = await fs.promises.readFile(statePath, "utf8");
          const loopState: LoopState = JSON.parse(stateRaw);
          planPath = loopState.planPath || path.join(sessionDir, cfg.sessionFileNames.plan);
          fallbackContent = loopState.refinedGoal || loopState.goal || "";
        } catch {
          // state file may not exist yet
        }
        try {
          if (planPath) {
            await fs.promises.access(planPath);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(planPath));
            await this.showMarkdownPreview(doc);
          } else if (fallbackContent) {
            const doc = await vscode.workspace.openTextDocument({
              content: `# Agent Loop Plan \u2014 ${msg.sessionId}\n\n${fallbackContent}`,
              language: "markdown",
            });
            await this.showMarkdownPreview(doc);
          }
        } catch { /* plan file may not exist */ }
        vscode.window.showInformationMessage(`Interrupt sent to ${msg.sessionId}. Plan document opened.`);
        break;
      }
    }
  }

  public selectSession(sessionId: string): void {
    this.selectedSessionId = sessionId;
    this.show();
    this.refresh();
  }

  postFocusComposer(): void {
    this.show();
    this.postMessage({ command: "focusComposer" });
  }

  private async handleNewSession(msg: { requestId: string; goal: string; targetProjectPath: string; accessMode: AccessMode; modelMapping: Partial<ModelMapping>; providerMapping?: Partial<ProviderMapping>; variantMapping?: Partial<VariantMapping> }): Promise<void> {
    if (!msg.goal || msg.goal.trim().length === 0) {
      this.postMessage({ command: "newSessionResult", requestId: msg.requestId, error: "Goal is required." });
      vscode.window.showErrorMessage("Goal is required.");
      return;
    }
    const target = msg.targetProjectPath && msg.targetProjectPath.length > 0
      ? msg.targetProjectPath
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try {
      const sessionId = await this.client.startNewSession({
        goal: msg.goal,
        targetProjectPath: target,
        accessMode: msg.accessMode === "full_access" ? "full_access" : "ask",
        modelMapping: msg.modelMapping,
        providerMapping: msg.providerMapping,
        variantMapping: msg.variantMapping,
      });
      this.selectedSessionId = sessionId;
      this.attachLogListener(sessionId);
      vscode.window.showInformationMessage(`Agent Loop: Started session ${sessionId}`);
      await this.refresh().catch(() => { /* The session was created; a refresh failure must not invite duplicate startup. */ });
      this.postMessage({ command: "newSessionResult", requestId: msg.requestId, sessionId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.postMessage({ command: "newSessionResult", requestId: msg.requestId, error: errMsg });
      vscode.window.showErrorMessage(`Failed to start session: ${errMsg}`);
    }
  }

  private async handleResume(msg: { sessionId: string }): Promise<void> {
    try {
      const state = await this.store.readState(msg.sessionId);
      if (state?.pendingAccessRequest) {
        vscode.window.showWarningMessage(
          "Agent Loop: Approve the pending access request or grant full access before resuming."
        );
        return;
      }
      await this.client.resumeSession(msg.sessionId);
      this.selectedSessionId = msg.sessionId;
      this.attachLogListener(msg.sessionId);
      vscode.window.showInformationMessage(`Agent Loop: Resumed session ${msg.sessionId}`);
      await this.refresh();
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to resume session: ${msgText}`);
    }
  }

  private async handleDiscoverModels(): Promise<void> {
    try {
      const result = await this.client.discoverModels();
      const registry = await this.store.readRegistry();
      const discoveredCount = (registry.availableModels || []).length;
      const availableProviderCount = Object.values(registry.providerCatalog ?? {})
        .filter((provider) => provider.enabled && provider.available).length;
      if (result.exitCode !== 0) {
        const stderrHint = result.stderr ? ` Stderr: ${result.stderr.slice(0, 400)}` : "";
        vscode.window.showWarningMessage(
          `Agent Loop: Model discovery failed (exit ${result.exitCode}).${stderrHint}\nCommand: ${result.command}`
        );
      } else if (discoveredCount === 0) {
        vscode.window.showWarningMessage(
          `Agent Loop: Discovered 0 models. The orchestrator ran successfully but found no models.\n` +
          `Verify '${this.config.cliBinary} models' works in a terminal.\n` +
          `Command: ${result.command}` +
          (result.stderr ? `\nStderr: ${result.stderr.slice(0, 300)}` : "")
        );
      } else {
        vscode.window.showInformationMessage(
          `Agent Loop: Found ${availableProviderCount} installed provider(s) and ${discoveredCount} model(s).`
        );
      }
      await this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Model discovery failed: ${msg}`);
    }
  }

  private async handleDeleteSession(sessionId: string): Promise<void> {
    if (!sessionId || sessionId.length === 0) return;
    const confirm = await vscode.window.showWarningMessage(
      `Delete session "${sessionId}"? This removes all loop state, history, and progress notes for this session. This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") return;

    const preparation = await this.client.prepareSessionDeletion(sessionId);
    if (!preparation.safe) {
      vscode.window.showWarningMessage(
        `Agent Loop: Session cannot be deleted safely yet. ${preparation.reason}`
      );
      return;
    }

    const result = await this.store.deleteSession(sessionId);
    if (this.selectedSessionId === sessionId) {
      this.selectedSessionId = null;
    }
    this.client.clearSessionLog(sessionId);
    this.client.removeLogListener(sessionId);
    this.client.removeExitListener(sessionId);

    if (result.error) {
      vscode.window.showWarningMessage(`Agent Loop: Partial delete — ${result.error}`);
    } else if (result.removedFromRegistry && result.dirRemoved) {
      vscode.window.showInformationMessage(`Agent Loop: Session "${sessionId}" deleted.`);
    } else if (result.removedFromRegistry) {
      vscode.window.showInformationMessage(`Agent Loop: Session "${sessionId}" removed from registry.`);
    } else {
      vscode.window.showInformationMessage(`Agent Loop: Session "${sessionId}" was not found.`);
    }
    await this.refresh();
  }

  async requestStopSession(sessionId: string): Promise<void> {
    await this.client.stopSession(sessionId);
  }

  registerSessionListeners(sessionId: string): void {
    this.attachLogListener(sessionId);
  }

  private attachLogListener(sessionId: string): void {
    this.client.onLog(sessionId, (entry: LogEntry) => {
      this.postMessage({ command: "logAppend", sessionId, entry });
    });
    this.client.onExit(sessionId, async () => {
      await this.refresh();
      const bundle = await this.store.readBundle(sessionId);
      if (bundle.state?.status === "SUCCESS") {
        vscode.window.showInformationMessage(
          `Agent Loop: Session ${sessionId} completed successfully.`
        );
      } else if (bundle.state?.status === "FAILED") {
        vscode.window.showWarningMessage(
          `Agent Loop: Session ${sessionId} failed.`
        );
      }
      setTimeout(() => {
        this.client.removeLogListener(sessionId);
        this.client.removeExitListener(sessionId);
      }, 5000);
    });
  }

  private refreshPending: Promise<void> | null = null;

  private async refresh(): Promise<void> {
    if (!this.panel) return;
    if (this.refreshPending) {
      return this.refreshPending;
    }
    this.refreshPending = this.doRefresh();
    try {
      await this.refreshPending;
    } finally {
      this.refreshPending = null;
    }
  }

  private async doRefresh(): Promise<void> {
    if (!this.panel) return;
    let registry = await this.store.readRegistry();

    if (this.selectedSessionId && !registry.sessionMetas.some((m) => m.sessionId === this.selectedSessionId)) {
      this.selectedSessionId = null;
    }

    if (!this.selectedSessionId && registry.sessionMetas.length > 0) {
      const running = registry.sessionMetas.find((m) => m.status === "RUNNING");
      this.selectedSessionId = running?.sessionId ?? registry.sessionMetas[0].sessionId;
    }

    let state: LoopState | null = null;
    let progressNotes = "";
    let history: LoopHistoryEntry[] = [];
    let finalSummary: FinalSummary | null = null;

    if (this.selectedSessionId) {
      const bundle = await this.store.readBundle(this.selectedSessionId);
      state = bundle.state;
      progressNotes = bundle.progressNotes;
      history = bundle.history;
      finalSummary = bundle.finalSummary;

      const planDocumentPath =
        state?.awaitingPlanApproval &&
        state.selectedPlanChoiceId === null &&
        state.planOverviewPath
          ? state.planOverviewPath
          : state?.planPath ?? null;
      const planDocumentKey =
        state?.status === "WAITING_USER" && planDocumentPath
          ? `${this.selectedSessionId}:${planDocumentPath}`
          : null;
      if (planDocumentKey && this.lastOpenedPlanDocument !== planDocumentKey) {
        this.lastOpenedPlanDocument = planDocumentKey;
        try {
          await fs.promises.access(planDocumentPath!);
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(planDocumentPath!));
          await this.showMarkdownPreview(doc, true);
        } catch { /* plan document does not exist yet */ }
        try {
          await vscode.commands.executeCommand("agentLoop.openPlanReview", this.selectedSessionId);
        } catch { /* view may not be registered yet */ }
      } else if (state?.status !== "WAITING_USER") {
        this.lastOpenedPlanDocument = null;
      }
    }

    const isRunning = state?.status === "RUNNING";
    const runtime = this.selectedSessionId
      ? await this.store.inspectLease(this.selectedSessionId)
      : null;
    const runtimeLeaseStatus = runtime?.disposition ?? null;
    if (
      this.selectedSessionId &&
      state?.status === "RUNNING" &&
      !this.client.isRunning(this.selectedSessionId) &&
      runtime &&
      (runtime.disposition === "active" || runtime.disposition === "expired_owner_alive")
    ) {
      this.attachLogListener(this.selectedSessionId);
      this.client.followExternalSession(this.selectedSessionId);
    }

    const defaultTargetPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const liveCfg = readExtensionConfig();
    const rootDir = await this.store.getRootDir();
    const variantDefaults = await loadLoopVariantDefaults(rootDir);
    const cliProfiles = await loadCliProfilesConfig(rootDir);
    const systemSettings = await this.store.readSystemSettings();

    const payload: WebviewStatePayload = {
      registry,
      selectedSessionId: this.selectedSessionId,
      state,
      progressNotes,
      history,
      finalSummary,
      isRunning,
      defaultTargetPath,
      cliProfile: liveCfg.cliProfile,
      modelsDiscoveredCli: registry.modelsDiscoveredCli ?? null,
      modelVariants: registry.modelVariants ?? null,
      variantMapping: state?.variantMapping ?? {},
      variantDefaults,
      cliProfiles,
      systemSettings,
      runtimeLeaseStatus,
      sessionLog: this.selectedSessionId ? this.client.getSessionLog(this.selectedSessionId) : "",
    };

    this.postMessage({ command: "stateUpdate", payload });
  }

  private async showMarkdownPreview(
    document: vscode.TextDocument,
    preserveFocus = false
  ): Promise<void> {
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: true,
      preserveFocus,
    });
    await vscode.commands.executeCommand("markdown.showPreview", document.uri);
  }

  private async handleSaveSystemSettings(settings: SystemSettings): Promise<void> {
    try {
      await this.store.saveSystemSettings(settings);
      this.postMessage({ command: "settingsSaveResult", settings: await this.store.readSystemSettings() });
      vscode.window.showInformationMessage("Agent Loop: Provider, MCP/web, and pipeline settings saved.");
      await this.handleDiscoverModels();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ command: "settingsSaveResult", error: message });
      vscode.window.showErrorMessage(`Failed to save Agent Loop settings: ${message}`);
    }
  }

  private async handleResolveAccessRequest(msg: { sessionId: string; decision: "allow_requested" | "full_access" }): Promise<void> {
    try {
      await this.client.resumeSession(msg.sessionId, false, msg.decision);
      this.selectedSessionId = msg.sessionId;
      this.attachLogListener(msg.sessionId);
      vscode.window.showInformationMessage(
        msg.decision === "full_access"
          ? "Agent Loop: Full access granted; session resumed."
          : "Agent Loop: Requested access granted; session resumed."
      );
      await this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to approve access: ${message}`);
    }
  }

  private async handleSetAccessMode(msg: { sessionId: string; accessMode: AccessMode }): Promise<void> {
    try {
      await this.store.updateAccessMode(msg.sessionId, msg.accessMode);
      vscode.window.showInformationMessage(
        msg.accessMode === "full_access"
          ? "Agent Loop: Full access enabled for this session."
          : "Agent Loop: Access mode set to Ask when needed."
      );
      await this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to update access mode: ${message}`);
    }
  }

  private async openProgressNotes(sessionId: string): Promise<void> {
    try {
      const sessionDir = await this.store.getSessionDir(sessionId);
      const cfg = await this.store.getPathsConfig();
      const notesPath = path.join(sessionDir, cfg.sessionFileNames.progressNotes);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(notesPath));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to open progress notes: ${msg}`);
    }
  }

  private async openFinalSummary(sessionId: string): Promise<void> {
    try {
      const sessionDir = await this.store.getSessionDir(sessionId);
      const cfg = await this.store.getPathsConfig();
      const summaryPath = path.join(sessionDir, cfg.sessionFileNames.finalSummary);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(summaryPath));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to open final summary (session may not be complete yet): ${msg}`);
    }
  }

  private postMessage(msg: unknown): void {
    if (this.panel) {
      this.panel.webview.postMessage(msg).then(
        () => {},
        (err) => console.error("[WebviewPanel] postMessage failed:", err)
      );
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "webview.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "webview.js"));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Loop Orchestrator</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div id="root">
    <div class="loading">Loading...</div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const crypto = require("node:crypto");
  return crypto.randomBytes(16).toString("base64");
}
