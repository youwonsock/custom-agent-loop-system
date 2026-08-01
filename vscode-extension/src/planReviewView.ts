import * as vscode from "vscode";
import { PlanChoice, PlanReviewStatePayload, PlanReviewSessionInfo, LoopState, readExtensionConfig } from "./types";
import { StateStore } from "./stateStore";
import { LoopClient } from "./loopClient";
import { LoopWebviewPanel } from "./webviewPanel";

export class PlanReviewViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private selectedSessionId: string | null = null;
  private lastAutoOpenedDocumentKey: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: StateStore,
    private readonly client: LoopClient
  ) {
    this.store.onChange(() => this.refresh());
  }

  selectSession(sessionId: string | null): void {
    this.selectedSessionId = sessionId;
    this.refresh();
  }

  private registerMainPanelListeners(sessionId: string): void {
    LoopWebviewPanel.getInstance(
      this.context,
      this.store,
      this.client,
      readExtensionConfig()
    ).registerSessionListeners(sessionId);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: any) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions
    );

    this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.view) return;
    await this.pushState();
  }

  private async pushState(): Promise<void> {
    if (!this.view) return;

    const registry = await this.store.readRegistry();
    const sessionMetas = registry.sessionMetas;

    const sessions: PlanReviewSessionInfo[] = [];
    const stateCache = new Map<string, LoopState | null>();
    for (const m of sessionMetas) {
      let st: LoopState | null = null;
      try {
        const bundle = await this.store.readBundle(m.sessionId);
        st = bundle.state;
      } catch { /* ignore */ }
      stateCache.set(m.sessionId, st);
      sessions.push({
        sessionId: m.sessionId,
        status: m.status,
        goal: m.goal,
        phase: st?.phase ?? null,
        awaitingPlanApproval: st?.awaitingPlanApproval ?? false,
        interruptStageId: st?.pipeline?.interruptStageId ?? "INTERRUPT",
      });
    }

    const needsAttention = (sid: string): boolean => {
      const st = stateCache.get(sid);
      if (!st) return false;
      return st.awaitingPlanApproval || st.phase === (st.pipeline?.interruptStageId ?? "INTERRUPT");
    };

    const isValid = (sid: string | null): boolean =>
      !!sid && sessionMetas.some((m) => m.sessionId === sid);

    if (sessions.length === 0) {
      this.selectedSessionId = null;
      this.postMessage({ command: "stateUpdate", payload: this.emptyPayload(sessions) });
      return;
    }

    if (!isValid(this.selectedSessionId)) {
      this.selectedSessionId = null;
    }

    const currentNeedsAttention = this.selectedSessionId && needsAttention(this.selectedSessionId);
    if (!currentNeedsAttention) {
      const attention = sessions.find((s) => needsAttention(s.sessionId));
      if (attention) {
        this.selectedSessionId = attention.sessionId;
      } else if (!this.selectedSessionId) {
        const paused = sessions.find((s) =>
          ["PAUSED", "WAITING_USER", "STOPPED", "BLOCKED"].includes(s.status)
        );
        const running = sessions.find((s) => s.status === "RUNNING");
        this.selectedSessionId = paused?.sessionId ?? running?.sessionId ?? sessions[0].sessionId;
      }
    }

    const sessionId = this.selectedSessionId;
    if (!sessionId) {
      this.postMessage({ command: "stateUpdate", payload: this.emptyPayload(sessions) });
      return;
    }
    const state = stateCache.get(sessionId) ?? null;

    let choices: PlanChoice[] | null = null;
    let planMd: string | null = null;

    if (state) {
      if (state.awaitingPlanApproval) {
        choices = await this.store.readPlanChoices(sessionId);
      }
      planMd = await this.store.readPlanMd(sessionId);
    }

    const payload: PlanReviewStatePayload = {
      sessionId,
      awaitingPlanApproval: state?.awaitingPlanApproval ?? false,
      planApproved: state?.planApproved ?? false,
      choices,
      planMd,
      isPaused: Boolean(
        state && ["PAUSED", "WAITING_USER", "STOPPED", "BLOCKED"].includes(state.status)
      ),
      phase: state?.phase ?? null,
      interruptBriefing: state?.interruptBriefing ?? null,
      planRevisionPending: state?.planRevisionPending ?? false,
      interruptStageId: state?.pipeline?.interruptStageId ?? "INTERRUPT",
      selectedPlanChoiceId: state?.selectedPlanChoiceId ?? null,
      sessions,
    };

    this.postMessage({ command: "stateUpdate", payload });
    if (state?.awaitingPlanApproval && state.status === "WAITING_USER") {
      await this.autoOpenPlanOverview(sessionId);
    } else {
      this.lastAutoOpenedDocumentKey = null;
    }
  }

  private emptyPayload(sessions: PlanReviewSessionInfo[] = []): PlanReviewStatePayload {
    return { sessionId: "", awaitingPlanApproval: false, planApproved: false, choices: null, planMd: null, isPaused: false, phase: null, interruptBriefing: null, planRevisionPending: false, interruptStageId: "INTERRUPT", selectedPlanChoiceId: null, sessions };
  }

  private postMessage(msg: unknown): void {
    if (this.view) {
      this.view.webview.postMessage(msg).then(
        () => {},
        (err) => console.error("[PlanReviewView] postMessage failed:", err)
      );
    }
  }

  private async openPlanDocument(
    sessionId: string,
    kind: "overview" | "selected",
    preserveFocus = false
  ): Promise<void> {
    const documentPath =
      kind === "overview"
        ? await this.store.getPlanOverviewPath(sessionId)
        : await this.store.getPlanMdPath(sessionId);
    const documentUri = vscode.Uri.file(documentPath);
    const document = await vscode.workspace.openTextDocument(documentUri);
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: true,
      preserveFocus,
    });
    await vscode.commands.executeCommand("markdown.showPreview", documentUri);
  }

  private async autoOpenPlanOverview(sessionId: string): Promise<void> {
    try {
      const overviewPath = await this.store.getPlanOverviewPath(sessionId);
      const key = `${sessionId}:${overviewPath}`;
      if (this.lastAutoOpenedDocumentKey === key) return;
      await this.openPlanDocument(sessionId, "overview", true);
      this.lastAutoOpenedDocumentKey = key;
    } catch {
      // The overview can be observed between state commit and file visibility.
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.command) {
      case "requestPlanReviewState":
        await this.pushState();
        break;
      case "selectSession": {
        this.selectedSessionId = msg.sessionId ?? null;
        await this.pushState();
        break;
      }
      case "selectPlanChoice": {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        if (msg.choiceId === -1) {
          try {
            await this.store.clearPlanChoice(sessionId);
            await this.openPlanDocument(sessionId, "overview");
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to return to plan options: ${errMsg}`);
          }
          await this.pushState();
          break;
        }
        try {
          const selected = await this.store.selectPlanChoice(sessionId, msg.choiceId);
          await this.openPlanDocument(sessionId, "selected");
          vscode.window.showInformationMessage(`Plan option "${selected.choice.title}" selected.`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to select plan option: ${errMsg}`);
        }
        await this.pushState();
        break;
      }
      case "openPlanOverview": {
        if (!msg.sessionId) return;
        try {
          await this.openPlanDocument(msg.sessionId, "overview");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to open plan options: ${errMsg}`);
        }
        break;
      }
      case "openSelectedPlan": {
        if (!msg.sessionId) return;
        try {
          await this.openPlanDocument(msg.sessionId, "selected");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to open plan document: ${errMsg}`);
        }
        break;
      }
      case "revisePlan": {
        const sessionId = msg.sessionId;
        if (!sessionId || !msg.message) return;
        try {
          vscode.window.showInformationMessage(`Revising plan for ${sessionId}...`);
          const result = await this.client.revisePlan(sessionId, msg.message);
          if (result.exitCode === 0) {
            vscode.window.showInformationMessage(`Plan revised for ${sessionId}.`);
            await this.openPlanDocument(sessionId, "selected", true).catch(() => {});
          } else {
            vscode.window.showWarningMessage(`Plan revision completed with exit code ${result.exitCode}.`);
          }
          await this.pushState();
        } finally {
          void this.view?.webview.postMessage({
            command: "operationComplete",
            operation: "revisePlan",
          });
        }
        break;
      }
      case "approvePlan": {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        try {
          await this.store.approvePlan(sessionId);
          vscode.window.showInformationMessage(`Plan approved for ${sessionId}. Resuming session...`);
          await this.client.resumeSession(sessionId);
          this.registerMainPanelListeners(sessionId);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to approve plan: ${errMsg}`);
        }
        await this.pushState();
        break;
      }
      case "resumeSession": {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        await this.client.resumeSession(sessionId);
        this.registerMainPanelListeners(sessionId);
        vscode.window.showInformationMessage(`Resumed session ${sessionId}`);
        await this.pushState();
        break;
      }
      case "interruptSession": {
        const sessionId = msg.sessionId;
        if (!sessionId || !msg.message) return;
        try {
          await this.client.interruptSession(sessionId, msg.message);
          vscode.window.showInformationMessage(`Message sent to ${sessionId}. Resuming...`);
          this.registerMainPanelListeners(sessionId);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to send interrupt message: ${errMsg}`);
        }
        await this.pushState();
        break;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family, -apple-system, sans-serif); font-size: 12px; color: var(--vscode-foreground); padding: 8px; }
    h3 { font-size: 1em; margin-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .choice-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 8px;
      cursor: pointer;
    }
    .choice-card:hover { background: var(--vscode-list-hoverBackground); }
    .choice-card.selected { border-color: var(--vscode-focusBorder); }
    .choice-card.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .choice-title { font-weight: 600; }
    .choice-marker { float: right; color: var(--vscode-testing-iconPassed, #4caf50); }
    .document-hint {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }
    .selected-plan {
      border-left: 3px solid var(--vscode-focusBorder);
      padding: 6px 8px;
      margin-bottom: 8px;
      background: var(--vscode-editor-background);
    }
    .selected-plan-label {
      display: block;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      margin-bottom: 2px;
    }
    .chat-area {
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 8px;
      margin-top: auto;
    }
    .chat-area textarea {
      width: 100%;
      min-height: 48px;
      resize: vertical;
      font-family: inherit;
      font-size: 12px;
      padding: 6px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
    }
    .chat-area textarea:disabled { opacity: 0.5; }
    .btn-row { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
    button {
      font-family: inherit;
      font-size: 11px;
      padding: 4px 10px;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-border, var(--vscode-button-background));
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.4; cursor: default; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 12px 0; text-align: center; }
    .session-bar { margin-bottom: 8px; }
    .session-bar select {
      width: 100%;
      font-family: inherit;
      font-size: 11px;
      padding: 3px 6px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 3px;
    }
    .badge { display: inline-block; font-size: 9px; padding: 1px 5px; border-radius: 8px; margin-left: 4px; vertical-align: middle; }
    .badge.attention { background: var(--vscode-statusBarItemErrorBackground, #c33); color: var(--vscode-statusBarItemErrorForeground, #fff); }
    .badge.paused { background: var(--vscode-statusBarItemWarningBackground, #a80); color: var(--vscode-statusBarItemWarningForeground, #fff); }
    .badge.running { background: var(--vscode-statusBarItemProminentBackground, #06c); color: var(--vscode-statusBarItemProminentForeground, #fff); }
    .plan-revised-badge {
      font-size: 11px;
      color: var(--vscode-inputValidation-warningBorder, #a80);
      margin-bottom: 8px;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--vscode-inputValidation-warningBackground, rgba(170,136,0,0.1));
    }
    .field-label {
      display: block;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin: 6px 0 2px;
    }
    .interrupt-briefing {
      border: 1px solid var(--vscode-inputValidation-warningBorder, #a80);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 8px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-size: 11px;
      background: var(--vscode-inputValidation-warningBackground, rgba(170,136,0,0.1));
    }
    .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 4px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="root">
    <div class="empty">Loading plan review...</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${JSON.stringify({ sessionId: null, awaitingPlanApproval: false, planApproved: false, choices: null, planMd: null, isPaused: false, phase: null, interruptBriefing: null, planRevisionPending: false, interruptStageId: "INTERRUPT", selectedPlanChoiceId: null, sessions: [] })};
    let reviseBusy = false;
    let chatDraft = "";
    let interruptDraft = "";
    let lastSessionId = null;
    let isInteracting = false;
    let renderQueued = false;
    let deferredRenderTimer = null;
    let lastStateSig = "";
    let reviseBusyTimer = null;

    function stateSignature(s) {
      s = s || state;
      return JSON.stringify({
        sessionId: s.sessionId,
        awaitingPlanApproval: s.awaitingPlanApproval,
        planApproved: s.planApproved,
        isPaused: s.isPaused,
        phase: s.phase,
        planLen: (s.planMd || "").length,
        planHead: (s.planMd || "").slice(0, 200),
        interruptLen: (s.interruptBriefing || "").length,
        planRevisionPending: s.planRevisionPending,
        selectedPlanChoiceId: s.selectedPlanChoiceId,
        choicesLen: (s.choices || []).length,
        choiceTitles: (s.choices || []).map(function(x) { return [x.id, x.title]; }),
        sessions: (s.sessions || []).map(function(x) {
          return [x.sessionId, x.status, x.awaitingPlanApproval, x.phase];
        }),
      });
    }

    function setupInteractionGuard() {
      document.addEventListener("focusin", function(e) {
        var t = e.target;
        if (t && (t.tagName === "SELECT" || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
          isInteracting = true;
        }
      });
      document.addEventListener("focusout", function(e) {
        var t = e.target;
        if (t && (t.tagName === "SELECT" || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
          isInteracting = false;
          if (renderQueued) {
            if (deferredRenderTimer) { clearTimeout(deferredRenderTimer); deferredRenderTimer = null; }
            renderQueued = false;
            tryRender();
          }
        }
      });
    }

    function tryRender() {
      var sig = stateSignature();
      if (sig === lastStateSig) return;
      lastStateSig = sig;
      render();
    }

    function requestRender() {
      if (isInteracting) {
        renderQueued = true;
        if (!deferredRenderTimer) {
          deferredRenderTimer = setTimeout(function() {
            deferredRenderTimer = null;
            if (renderQueued) {
              renderQueued = false;
              tryRender();
            }
          }, 3000);
        }
        return;
      }
      tryRender();
    }

    function bindChatTextarea(textarea) {
      if (!textarea) return;
      textarea.value = chatDraft;
      textarea.oninput = function(e) { chatDraft = e.target.value; };
    }

    function clearReviseBusyTimer() {
      if (reviseBusyTimer) { clearTimeout(reviseBusyTimer); reviseBusyTimer = null; }
    }

    function startReviseBusyTimer() {
      clearReviseBusyTimer();
      reviseBusyTimer = setTimeout(function() {
        reviseBusyTimer = null;
        if (reviseBusy) {
          reviseBusy = false;
          requestRender();
        }
      }, 900000);
    }

    window.addEventListener("message", function(event) {
      var msg = event.data;
      if (msg.command === "stateUpdate") {
        var payload = msg.payload;
        if (lastSessionId !== null && lastSessionId !== payload.sessionId) {
          chatDraft = "";
          interruptDraft = "";
        }
        lastSessionId = payload.sessionId || null;
        var newSig = stateSignature(payload);
        state = payload;
        requestRender();
      } else if (msg.command === "operationComplete" && msg.operation === "revisePlan") {
        reviseBusy = false;
        clearReviseBusyTimer();
        requestRender();
      }
    });

    function escapeHtml(str) {
      if (!str) return "";
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function sessionLabel(s) {
      const id = s.sessionId.length > 12 ? s.sessionId.slice(0, 12) + "…" : s.sessionId;
      let badge = "";
      const attention = s.awaitingPlanApproval || s.phase === s.interruptStageId;
      if (attention) badge = '<span class="badge attention">!</span>';
      else if (s.status === "PAUSED") badge = '<span class="badge paused">II</span>';
      else if (s.status === "WAITING_USER") badge = '<span class="badge attention">?</span>';
      else if (s.status === "RECOVERING") badge = '<span class="badge running">R</span>';
      else if (s.status === "STOPPED") badge = '<span class="badge paused">■</span>';
      else if (s.status === "BLOCKED") badge = '<span class="badge attention">×</span>';
      else if (s.status === "RUNNING") badge = '<span class="badge running">▶</span>';
      const goal = s.goal ? s.goal.slice(0, 40) : "";
      return escapeHtml(id) + badge + " " + escapeHtml(goal);
    }

    function renderSessionSelector() {
      const sessions = state.sessions || [];
      if (sessions.length === 0) return "";
      const opts = sessions.map(function(s) {
        const sel = s.sessionId === state.sessionId ? " selected" : "";
        return '<option value="' + escapeHtml(s.sessionId) + '"' + sel + '>' + sessionLabel(s) + '</option>';
      }).join("");
      return '<div class="session-bar"><select id="session-select">' + opts + '</select></div>';
    }

    function render() {
      const root = document.getElementById("root");
      const selector = renderSessionSelector();

      if (!state.sessionId) {
        root.innerHTML = selector + '<div class="empty">Select a session to review plans.</div>';
        bindSessionSelector();
        return;
      }

      const hasChoices = state.choices && state.choices.length > 0;
      const hasPlan = state.planMd && state.planMd.trim().length > 0;
      const isInterrupt = state.phase === state.interruptStageId && state.interruptBriefing;

      let content;
      if (isInterrupt) {
        content = renderInterrupt();
      } else if (state.awaitingPlanApproval && !hasPlan && hasChoices) {
        content = renderChoosing();
      } else if (state.awaitingPlanApproval && hasPlan) {
        content = renderReviewing();
      } else if (state.isPaused && hasPlan) {
        content = renderPausedReview();
      } else {
        content = '<div class="empty">No plan review pending for this session.</div>';
      }

      root.innerHTML = selector + content;
      bindSessionSelector();

      if (isInterrupt) {
        bindInterrupt();
      } else if (state.awaitingPlanApproval || (state.isPaused && hasPlan)) {
        bindChat();
      }
    }

    function bindSessionSelector() {
      var sel = document.getElementById("session-select");
      if (sel) {
        sel.onchange = function() {
          chatDraft = "";
          vscode.postMessage({ command: "selectSession", sessionId: sel.value });
        };
      }
    }

    function renderChoosing() {
      const choicesHtml = (state.choices || []).map(function(c) {
        const selected = c.id === state.selectedPlanChoiceId;
        return '<div class="choice-card' + (selected ? ' selected' : '') + '" data-choice-id="' + c.id + '" role="button" tabindex="0">' +
          '<div class="choice-title">Option ' + c.id + ': ' + escapeHtml(c.title) + (selected ? '<span class="choice-marker">\u2713</span>' : '') + '</div></div>';
      }).join("");
      return '<h3>Plan Options</h3>' +
        '<div class="document-hint">The complete plans are open in the center editor. Choose an option here after comparing the documents.</div>' +
        choicesHtml +
        '<div class="btn-row"><button id="btn-open-overview">Open All Plans</button></div>';
    }

    function selectChoice(choiceId) {
      vscode.postMessage({ command: "selectPlanChoice", sessionId: state.sessionId, choiceId: choiceId });
    }

    function renderInterrupt() {
      var planBadge = state.planRevisionPending
        ? '<p class="plan-revised-badge">Plan revised \u2014 resume will re-implement from IMPLEMENTATION.</p>'
        : '';
      var planSection = (state.planMd && state.planMd.trim().length > 0)
        ? '<div class="document-hint">The current plan is available as a full Markdown document in the center editor.</div>' +
          '<div class="btn-row"><button id="btn-open-plan">Open Plan Document</button></div>'
        : '';
      return '<h3>\u26a0 Interrupt \u2014 Action Required</h3>' +
        '<div class="interrupt-briefing">' + escapeHtml(state.interruptBriefing || "") + '</div>' +
        planBadge + planSection +
        '<div class="chat-area"><label class="field-label">Revise plan</label>' +
        '<textarea id="chat-input" placeholder="Request plan changes... (Ctrl+Enter to send)"></textarea>' +
        '<label class="field-label">Operator message (optional)</label>' +
        '<textarea id="interrupt-input" placeholder="Send a message to the interrupter... (Ctrl+Enter to send)"></textarea>' +
        '<div class="btn-row">' +
          '<button id="btn-revise-plan" ' + (reviseBusy ? 'disabled' : '') + '>' + (reviseBusy ? '<span class="spinner"></span> Revising...' : 'Revise Plan') + '</button>' +
          '<button id="btn-send-interrupt" ' + (reviseBusy ? 'disabled' : '') + '>Send Message</button>' +
          '<button class="primary" id="btn-resume" ' + (reviseBusy ? 'disabled' : '') + '>Resume</button>' +
        '</div></div>';
    }

    function bindInterruptTextarea(el, draftKey) {
      if (!el) return;
      el.value = draftKey === "interrupt" ? interruptDraft : chatDraft;
      el.oninput = function(e) {
        if (draftKey === "interrupt") interruptDraft = e.target.value;
        else chatDraft = e.target.value;
      };
    }

    function bindInterrupt() {
      var planTextarea = document.getElementById("chat-input");
      var interruptTextarea = document.getElementById("interrupt-input");
      var btnRevisePlan = document.getElementById("btn-revise-plan");
      var btnSendInterrupt = document.getElementById("btn-send-interrupt");
      var btnResume = document.getElementById("btn-resume");

      function sendRevisePlan() {
        if (!planTextarea || reviseBusy) return;
        var msg = planTextarea.value.trim();
        if (!msg) return;
        chatDraft = "";
        reviseBusy = true;
        startReviseBusyTimer();
        lastStateSig = stateSignature();
        render();
        vscode.postMessage({ command: "revisePlan", sessionId: state.sessionId, message: msg });
      }

      function sendInterruptMessage() {
        if (!interruptTextarea || reviseBusy) return;
        var msg = interruptTextarea.value.trim();
        if (!msg) return;
        interruptDraft = "";
        reviseBusy = true;
        startReviseBusyTimer();
        lastStateSig = stateSignature();
        render();
        vscode.postMessage({ command: "interruptSession", sessionId: state.sessionId, message: msg });
      }

      bindInterruptTextarea(planTextarea, "plan");
      bindInterruptTextarea(interruptTextarea, "interrupt");
      if (planTextarea) {
        planTextarea.onkeydown = function(e) {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendRevisePlan();
          }
        };
      }
      if (interruptTextarea) {
        interruptTextarea.onkeydown = function(e) {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendInterruptMessage();
          }
        };
      }
      if (btnRevisePlan) btnRevisePlan.onclick = sendRevisePlan;
      if (btnSendInterrupt) btnSendInterrupt.onclick = sendInterruptMessage;
      if (btnResume) btnResume.onclick = function() {
        vscode.postMessage({ command: "resumeSession", sessionId: state.sessionId });
      };
    }

    function renderReviewing() {
      const selected = (state.choices || []).find(function(c) { return c.id === state.selectedPlanChoiceId; });
      const selectedTitle = selected
        ? 'Option ' + selected.id + ': ' + escapeHtml(selected.title)
        : 'Selected plan';
      return '<h3>Plan Review</h3>' +
        '<div class="selected-plan"><span class="selected-plan-label">Selected plan</span><strong>' + selectedTitle + '</strong></div>' +
        '<div class="document-hint">Review the complete Markdown plan in the center editor, then approve it or request a revision here.</div>' +
        '<div class="btn-row"><button id="btn-open-plan">Open Plan Document</button></div>' +
        '<div class="chat-area"><textarea id="chat-input" placeholder="Request plan changes... (Ctrl+Enter to send)"></textarea>' +
        '<div class="btn-row">' +
          '<button id="btn-revise" ' + (reviseBusy ? 'disabled' : '') + '>' + (reviseBusy ? '<span class="spinner"></span> Revising...' : 'Revise Plan') + '</button>' +
          '<button class="primary" id="btn-approve" ' + (reviseBusy ? 'disabled' : '') + '>Approve & Start</button>' +
          '<button id="btn-back-choices" ' + (reviseBusy ? 'disabled' : '') + '>Back to Choices</button>' +
        '</div></div>';
    }

    function renderPausedReview() {
      return '<h3>Session Paused \u2014 Plan Review</h3>' +
        '<div class="document-hint">Review the complete Markdown plan in the center editor before resuming.</div>' +
        '<div class="btn-row"><button id="btn-open-plan">Open Plan Document</button></div>' +
        '<div class="chat-area"><textarea id="chat-input" placeholder="Request plan changes... (Ctrl+Enter to send)"></textarea>' +
        '<div class="btn-row">' +
          '<button id="btn-revise" ' + (reviseBusy ? 'disabled' : '') + '>' + (reviseBusy ? '<span class="spinner"></span> Revising...' : 'Revise Plan') + '</button>' +
          '<button class="primary" id="btn-resume" ' + (reviseBusy ? 'disabled' : '') + '>Resume</button>' +
        '</div></div>';
    }

    function bindChat() {
      const textarea = document.getElementById("chat-input");
      const btnRevise = document.getElementById("btn-revise");
      const btnApprove = document.getElementById("btn-approve");
      const btnResume = document.getElementById("btn-resume");
      const btnBack = document.getElementById("btn-back-choices");

      function sendRevise() {
        if (!textarea || reviseBusy) return;
        var msg = textarea.value.trim();
        if (!msg) return;
        chatDraft = "";
        reviseBusy = true;
        startReviseBusyTimer();
        lastStateSig = stateSignature();
        render();
        vscode.postMessage({ command: "revisePlan", sessionId: state.sessionId, message: msg });
      }

      bindChatTextarea(textarea);
      if (textarea) {
        textarea.onkeydown = function(e) {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendRevise();
          }
        };
      }
      if (btnRevise) btnRevise.onclick = sendRevise;
      if (btnApprove) btnApprove.onclick = function() {
        vscode.postMessage({ command: "approvePlan", sessionId: state.sessionId });
      };
      if (btnResume) btnResume.onclick = function() {
        vscode.postMessage({ command: "resumeSession", sessionId: state.sessionId });
      };
      if (btnBack) btnBack.onclick = function() {
        vscode.postMessage({ command: "selectPlanChoice", sessionId: state.sessionId, choiceId: -1 });
      };
    }

    document.getElementById("root").addEventListener("click", function(e) {
      const openOverview = e.target.closest("#btn-open-overview");
      if (openOverview) {
        vscode.postMessage({ command: "openPlanOverview", sessionId: state.sessionId });
        return;
      }
      const openPlan = e.target.closest("#btn-open-plan");
      if (openPlan) {
        vscode.postMessage({ command: "openSelectedPlan", sessionId: state.sessionId });
        return;
      }
      const card = e.target.closest(".choice-card");
      if (card && card.dataset.choiceId) {
        selectChoice(parseInt(card.dataset.choiceId, 10));
      }
    });

    document.getElementById("root").addEventListener("keydown", function(e) {
      const card = e.target.closest(".choice-card");
      if (card && card.dataset.choiceId && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        selectChoice(parseInt(card.dataset.choiceId, 10));
      }
    });

    setupInteractionGuard();
    vscode.postMessage({ command: "requestPlanReviewState" });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const crypto = require("node:crypto");
  return crypto.randomBytes(16).toString("base64");
}
