(function () {
  const vscode = acquireVsCodeApi();

  let state = {
    registry: null,
    selectedSessionId: null,
    state: null,
    progressNotes: "",
    history: [],
    finalSummary: null,
    isRunning: false,
    defaultTargetPath: "",
    cliProfile: "opencode",
    modelVariants: null,
    variantDefaults: {},
    cliProfiles: {},
    variantMapping: {},
    runtimeLeaseStatus: null,
  };

  let logBuffer = "";
  const maxLogSize = 100000;

  const agentRoles = ["planner", "implementer", "tester", "qa_lead", "master", "interrupter"];
  const agentRoleLabels = {
    planner: "Planner",
    implementer: "Implementer",
    tester: "Tester",
    qa_lead: "QA Lead",
    master: "Master",
    interrupter: "Interrupter",
  };
  const phaseToRole = {
    PLANNING: { role: "planner", label: "Planner" },
    IMPLEMENTATION: { role: "implementer", label: "Implementer" },
    TEST_GENERATION: { role: "tester", label: "Tester" },
    VERIFICATION: { role: "qa_lead", label: "QA Lead" },
    MASTER_APPROVAL: { role: "master", label: "Master" },
    INTERRUPT: { role: "interrupter", label: "Interrupter" },
  };
  let modelSelections = {};
  let variantSelections = {};

  // Compose mode: when the user explicitly starts a "New Session" flow,
  // lock the view to the composer regardless of existing sessions so typing
  // is not interrupted by polling-driven re-renders switching to the control panel.
  let composingNew = false;
  let stoppingSessionId = null;

  // Composer state persisted across re-renders so user input is not lost.
  let composerGoal = "";
  let composerTarget = "";
  let composerAccessMode = "ask";
  let composerProfile = "opencode";
  let composerInitialized = false;

  // Re-render guard: while the user is interacting with a form control
  // (select/input/textarea), defer re-renders so open dropdowns are not destroyed.
  let isInteracting = false;
  let renderQueued = false;
  let deferredRenderTimer = null;
  let lastStateSig = "";

  let prevSelectedSessionId = null;

  function stateSignature() {
    const st = state.state;
    // Hash the first/last model + count + discovered-cli to reliably detect any
    // change in the model list (not just count), so switching opencode<->kilo
    // always triggers a re-render even if the counts happen to match.
    const models = state.registry?.availableModels || [];
    const modelsHash = models.length === 0
      ? "empty"
      : `${models.length}|${models[0]}|${models[models.length - 1]}|${state.registry?.modelsDiscoveredCli || ""}`;
    return JSON.stringify({
      s: st ? [
        st.status,
        st.phase,
        st.loopCount,
        st.updatedAt,
        st.maxIterations,
        st.activeAttempt?.attemptId,
        st.activeAttempt?.status,
        st.activeAttempt?.activity,
        st.activeAttempt?.mode,
        st.activeAttempt?.completionRecoveryNumber,
        st.activeAttempt?.lastProgressAt,
        st.activeAttempt?.nextRetryAt,
        st.lastFailure?.kind,
        st.statusReason,
        st.automaticRecovery?.cycle,
        st.automaticRecovery?.resumeAt,
        st.accessMode,
        st.pendingAccessRequest?.requestId,
      ] : null,
      sel: state.selectedSessionId,
      run: state.isRunning,
      metas: (state.registry?.sessionMetas || []).map((m) => [m.sessionId, m.status]),
      modelsHash,
      disc: state.registry?.modelsDiscoveredAt,
      notesLen: state.progressNotes.length,
      histLen: (state.history || []).length,
      hasSummary: !!state.finalSummary,
      defTarget: state.defaultTargetPath,
      cliProfile: state.cliProfile,
      variantMapping: state.variantMapping,
      modelVariants: state.modelVariants,
      variantDefaults: state.variantDefaults,
      runtimeLeaseStatus: state.runtimeLeaseStatus,
      cliProfiles: state.cliProfiles,
      modelSelections,
      variantSelections,
    });
  }

  function render() {
    const root = document.getElementById("root");
    if (!root) return;

    const hasRegistry = !!state.registry;
    const hasSession = !!state.selectedSessionId || (state.registry?.sessionMetas?.length ?? 0) > 0;

    if (composingNew || (!hasRegistry && !hasSession)) {
      renderEmpty(root);
      return;
    }
    renderActive(root);
  }

  function buildGroupedModels() {
    const availableModels = state.registry?.availableModels || [];
    const grouped = {};
    for (const m of availableModels) {
      const slashIdx = m.indexOf("/");
      const provider = slashIdx > 0 ? m.slice(0, slashIdx) : "other";
      const name = slashIdx > 0 ? m.slice(slashIdx + 1) : m;
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push({ value: m, name });
    }
    return { grouped, providerNames: Object.keys(grouped).sort() };
  }

  function buildModelOptions(current, grouped, providerNames) {
    let html = `<option value="">(auto)</option>`;
    for (const provider of providerNames) {
      const items = grouped[provider]
        .map((it) => `<option value="${escapeHtml(it.value)}"${it.value === current ? " selected" : ""}>${escapeHtml(it.name)}</option>`)
        .join("");
      html += `<optgroup label="${escapeHtml(provider)}">${items}</optgroup>`;
    }
    return html;
  }

  function mapVariantByIndex(currentVariant, oldVariants, newVariants) {
    if (!currentVariant || oldVariants.length === 0) return "";
    if (newVariants.length === 0) return "";
    if (newVariants.includes(currentVariant)) return currentVariant;
    var oldIdx = oldVariants.indexOf(currentVariant);
    if (oldIdx === -1) return "";
    var ratio = oldIdx / (oldVariants.length - 1);
    var newIdx = Math.round(ratio * (newVariants.length - 1));
    return newVariants[newIdx] || "";
  }

  function getModelVariants(modelId) {
    if (!modelId) return [];
    const regOverrides = state.modelVariants?.[modelId];
    if (regOverrides) return regOverrides;
    const slashIdx = modelId.indexOf("/");
    const provider = slashIdx > 0 ? modelId.slice(0, slashIdx).toLowerCase() : "";
    var configDefaults = (state.variantDefaults && state.variantDefaults[provider]) || [];
    if (configDefaults.length > 0) return configDefaults;
    const defaults = {
      anthropic: ["high", "max"],
      openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
      google: ["low", "high"],
      gemini: ["low", "high"],
      opencode: ["none", "minimal", "low", "medium", "high", "xhigh"],
      "opencode-go": ["none", "minimal", "low", "medium", "high", "xhigh"],
      kilo: ["none", "minimal", "low", "medium", "high", "xhigh"],
      deepseek: ["low", "medium", "high", "max"],
    };
    return defaults[provider] || [];
  }

  function buildVariantSelect(role, currentModel) {
    const variants = getModelVariants(currentModel);
    if (variants.length === 0) return "";
    const current = variantSelections[role] || state.state?.variantMapping?.[role] || "";
    const options = variants.map(function (v) {
      return "<option value=\"" + escapeHtml(v) + "\"" + (v === current ? " selected" : "") + ">" + escapeHtml(v) + "</option>";
    }).join("");
    return "<select data-role=\"" + escapeHtml(role) + "\" data-field=\"variant\" class=\"model-select variant-select\">" +
      "<option value=\"\">(default)</option>" +
      options +
      "</select>";
  }

  function buildModelGrid(st) {
    const { grouped, providerNames } = buildGroupedModels();
    return agentRoles
      .map((role) => {
        const current = st?.modelMapping?.[role] || modelSelections[role] || "";
        const label = agentRoleLabels[role] || role;
        return `
          <div class="model-row">
            <label class="model-role">${escapeHtml(label)}</label>
            <select data-role="${escapeHtml(role)}" class="model-select">
              ${buildModelOptions(current, grouped, providerNames)}
            </select>
            ${buildVariantSelect(role, current)}
          </div>`;
      })
      .join("");
  }

  function buildApplyAllHtml() {
    const { grouped, providerNames } = buildGroupedModels();
    const allSame = agentRoles.every((r) => (modelSelections[r] || "") === (modelSelections[agentRoles[0]] || ""));
    const currentBulk = allSame ? (modelSelections[agentRoles[0]] || "") : "";
    return `
      <div class="apply-all-row">
        <label class="apply-all-label">Apply to all</label>
        <select id="apply-all-model" class="model-select apply-all-select">
          ${buildModelOptions(currentBulk, grouped, providerNames)}
        </select>
        ${buildVariantSelect("apply-all", currentBulk)}
      </div>`;
  }

  function composerHtml(compact) {
    const goalVal = escapeHtml(composerGoal);
    const targetVal = escapeHtml(composerTarget || composerTargetDefault());
    const wrapClass = compact ? "composer composer-bar" : "composer composer-large";
    const textareaClass = compact ? "composer-goal" : "composer-goal composer-goal-large";
    const rows = compact ? 2 : 4;
    const cancelBtn = composingNew ? `<button class="btn secondary" id="composer-cancel">Cancel</button>` : "";
    const targetPlaceholder = composerTargetDefault() ? "" : "Target project path (current workspace)";
    const currentProfile = state.state?.cliProfile || state.cliProfile || "opencode";
    return `
      <div class="${wrapClass}" id="composer">
        <textarea id="composer-goal" class="${textareaClass}" rows="${rows}" placeholder="Describe the goal for the agent loop to achieve... (Ctrl+Enter to start)">${goalVal}</textarea>
        <div class="composer-meta">
          <input type="text" id="composer-target" class="composer-input" placeholder="${targetPlaceholder}" value="${targetVal}" title="Target project path where agents will modify and test code. Defaults to the current workspace folder." />
          <select id="composer-profile" class="composer-input composer-input-sm" title="CLI profile (command conventions)">
            <option value="opencode"${currentProfile === "opencode" ? " selected" : ""}>opencode</option>
            <option value="kilo"${currentProfile === "kilo" ? " selected" : ""}>kilo</option>
          </select>
          <select id="composer-access-mode" class="composer-input composer-input-sm" title="Filesystem access mode">
            <option value="ask"${composerAccessMode === "ask" ? " selected" : ""}>Ask when needed</option>
            <option value="full_access"${composerAccessMode === "full_access" ? " selected" : ""}>Full access</option>
          </select>
          <button class="btn" id="composer-start">Start Session</button>
          ${cancelBtn}
        </div>
      </div>`;
  }

  function composerTargetDefault() {
    return state.defaultTargetPath || state.state?.targetProjectPath || "";
  }

  function renderEmpty(root) {
    const { grouped, providerNames } = buildGroupedModels();
    const modelGrid = agentRoles
      .map((role) => {
        const current = modelSelections[role] || "";
        const label = agentRoleLabels[role] || role;
        return `
          <div class="model-row">
            <label class="model-role">${escapeHtml(label)}</label>
            <select data-role="${escapeHtml(role)}" class="model-select">
              ${buildModelOptions(current, grouped, providerNames)}
            </select>
            ${buildVariantSelect(role, current)}
          </div>`;
      })
      .join("");

    root.innerHTML = `
      <div class="empty-wrap">
        <div class="empty-hero">
          <div class="empty-icon">&#9881;</div>
          <h2>Agent Loop Orchestrator</h2>
          <p class="empty-sub">Describe a coding goal below. The orchestrator will plan, implement, test, verify, and seek master approval autonomously.</p>
        </div>
        ${composerHtml(false)}
        <div class="card model-card empty-model-card">
          <h3>Model Mapping (${(state.registry?.availableModels || []).length} models${state.registry?.modelsDiscoveredCli ? ` from <span class="model-source">${escapeHtml(state.registry.modelsDiscoveredCli)}</span>` : " — not yet discovered"})</h3>
          ${buildApplyAllHtml()}
          <div class="model-grid">${modelGrid}</div>
          <div class="composer-actions">
            <button class="btn secondary" id="btn-discover">Discover Models</button>
            <span class="composer-hint">${state.registry?.modelsDiscoveredAt ? "Last discovered: " + escapeHtml(formatDate(state.registry.modelsDiscoveredAt)) : "No models discovered yet."}</span>
          </div>
        </div>
      </div>`;
    bindComposer();
    bindModelSelects();
    const btnDiscover = document.getElementById("btn-discover");
    if (btnDiscover) btnDiscover.onclick = () => vscode.postMessage({ command: "discoverModels" });
  }

  function renderActive(root) {
    const sessionOptions = (state.registry?.sessionMetas || [])
      .map(
        (m) => `<option value="${escapeHtml(m.sessionId)}" ${m.sessionId === state.selectedSessionId ? "selected" : ""}>${escapeHtml(m.sessionId)} [${escapeHtml(m.status)}]</option>`
      )
      .join("");

    const isStopping = stoppingSessionId === state.selectedSessionId;
    const st = state.state;
    const badgeClass = isStopping ? "stopping" : (st ? st.status.toLowerCase() : "");
    const badgeText = isStopping ? "TERMINATING" : (st ? st.status : "NONE");
    const statusBadge = st || isStopping
      ? `<span class="badge ${escapeHtml(badgeClass)}">${escapeHtml(badgeText)}</span>`
      : "<span class=\"badge\">NONE</span>";

    const summaryBanner = state.finalSummary
      ? `<div class="summary-banner">
           <span>Session achieved SUCCESS at ${escapeHtml(formatDate(state.finalSummary.achievedAt))}</span>
           <button id="btn-open-summary">View Summary</button>
         </div>`
      : "";

    const modelGrid = buildModelGrid(st);

    const activeAttempt = st?.activeAttempt;
    const stageDefinition = st?.pipeline?.stages?.find((stage) => stage.id === st.phase);
    const lastProgressAge = activeAttempt?.lastProgressAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(activeAttempt.lastProgressAt)) / 1000))
      : null;
    const attemptActivity = activeAttempt?.activity || (activeAttempt?.lastOutputAt ? "model_generation" : "initial_transport");
    const activityTimeoutMs = attemptActivity === "tool_execution"
      ? st?.resilience?.toolTimeoutMs
      : attemptActivity === "model_generation"
      ? st?.idleTimeoutMs
      : st?.resilience?.transportTimeoutMs;
    const attemptDisplay = activeAttempt?.mode === "completion_recovery"
      ? `completion recovery ${activeAttempt.completionRecoveryNumber || 1} / ${st?.resilience?.maxCompletionRecoveryAttempts || 1}`
      : `${activeAttempt?.attemptNumber || 0} / ${Math.min(activeAttempt?.maxAttempts || 0, st?.resilience?.maxAgentAttempts || activeAttempt?.maxAttempts || 0)}`;
    const statusRows = st
      ? `
        <div class="status-row"><span class="label">Session</span><span class="value">${escapeHtml(st.sessionId)}</span></div>
        <div class="status-row"><span class="label">Status</span>${statusBadge}</div>
        ${st.statusReason ? `<div class="status-row"><span class="label">Reason</span><span class="value">${escapeHtml(st.statusReason)}</span></div>` : ""}
        <div class="status-row"><span class="label">Lease</span><span class="value">${escapeHtml(state.runtimeLeaseStatus || "none")}</span></div>
        <div class="status-row"><span class="label">Phase</span><span class="value">${escapeHtml(st.phase)}</span></div>
        <div class="status-row"><span class="label">Role</span><span class="value">${escapeHtml(stageDefinition?.role || "unknown")}</span></div>
        <div class="status-row"><span class="label">Loop</span><span class="value">${st.loopCount} started · ${st.completedIterations ?? 0} completed / ${st.maxIterations}</span></div>
        ${activeAttempt ? `
        <div class="status-row"><span class="label">Attempt</span><span class="value">${escapeHtml(attemptDisplay)} · ${escapeHtml(activeAttempt.status)}</span></div>
        <div class="status-row"><span class="label">Activity</span><span class="value">${escapeHtml(attemptActivity)}${activityTimeoutMs ? ` · ${Math.round(activityTimeoutMs / 1000)}s timeout` : ""}</span></div>
        <div class="status-row"><span class="label">Reconnect</span><span class="value">${activeAttempt.reconnectUsed ? "used" : "not used"}</span></div>
        <div class="status-row"><span class="label">Last progress</span><span class="value">${lastProgressAge === null ? "none" : lastProgressAge + "s ago"}</span></div>
        ${activeAttempt.nextRetryAt ? `<div class="status-row"><span class="label">Retry at</span><span class="value">${escapeHtml(formatDate(activeAttempt.nextRetryAt))}</span></div>` : ""}
        ` : ""}
        ${st.lastFailure ? `<div class="status-row"><span class="label">Last failure</span><span class="value">${escapeHtml(st.lastFailure.kind)}</span></div>` : ""}
        ${st.automaticRecovery ? `<div class="status-row"><span class="label">Auto recovery</span><span class="value">${st.automaticRecovery.cycle} / ${st.automaticRecovery.maxCycles} · ${escapeHtml(formatDate(st.automaticRecovery.resumeAt))}</span></div>` : ""}
        ${st.interruptBriefing ? `<div class="error-queue"><div class="status-row" style="display:block"><span class="label">Local failure briefing</span></div><div class="error-queue-item">${escapeHtml(String(st.interruptBriefing).slice(0, 2000))}</div></div>` : ""}
        <div class="status-row"><span class="label">Goal</span><span class="value" style="text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis">${escapeHtml(String(st.goal).slice(0, 80))}</span></div>
        <div class="status-row"><span class="label">Target</span><span class="value" style="text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis">${escapeHtml(String(st.targetProjectPath).slice(0, 60))}</span></div>
        <div class="status-row"><span class="label">CLI</span><span class="value">${escapeHtml(st.cliProfile || "opencode")} / ${escapeHtml(st.cliBinary || "")}</span></div>
        ${st.errorQueue && st.errorQueue.length > 0 ? `<div class="error-queue"><div class="status-row" style="display:block"><span class="label">Error Queue (Lookback-5):</span></div>${st.errorQueue
          .map((e) => `<div class="error-queue-item">[${escapeHtml(e.phase)}] ${escapeHtml(e.signature)}</div>`)
          .join("")}</div>` : ""}
      `
      : `<div class="notes-empty">No session selected.</div>`;

    const pendingAccess = st?.pendingAccessRequest;
    const accessMode = st?.accessMode || "ask";
    const heldForAccess = st && ["PAUSED", "WAITING_USER", "RECOVERING", "STOPPED", "BLOCKED"].includes(st.status);
    const accessEditor = st
      ? `<div class="access-editor ${pendingAccess ? "access-request" : ""}">
          <div class="access-mode-row">
            <span class="access-mode-label">Filesystem access</span>
            <span class="badge ${accessMode === "full_access" ? "success" : ""}">${accessMode === "full_access" ? "FULL ACCESS" : "ASK WHEN NEEDED"}</span>
          </div>
          ${pendingAccess ? `
            <div class="access-request-title">Access approval required</div>
            <div class="access-hint">Implementation requested access to:</div>
            <ul class="access-request-paths">${pendingAccess.requestedPaths.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>
            <div class="access-request-actions">
              <button class="btn" id="btn-allow-requested">Allow &amp; Resume</button>
              <button class="btn warn" id="btn-allow-full">Allow Full Access &amp; Resume</button>
            </div>
          ` : heldForAccess ? `
            <div class="access-editor-footer">
              <span class="access-hint">${accessMode === "full_access" ? "Agents can access any filesystem path." : "The loop will pause and ask before using paths outside the target."}</span>
              <button class="btn secondary" id="btn-toggle-access">${accessMode === "full_access" ? "Use Ask Mode" : "Grant Full Access"}</button>
            </div>
          ` : `<div class="access-hint">Stop or hold the session to change this mode.</div>`}
        </div>`
      : "";

    let runningEntry = "";
    if (state.isRunning && !isStopping && state.state) {
      const currentPhase = state.state.phase;
      const configuredStage = state.state.pipeline?.stages?.find((stage) => stage.id === currentPhase);
      const mapped = configuredStage
        ? { role: configuredStage.role, label: configuredStage.name || configuredStage.role }
        : phaseToRole[currentPhase];
      if (mapped) {
        runningEntry = `<li class="history-item running">
          <span><span class="phase">${escapeHtml(currentPhase)}</span> &middot; ${escapeHtml(mapped.label)} &middot; loop ${state.state.loopCount}</span>
          <span class="result running-badge">RUNNING</span>
        </li>`;
      }
    }

    const historyList = runningEntry + (state.history || [])
      .map(
        (h) => `<li class="history-item">
          <span><span class="phase">${escapeHtml(h.phase)}</span> &middot; ${escapeHtml(h.agentRole)} &middot; loop ${h.loopNumber}</span>
          <span class="result ${escapeHtml(h.result)}">${escapeHtml(h.result)} (${h.exitCode})</span>
          ${h.interruptMessage ? `<div class="interrupt-msg">Interrupt: ${escapeHtml(h.interruptMessage)}</div>` : ""}
        </li>`
      )
      .join("");

    const notesContent = state.progressNotes
      ? escapeHtml(state.progressNotes)
      : '<span class="notes-empty">(no notes yet)</span>';

    const logContent = logBuffer
      ? `<div class="log-content">${escapeHtml(logBuffer)}</div>`
      : '<div class="log-empty">(no log output yet)</div>';

    const canResume = st && ["PAUSED", "WAITING_USER", "RECOVERING", "STOPPED", "BLOCKED"].includes(st.status) &&
      !st.pendingAccessRequest && !(st.awaitingPlanApproval && !st.planApproved);
    root.innerHTML = `
      ${summaryBanner}
      <div class="toolbar">
        <select id="session-select">${sessionOptions}</select>
        <button class="btn secondary" id="btn-resume" ${canResume ? "" : "disabled"}>Resume</button>
        <button class="btn danger" id="btn-stop" ${(isStopping || !state.isRunning) ? "disabled" : ""}>${isStopping ? "Terminating..." : "Stop"}</button>
        <button class="btn danger" id="btn-delete" ${!state.selectedSessionId ? "disabled" : ""} title="Delete this session and all its data">Delete</button>
        <button class="btn secondary" id="btn-discover">Models</button>
        <button class="btn secondary" id="btn-open-notes">Notes</button>
        <button class="btn secondary" id="btn-open-session">Folder</button>
      </div>
      <div class="main-grid">
        <div class="card status-card">
          <h3>Status</h3>
          ${statusRows}
          ${accessEditor}
        </div>
        <div class="card model-card">
          <h3>Model Mapping (${(state.registry?.availableModels || []).length} models${state.registry?.modelsDiscoveredCli ? ` from <span class="model-source">${escapeHtml(state.registry.modelsDiscoveredCli)}</span>` : " — not yet discovered"})</h3>
          ${buildApplyAllHtml()}
          <div class="model-grid">${modelGrid}</div>
        </div>
        <div class="card notes-card">
          <h3>Progress Notes (Rolling Summary)${isStopping ? '<span class="pending-indicator"> \u2014 terminating agent now\u2026</span>' : ""}</h3>
          <div class="notes-content">${notesContent}</div>
        </div>
        <div class="card history-card">
          <h3>Loop History (${(state.history || []).length + (runningEntry ? 1 : 0)})${isStopping ? '<span class="pending-indicator"> \u2014 terminating agent now\u2026</span>' : ""}</h3>
          <ul class="history-list">${historyList || '<li class="notes-empty">(no history)</li>'}</ul>
        </div>
        <div class="card log-card">
          <h3>Live Log Stream</h3>
          ${logContent}
        </div>
      </div>
    `;

    bindToolbar();
    bindModelSelects();
    scrollLogToBottom();
  }

  function bindToolbar() {
    const sessionSelect = document.getElementById("session-select");
    const btnResume = document.getElementById("btn-resume");
    const btnStop = document.getElementById("btn-stop");
    const btnDelete = document.getElementById("btn-delete");
    const btnDiscover = document.getElementById("btn-discover");
    const btnOpenNotes = document.getElementById("btn-open-notes");
    const btnOpenSummary = document.getElementById("btn-open-summary");
    const btnAllowRequested = document.getElementById("btn-allow-requested");
    const btnAllowFull = document.getElementById("btn-allow-full");
    const btnToggleAccess = document.getElementById("btn-toggle-access");

    if (sessionSelect) sessionSelect.onchange = (e) => {
      vscode.postMessage({ command: "selectSession", sessionId: e.target.value });
    };
    if (btnResume) btnResume.onclick = () => {
      if (state.selectedSessionId) vscode.postMessage({ command: "resumeSession", sessionId: state.selectedSessionId });
    };
    if (btnStop) btnStop.onclick = () => {
      if (state.selectedSessionId) {
        stoppingSessionId = state.selectedSessionId;
        btnStop.disabled = true;
        btnStop.textContent = "Terminating...";
        vscode.postMessage({ command: "stopSession", sessionId: state.selectedSessionId });
      }
    };
    if (btnDelete) btnDelete.onclick = () => {
      if (state.selectedSessionId) vscode.postMessage({ command: "deleteSession", sessionId: state.selectedSessionId });
    };
    if (btnDiscover) btnDiscover.onclick = () => vscode.postMessage({ command: "discoverModels" });
    if (btnOpenNotes) btnOpenNotes.onclick = () => {
      if (state.selectedSessionId) vscode.postMessage({ command: "openProgressNotes", sessionId: state.selectedSessionId });
    };
    if (btnOpenSummary) btnOpenSummary.onclick = () => {
      if (state.selectedSessionId) vscode.postMessage({ command: "openFinalSummary", sessionId: state.selectedSessionId });
    };
    if (btnAllowRequested) btnAllowRequested.onclick = () => {
      if (!state.selectedSessionId) return;
      btnAllowRequested.disabled = true;
      if (btnAllowFull) btnAllowFull.disabled = true;
      vscode.postMessage({
        command: "resolveAccessRequest",
        sessionId: state.selectedSessionId,
        decision: "allow_requested",
      });
    };
    if (btnAllowFull) btnAllowFull.onclick = () => {
      if (!state.selectedSessionId) return;
      btnAllowFull.disabled = true;
      if (btnAllowRequested) btnAllowRequested.disabled = true;
      vscode.postMessage({
        command: "resolveAccessRequest",
        sessionId: state.selectedSessionId,
        decision: "full_access",
      });
    };
    if (btnToggleAccess) btnToggleAccess.onclick = () => {
      if (!state.selectedSessionId || !state.state) return;
      btnToggleAccess.disabled = true;
      vscode.postMessage({
        command: "setAccessMode",
        sessionId: state.selectedSessionId,
        accessMode: state.state.accessMode === "full_access" ? "ask" : "full_access",
      });
    };
    const btnOpenSession = document.getElementById("btn-open-session");
    if (btnOpenSession) btnOpenSession.onclick = () => {
      if (state.selectedSessionId)
        vscode.postMessage({ command: "openSessionFolder", sessionId: state.selectedSessionId });
    };
  }

  function bindModelSelects() {
    document.querySelectorAll("select[data-role]").forEach((sel) => {
      sel.onchange = (e) => {
        const role = e.target.getAttribute("data-role");
        if (e.target.dataset.field === "variant") {
          if (role === "apply-all") {
            const val = e.target.value;
            for (const r of agentRoles) {
              variantSelections[r] = val;
            }
            document.querySelectorAll("select[data-role][data-field='variant']").forEach((sel) => {
              if (sel.getAttribute("data-role") !== "apply-all") sel.value = val;
            });
          } else {
            variantSelections[role] = e.target.value;
          }
          requestRender();
        } else {
          var oldModel = modelSelections[role] || "";
          var newModel = e.target.value;
          var oldVariants = oldModel ? getModelVariants(oldModel) : [];
          var newVariants = getModelVariants(newModel);
          modelSelections[role] = newModel;
          variantSelections[role] = mapVariantByIndex(variantSelections[role], oldVariants, newVariants);
          requestRender();
        }
      };
    });
    const applyAll = document.getElementById("apply-all-model");
    if (applyAll) applyAll.onchange = (e) => {
      const val = e.target.value;
      for (const role of agentRoles) {
        var oldModel = modelSelections[role] || "";
        var oldVariants = oldModel ? getModelVariants(oldModel) : [];
        var newVariants = getModelVariants(val);
        modelSelections[role] = val;
        variantSelections[role] = mapVariantByIndex(variantSelections[role], oldVariants, newVariants);
      }
      document.querySelectorAll("select[data-role]").forEach((sel) => {
        const role = sel.getAttribute("data-role");
        if (!sel.dataset.field && role) sel.value = val;
      });
      document.querySelectorAll("select[data-role][data-field='variant']").forEach((sel) => {
        sel.value = "";
      });
      requestRender();
    };
  }

  function bindComposer() {
    const goalEl = document.getElementById("composer-goal");
    const targetEl = document.getElementById("composer-target");
    const accessModeEl = document.getElementById("composer-access-mode");
    const startBtn = document.getElementById("composer-start");
    const cancelBtn = document.getElementById("composer-cancel");

    if (!composerInitialized) {
      const def = composerTargetDefault();
      if (def && (!composerTarget || composerTarget.length === 0)) {
        composerTarget = def;
      }
    } else if (!composerTarget || composerTarget.length === 0) {
      const def = composerTargetDefault();
      if (def) composerTarget = def;
    }

    if (goalEl) {
      goalEl.value = composerGoal;
      goalEl.oninput = (e) => { composerGoal = e.target.value; };
      goalEl.onkeydown = (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          sendNewSession();
        }
        if (e.key === "Escape" && composingNew) {
          e.preventDefault();
          cancelCompose();
        }
      };
    }
    if (targetEl) {
      targetEl.value = composerTarget;
      targetEl.oninput = (e) => { composerTarget = e.target.value; };
    }
    if (accessModeEl) {
      accessModeEl.value = composerAccessMode;
      accessModeEl.onchange = (e) => { composerAccessMode = e.target.value; };
    }
    const profileEl = document.getElementById("composer-profile");
    if (profileEl) {
      profileEl.value = composerProfile;
      profileEl.onchange = (e) => {
        composerProfile = e.target.value;
        vscode.postMessage({ command: "setCliProfile", profile: e.target.value });
      };
    }
    if (startBtn) startBtn.onclick = () => sendNewSession();
    if (cancelBtn) cancelBtn.onclick = () => cancelCompose();
    composerInitialized = true;
  }

  function cancelCompose() {
    composingNew = false;
    lastStateSig = "";
    tryRender();
  }

  function sendNewSession() {
    const goal = composerGoal;
    if (!goal || goal.trim().length === 0) return;
    const mapping = {};
    for (const role of agentRoles) {
      if (modelSelections[role]) mapping[role] = modelSelections[role];
    }
    const variantMapping = {};
    for (const role of agentRoles) {
      if (variantSelections[role]) variantMapping[role] = variantSelections[role];
    }
    vscode.postMessage({
      command: "newSession",
      goal: goal.trim(),
      targetProjectPath: (composerTarget || composerTargetDefault()).trim(),
      accessMode: composerAccessMode === "full_access" ? "full_access" : "ask",
      cliProfile: composerProfile || "opencode",
      modelMapping: mapping,
      variantMapping: variantMapping,
    });
    composingNew = false;
    composerGoal = "";
    const goalEl = document.getElementById("composer-goal");
    if (goalEl) goalEl.value = "";
  }

  function focusComposer() {
    const goalEl = document.getElementById("composer-goal");
    if (goalEl) goalEl.focus();
  }

  function scrollLogToBottom() {
    const logEl = document.querySelector(".log-content");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDate(str) {
    if (!str) return "";
    const d = new Date(str);
    if (isNaN(d.getTime())) return escapeHtml(str);
    return d.toLocaleString();
  }

  // Global interaction guard: track focus within form controls to defer re-renders.
  function setupInteractionGuard() {
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (t && (t.tagName === "SELECT" || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        isInteracting = true;
      }
    });
    document.addEventListener("focusout", (e) => {
      const t = e.target;
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
    const sig = stateSignature();
    if (sig === lastStateSig) return;
    lastStateSig = sig;
    render();
  }

  function requestRender() {
    if (isInteracting) {
      renderQueued = true;
      if (!deferredRenderTimer) {
        deferredRenderTimer = setTimeout(() => {
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

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.command) return;

    if (msg.command === "stateUpdate") {
      if (msg.payload.selectedSessionId !== prevSelectedSessionId) {
        prevSelectedSessionId = msg.payload.selectedSessionId;
        if (msg.payload.selectedSessionId && msg.payload.state?.cliProfile) {
          composerProfile = msg.payload.state.cliProfile;
        } else if (!msg.payload.selectedSessionId) {
          composerProfile = msg.payload.cliProfile || "opencode";
        }
        if (msg.payload.variantMapping) {
          variantSelections = { ...msg.payload.variantMapping };
        } else {
          variantSelections = {};
        }
      }
      if (stoppingSessionId && (!msg.payload.isRunning || msg.payload.selectedSessionId !== stoppingSessionId)) {
        stoppingSessionId = null;
      }
      state = msg.payload;
      requestRender();
    } else if (msg.command === "logAppend") {
      const text = msg.entry.text;
      logBuffer += text;
      if (logBuffer.length > maxLogSize) {
        logBuffer = logBuffer.slice(-maxLogSize);
      }
      const logEl = document.querySelector(".log-content");
      if (logEl) {
        logEl.textContent = logBuffer;
        scrollLogToBottom();
      } else if (!isInteracting) {
        tryRender();
      }
    } else if (msg.command === "focusComposer") {
      composingNew = true;
      lastStateSig = "";
      tryRender();
      focusComposer();
    }
  });

  setupInteractionGuard();
  vscode.postMessage({ command: "requestState" });
  render();
})();
