(function () {
  const vscode = acquireVsCodeApi();

  let state = {
    registry: null,
    selectedSessionId: null,
    state: null,
    progressNotes: "",
    timeline: [],
    operatorSnapshot: null,
    finalSummary: null,
    isRunning: false,
    defaultTargetPath: "",
    cliProfile: "opencode",
    modelVariants: null,
    variantDefaults: {},
    cliProfiles: {},
    systemSettings: { providers: {}, toolAccess: { webSearch: { enabled: false, mode: "cached" }, mcpServers: [] }, pipeline: { roles: [], stages: [] } },
    variantMapping: {},
    runtimeLeaseStatus: null,
  };

  const logBuffers = Object.create(null);
  const maxLogSize = 100000;

  function selectedLogBuffer() {
    const sessionId = state.selectedSessionId;
    return sessionId ? (logBuffers[sessionId] || "") : "";
  }

  let agentRoles = ["planner", "implementer", "tester", "qa_lead", "master", "interrupter"];
  const agentRoleLabels = {
    planner: "Planner",
    implementer: "Implementer",
    tester: "Tester",
    qa_lead: "QA Lead",
    master: "Master",
    interrupter: "Interrupter",
  };
  let modelSelections = {};
  let providerSelections = {};
  let variantSelections = {};
  let settingsOpen = false;
  let settingsDraft = null;
  let settingsSection = "models";

  // Compose mode: when the user explicitly starts a "New Session" flow,
  // lock the view to the composer regardless of existing sessions so typing
  // is not interrupted by polling-driven re-renders switching to the control panel.
  let composingNew = false;
  let stoppingSessionId = null;

  // Composer state persisted across re-renders so user input is not lost.
  let composerGoal = "";
  let composerTarget = "";
  let composerAccessMode = "ask";
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
    const providerCatalogHash = Object.values(state.registry?.providerCatalog || {})
      .map((provider) => [
        provider.id,
        provider.enabled,
        provider.available,
        (provider.models || []).length,
        (provider.models || [])[0] || "",
        (provider.models || []).at(-1) || "",
      ]);
    return JSON.stringify({
      s: st ? [
        st.status,
        st.phase,
        st.loopCount,
        st.updatedAt,
        st.maxCycles,
        st.activeAttempt?.attemptId,
        st.activeAttempt?.status,
        st.activeAttempt?.activity,
        st.activeAttempt?.lastProgressAt,
        st.activeAttempt?.nextRetryAt,
        st.lastFailure?.kind,
        st.statusReason,
        st.accessMode,
        st.pendingAccessRequest?.requestId,
        st.referenceIdentity?.packageId,
        st.referenceIdentity?.identityMatch,
        st.referenceIdentity?.confidence,
        st.requirements?.evidence?.length,
        st.requirements?.evidence?.at(-1)?.recordedAt,
        st.convergence?.stagnantCycles,
        st.convergence?.history?.at(-1)?.signature,
      ] : null,
      sel: state.selectedSessionId,
      run: state.isRunning,
      metas: (state.registry?.sessionMetas || []).map((m) => [m.sessionId, m.status]),
      modelsHash,
      providerCatalogHash,
      disc: state.registry?.modelsDiscoveredAt,
      notesLen: state.progressNotes.length,
      eventSequence: st?.domainEventSequence || 0,
      timelineLen: (state.timeline || []).length,
      nextAction: state.operatorSnapshot?.nextPermittedAction,
      hasSummary: !!state.finalSummary,
      defTarget: state.defaultTargetPath,
      cliProfile: state.cliProfile,
      variantMapping: state.variantMapping,
      modelVariants: state.modelVariants,
      variantDefaults: state.variantDefaults,
      runtimeLeaseStatus: state.runtimeLeaseStatus,
      cliProfiles: state.cliProfiles,
      systemSettings: state.systemSettings,
      modelSelections,
      providerSelections,
      variantSelections,
    });
  }

  function render() {
    const root = document.getElementById("root");
    if (!root) return;

    const hasRegistry = !!state.registry;
    const hasSession = !!state.selectedSessionId || (state.registry?.sessionMetas?.length ?? 0) > 0;

    if (settingsOpen) {
      renderSettings(root);
      return;
    }
    if (composingNew || (!hasRegistry && !hasSession)) {
      renderEmpty(root);
      return;
    }
    renderActive(root);
  }

  function providerCatalog() {
    return state.registry?.providerCatalog || {};
  }

  function availableProviders() {
    return Object.values(providerCatalog())
      .filter((provider) => provider.enabled !== false && provider.available === true)
      .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
  }

  function defaultProviderId() {
    return availableProviders()[0]?.id || "";
  }

  function resolveProviderId(requested) {
    return availableProviders().some((provider) => provider.id === requested)
      ? requested
      : defaultProviderId();
  }

  function buildProviderOptions(current) {
    const providers = availableProviders();
    if (providers.length === 0) {
      return `<option value="" selected disabled>No installed provider found</option>`;
    }
    const selected = resolveProviderId(current);
    return providers
      .map((provider) => `<option value="${escapeHtml(provider.id)}"${provider.id === selected ? " selected" : ""}>${escapeHtml(provider.label || provider.id)} (${(provider.models || []).length})</option>`)
      .join("");
  }

  function buildProviderModelOptions(providerId, current) {
    const provider = providerCatalog()[providerId];
    if (!providerId || !provider || provider.available !== true) {
      return `<option value="" selected disabled>Discover an installed provider first</option>`;
    }
    const models = [...new Set(provider.models || [])]
      .sort((a, b) => String(a).localeCompare(String(b)));
    let html = `<option value="">(auto — provider default)</option>`;
    if (models.length === 0) {
      html += `<option value="" disabled>No models reported by this provider</option>`;
    }
    for (const model of models) {
      const displayName = provider.modelLabels?.[model];
      const label = displayName && displayName !== model ? `${displayName} — ${model}` : model;
      html += `<option value="${escapeHtml(model)}"${model === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }
    return html;
  }

  function providerCatalogSummary() {
    const providers = availableProviders();
    const modelCount = providers.reduce((sum, provider) => sum + (provider.models || []).length, 0);
    return `${providers.length} installed provider${providers.length === 1 ? "" : "s"} · ${modelCount} models`;
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
    for (const provider of Object.values(providerCatalog())) {
      const discovered = provider.modelVariants?.[modelId];
      if (Array.isArray(discovered) && discovered.length > 0) return discovered;
    }
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
    return agentRoles
      .map((role) => {
        const roleConfig = state.systemSettings?.pipeline?.roles?.find((item) => item.id === role);
        const requestedProvider = Object.prototype.hasOwnProperty.call(providerSelections, role)
          ? providerSelections[role]
          : st?.providerMapping?.[role] || roleConfig?.provider || defaultProviderId();
        const provider = resolveProviderId(requestedProvider);
        const configuredModel = Object.prototype.hasOwnProperty.call(modelSelections, role)
          ? modelSelections[role]
          : st?.modelMapping?.[role] || roleConfig?.model || "";
        const providerModels = providerCatalog()[provider]?.models || [];
        const current = requestedProvider === provider && providerModels.includes(configuredModel)
          ? configuredModel
          : "";
        const label = agentRoleLabels[role] || role;
        return `
          <div class="model-row">
            <label class="model-role">${escapeHtml(label)}</label>
            <select data-role="${escapeHtml(role)}" data-field="provider" class="model-select provider-select" aria-label="${escapeHtml(label)} provider" title="Installed agent CLI / model provider">
              ${buildProviderOptions(provider)}
            </select>
            <select data-role="${escapeHtml(role)}" data-field="model" class="model-select model-choice-select" aria-label="${escapeHtml(label)} model" title="Models reported by the selected provider only">
              ${buildProviderModelOptions(provider, current)}
            </select>
            ${buildVariantSelect(role, current)}
          </div>`;
      })
      .join("");
  }

  function buildApplyAllHtml(st) {
    const roleProviders = agentRoles.map((role) => resolveProviderId(
      Object.prototype.hasOwnProperty.call(providerSelections, role)
        ? providerSelections[role]
        : st?.providerMapping?.[role] || state.systemSettings?.pipeline?.roles?.find((item) => item.id === role)?.provider || defaultProviderId()
    ));
    const roleModels = agentRoles.map((role) => Object.prototype.hasOwnProperty.call(modelSelections, role)
      ? modelSelections[role]
      : st?.modelMapping?.[role] || state.systemSettings?.pipeline?.roles?.find((item) => item.id === role)?.model || "");
    const allProvidersSame = roleProviders.every((provider) => provider === roleProviders[0]);
    const currentProvider = allProvidersSame ? roleProviders[0] : defaultProviderId();
    const allSame = roleModels.every((model) => model === roleModels[0]);
    const configuredBulk = allSame ? roleModels[0] : "";
    const currentBulk = (providerCatalog()[currentProvider]?.models || []).includes(configuredBulk)
      ? configuredBulk
      : "";
    return `
      <div class="model-column-headings" aria-hidden="true">
        <span>Agent role</span><span>Provider / CLI</span><span>Available model</span><span>Variant</span>
      </div>
      <div class="apply-all-row">
        <label class="apply-all-label">Apply to all</label>
        <select id="apply-all-provider" class="model-select apply-all-select provider-select" aria-label="Provider for all agents">
          ${buildProviderOptions(currentProvider)}
        </select>
        <select id="apply-all-model" class="model-select apply-all-select model-choice-select" aria-label="Model for all agents">
          ${buildProviderModelOptions(currentProvider, currentBulk)}
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
    const hasInstalledProvider = availableProviders().length > 0;
    return `
      <div class="${wrapClass}" id="composer">
        <textarea id="composer-goal" class="${textareaClass}" rows="${rows}" placeholder="Describe the goal for the agent loop to achieve... (Ctrl+Enter to start)">${goalVal}</textarea>
        <div class="composer-meta">
          <input type="text" id="composer-target" class="composer-input" placeholder="${targetPlaceholder}" value="${targetVal}" title="Target project path where agents will modify and test code. Defaults to the current workspace folder." />
          <select id="composer-access-mode" class="composer-input composer-input-sm" title="Filesystem access mode">
            <option value="ask"${composerAccessMode === "ask" ? " selected" : ""}>Ask when needed</option>
            <option value="full_access"${composerAccessMode === "full_access" ? " selected" : ""}>Unsafe full access</option>
          </select>
          <button class="btn" id="composer-start" ${hasInstalledProvider ? "" : "disabled"} title="${hasInstalledProvider ? "Start the agent loop" : "Discover and install at least one supported provider first"}">Start Session</button>
          ${cancelBtn}
        </div>
      </div>`;
  }

  function composerTargetDefault() {
    return state.defaultTargetPath || state.state?.targetProjectPath || "";
  }

  function renderEmpty(root) {
    const modelGrid = buildModelGrid(null);

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
            <button class="btn secondary" id="btn-settings">Models & Tools</button>
            <span class="composer-hint">${state.registry?.modelsDiscoveredAt ? "Last discovered: " + escapeHtml(formatDate(state.registry.modelsDiscoveredAt)) : "No models discovered yet."}</span>
          </div>
        </div>
      </div>`;
    bindComposer();
    bindModelSelects();
    const btnDiscover = document.getElementById("btn-discover");
    if (btnDiscover) btnDiscover.onclick = () => vscode.postMessage({ command: "discoverModels" });
    const btnSettings = document.getElementById("btn-settings");
    if (btnSettings) btnSettings.onclick = openSettings;
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

    const operator = state.operatorSnapshot;
    const budgets = operator?.budgets;
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
    const attemptDisplay = `${activeAttempt?.attemptNumber || 0} / ${Math.min(activeAttempt?.maxAttempts || 0, st?.resilience?.maxAgentAttempts || activeAttempt?.maxAttempts || 0)}`;
    const latestRequirementStatuses = new Map();
    for (const evidence of st?.requirements?.evidence || []) {
      latestRequirementStatuses.set(evidence.requirementId, evidence.status);
    }
    const requirementItems = st?.requirements?.items || [];
    const satisfiedRequirements = requirementItems.filter(
      (item) => latestRequirementStatuses.get(item.id) === "SATISFIED"
    ).length;
    const unresolvedRequirements = requirementItems.length - satisfiedRequirements;
    const statusRows = st
      ? `
        <div class="status-row"><span class="label">Session</span><span class="value">${escapeHtml(st.sessionId)}</span></div>
        <div class="status-row"><span class="label">Status</span>${statusBadge}</div>
        ${operator?.pauseReason ? `<div class="status-row"><span class="label">Pause reason</span><span class="value">${escapeHtml(operator.pauseReason)}</span></div>` : ""}
        ${operator ? `<div class="status-row"><span class="label">Next action</span><span class="value">${escapeHtml(operator.nextPermittedAction)}</span></div>` : ""}
        ${operator ? `<div class="status-row"><span class="label">Progress</span><span class="value">${escapeHtml(operator.progressSummary)}</span></div>` : ""}
        <div class="status-row"><span class="label">Lease</span><span class="value">${escapeHtml(state.runtimeLeaseStatus || "none")}</span></div>
        <div class="status-row"><span class="label">Phase</span><span class="value">${escapeHtml(operator?.currentStage || st.phase)}</span></div>
        <div class="status-row"><span class="label">Role</span><span class="value">${escapeHtml(operator?.currentRole || stageDefinition?.role || "unknown")}</span></div>
        ${budgets ? `<div class="status-row"><span class="label">Cycle budget</span><span class="value">${budgets.cycles.remaining} remaining · ${budgets.cycles.consumed}/${budgets.cycles.limit} consumed</span></div>` : `<div class="status-row"><span class="label">Loop</span><span class="value">${st.loopCount} started · ${st.completedIterations ?? 0} completed / ${st.maxCycles}</span></div>`}
        ${budgets ? `<div class="status-row"><span class="label">Workflow steps</span><span class="value">${budgets.workflowSteps.remaining} remaining · ${budgets.workflowSteps.consumed}/${budgets.workflowSteps.limit} consumed</span></div>` : ""}
        ${budgets && budgets.stageAttempts.remaining !== null ? `<div class="status-row"><span class="label">Stage attempts</span><span class="value">${budgets.stageAttempts.remaining} remaining · ${budgets.stageAttempts.consumed}/${budgets.stageAttempts.limit} consumed</span></div>` : ""}
        ${requirementItems.length > 0 ? `<div class="status-row"><span class="label">Requirements</span><span class="value">${satisfiedRequirements} satisfied · ${unresolvedRequirements} unresolved / ${requirementItems.length}</span></div>` : ""}
        ${st.convergence?.stagnantCycles ? `<div class="status-row"><span class="label">Stagnation</span><span class="value">${st.convergence.stagnantCycles} non-improving cycle(s)</span></div>` : ""}
        ${activeAttempt ? `
        <div class="status-row"><span class="label">Attempt</span><span class="value">${escapeHtml(attemptDisplay)} · ${escapeHtml(activeAttempt.status)}</span></div>
        <div class="status-row"><span class="label">Activity</span><span class="value">${escapeHtml(attemptActivity)}${activityTimeoutMs ? ` · ${Math.round(activityTimeoutMs / 1000)}s timeout` : ""}</span></div>
        <div class="status-row"><span class="label">Reconnect</span><span class="value">${activeAttempt.reconnectUsed ? "used" : "not used"}</span></div>
        <div class="status-row"><span class="label">Last progress</span><span class="value">${lastProgressAge === null ? "none" : lastProgressAge + "s ago"}</span></div>
        ${activeAttempt.nextRetryAt ? `<div class="status-row"><span class="label">Retry at</span><span class="value">${escapeHtml(formatDate(activeAttempt.nextRetryAt))}</span></div>` : ""}
        ` : ""}
        ${st.lastFailure ? `<div class="status-row"><span class="label">Last failure</span><span class="value">${escapeHtml(st.lastFailure.kind)}</span></div>` : ""}
        ${st.interruptBriefing ? `<div class="error-queue"><div class="status-row" style="display:block"><span class="label">Local failure briefing</span></div><div class="error-queue-item">${escapeHtml(String(st.interruptBriefing).slice(0, 2000))}</div></div>` : ""}
        <div class="status-row"><span class="label">Goal</span><span class="value" style="text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis">${escapeHtml(String(st.goal).slice(0, 80))}</span></div>
        ${st.referenceIdentity ? `<div class="status-row"><span class="label">Reference</span><span class="value" style="text-align:right;max-width:68%">${escapeHtml(st.referenceIdentity.title)} / ${escapeHtml(st.referenceIdentity.creator)} / ${escapeHtml(st.referenceIdentity.packageId)} <span class="badge success">${escapeHtml(st.referenceIdentity.identityMatch)} · ${escapeHtml(st.referenceIdentity.confidence)}</span></span></div>` : ""}
        <div class="status-row"><span class="label">Target</span><span class="value" style="text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis">${escapeHtml(String(st.targetProjectPath).slice(0, 60))}</span></div>
        <div class="status-row"><span class="label">CLI</span><span class="value">${escapeHtml(st.cliProfile || "opencode")} / ${escapeHtml(st.cliBinary || "")}</span></div>
        ${st.errorQueue && st.errorQueue.length > 0 ? `<div class="error-queue"><div class="status-row" style="display:block"><span class="label">Error Queue (Lookback-5):</span></div>${st.errorQueue
          .map((e) => `<div class="error-queue-item">[${escapeHtml(e.phase)}] ${escapeHtml(e.signature)}</div>`)
          .join("")}</div>` : ""}
      `
      : `<div class="notes-empty">No session selected.</div>`;

    const pendingAccess = st?.pendingAccessRequest;
    const accessMode = st?.accessMode || "ask";
    const heldForAccess = st && ["PAUSED", "WAITING_USER", "STOPPED", "BLOCKED"].includes(st.status);
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
            <div class="access-hint">Unsafe mode: the provider keeps your OS user privileges; this is not isolation from files outside the project or from Agent Loop control data.</div>
          ` : heldForAccess ? `
            <div class="access-editor-footer">
              <span class="access-hint">${accessMode === "full_access" ? "Unsafe mode: the provider has your OS user privileges and this is not a security boundary." : "The loop will pause and ask before using paths outside the target."}</span>
              <button class="btn secondary" id="btn-toggle-access">${accessMode === "full_access" ? "Use Ask Mode" : "Grant Full Access"}</button>
            </div>
          ` : `<div class="access-hint">Stop or hold the session to change this mode.</div>`}
        </div>`
      : "";

    const timeline = state.timeline || [];
    const timelineList = [...timeline]
      .reverse()
      .map(
        (event) => `<li class="history-item">
          <span><span class="phase">#${event.sequence} ${escapeHtml(event.type)}</span>${event.stageId ? ` &middot; ${escapeHtml(event.stageId)}` : ""}${event.role ? ` &middot; ${escapeHtml(event.role)}` : ""}</span>
          <span class="result">${escapeHtml(formatDate(event.recordedAt))}</span>
          <div class="interrupt-msg">${escapeHtml(event.summary)}</div>
        </li>`
      )
      .join("");

    const notesContent = state.progressNotes
      ? escapeHtml(state.progressNotes)
      : '<span class="notes-empty">(no notes yet)</span>';

    const currentLogBuffer = selectedLogBuffer();
    const logContent = currentLogBuffer
      ? `<div class="log-content">${escapeHtml(currentLogBuffer)}</div>`
      : '<div class="log-empty">(no log output yet)</div>';

    const canResume = st && ["PAUSED", "WAITING_USER", "STOPPED", "BLOCKED"].includes(st.status) &&
      !st.pendingAccessRequest && !(st.awaitingPlanApproval && !st.planApproved);
    const canStop = state.isRunning;
    root.innerHTML = `
      ${summaryBanner}
      <div class="toolbar">
        <select id="session-select">${sessionOptions}</select>
        <button class="btn secondary" id="btn-resume" ${canResume ? "" : "disabled"}>Resume</button>
        <button class="btn danger" id="btn-stop" ${(isStopping || !canStop) ? "disabled" : ""}>${isStopping ? "Terminating..." : "Stop"}</button>
        <button class="btn danger" id="btn-delete" ${!state.selectedSessionId ? "disabled" : ""} title="Delete this session and all its data">Delete</button>
        <button class="btn secondary" id="btn-discover">Models</button>
        <button class="btn secondary" id="btn-settings">Settings</button>
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
          <h3>Operator Notes${isStopping ? '<span class="pending-indicator"> \u2014 terminating agent now\u2026</span>' : ""}</h3>
          <div class="notes-content">${notesContent}</div>
        </div>
        <div class="card history-card">
          <h3>Domain Timeline (${timeline.length})${isStopping ? '<span class="pending-indicator"> \u2014 terminating agent now\u2026</span>' : ""}</h3>
          <ul class="history-list">${timelineList || '<li class="notes-empty">(no domain events yet)</li>'}</ul>
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
    const btnSettings = document.getElementById("btn-settings");
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
    if (btnSettings) btnSettings.onclick = openSettings;
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
        if (e.target.dataset.field === "provider") {
          providerSelections[role] = e.target.value;
          modelSelections[role] = "";
          variantSelections[role] = "";
          requestRender();
        } else if (e.target.dataset.field === "variant") {
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
        } else if (e.target.dataset.field === "model") {
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
    const applyAllProvider = document.getElementById("apply-all-provider");
    if (applyAllProvider) applyAllProvider.onchange = (e) => {
      for (const role of agentRoles) {
        providerSelections[role] = e.target.value;
        modelSelections[role] = "";
        variantSelections[role] = "";
      }
      requestRender();
    };
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
        if (sel.dataset.field === "model" && role) sel.value = val;
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
    const fallbackProvider = defaultProviderId();
    if (!fallbackProvider) {
      vscode.postMessage({ command: "discoverModels" });
      return;
    }
    const mapping = {};
    const providerMapping = {};
    for (const role of agentRoles) {
      if (modelSelections[role]) mapping[role] = modelSelections[role];
      providerMapping[role] = resolveProviderId(providerSelections[role] || fallbackProvider);
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
      modelMapping: mapping,
      providerMapping: providerMapping,
      variantMapping: variantMapping,
    });
    composingNew = false;
    composerGoal = "";
    const goalEl = document.getElementById("composer-goal");
    if (goalEl) goalEl.value = "";
  }

  function cloneSettings(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function openSettings() {
    settingsDraft = cloneSettings(state.systemSettings);
    settingsOpen = true;
    settingsSection = "models";
    lastStateSig = "";
    render();
  }

  function uniqueId(prefix, existing) {
    let index = 1;
    while (existing.includes(`${prefix}_${index}`)) index++;
    return `${prefix}_${index}`;
  }

  function optionList(values, current) {
    return values.map((value) => `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(value)}</option>`).join("");
  }

  function mcpToolCapabilityText(server) {
    const explicit = Array.isArray(server.tools) ? server.tools : [];
    if (explicit.length > 0) {
      return explicit.map((tool) => `${tool.name}: ${tool.sideEffect || "unknown"}`).join("\n");
    }
    return (server.allowedTools || []).map((name) => `${name}: unknown`).join("\n");
  }

  function parseMcpToolCapabilities(value) {
    return listValue(value).map((line) => {
      const match = line.match(/^(.*?):\s*(read_only|write|unknown)$/i);
      return match
        ? { name: match[1].trim(), sideEffect: match[2].toLowerCase() }
        : { name: line, sideEffect: "unknown" };
    });
  }

  function renderSettings(root) {
    if (!settingsDraft) settingsDraft = cloneSettings(state.systemSettings);
    const providers = settingsDraft.providers || {};
    const tools = settingsDraft.toolAccess || { webSearch: { enabled: false, mode: "cached" }, mcpServers: [] };
    const pipeline = settingsDraft.pipeline || { version: 1, name: "custom", stageTypes: [], roles: [], stages: [] };
    const providerCards = Object.entries(providers).map(([id, provider]) => `
      <div class="settings-item">
        <div class="settings-item-title"><strong>${escapeHtml(id)}</strong><button class="btn danger compact-btn" data-remove-provider="${escapeHtml(id)}">Remove</button></div>
        <div class="settings-grid">
          <label>Enabled <input type="checkbox" data-provider="${escapeHtml(id)}" data-setting-field="enabled" ${provider.enabled !== false ? "checked" : ""}></label>
          <label>Label <input value="${escapeHtml(provider.label || id)}" data-provider="${escapeHtml(id)}" data-setting-field="label"></label>
          <label>Adapter <select data-provider="${escapeHtml(id)}" data-setting-field="adapter">${optionList(["opencode", "kilo", "codex", "claude"], provider.adapter)}</select></label>
          <label>Binary <input value="${escapeHtml(provider.binary || id)}" data-provider="${escapeHtml(id)}" data-setting-field="binary"></label>
          <label class="wide">Model discovery args (one per line)<textarea rows="2" data-provider="${escapeHtml(id)}" data-setting-field="modelsArgs">${escapeHtml((provider.modelsArgs || []).join("\n"))}</textarea></label>
          <label class="wide">Models / fallback models (one per line)<textarea rows="3" data-provider="${escapeHtml(id)}" data-setting-field="fallbackModels">${escapeHtml((provider.fallbackModels || []).join("\n"))}</textarea></label>
        </div>
      </div>`).join("");

    const mcpCards = (tools.mcpServers || []).map((server, index) => `
      <div class="settings-item">
        <div class="settings-item-title"><strong>${escapeHtml(server.id)}</strong><button class="btn danger compact-btn" data-remove-mcp="${index}">Remove</button></div>
        <div class="settings-grid">
          <label>Enabled <input type="checkbox" data-mcp="${index}" data-setting-field="enabled" ${server.enabled !== false ? "checked" : ""}></label>
          <label>Name <input value="${escapeHtml(server.name || server.id)}" data-mcp="${index}" data-setting-field="name"></label>
          <label>Transport <select data-mcp="${index}" data-setting-field="type">${optionList(["local", "remote"], server.type || "local")}</select></label>
          <label>Command <input value="${escapeHtml(server.command || "")}" data-mcp="${index}" data-setting-field="command" placeholder="npx"></label>
          <label class="wide">Arguments (one per line)<textarea rows="2" data-mcp="${index}" data-setting-field="args">${escapeHtml((server.args || []).join("\n"))}</textarea></label>
          <label class="wide">Remote URL <input value="${escapeHtml(server.url || "")}" data-mcp="${index}" data-setting-field="url" placeholder="https://..."></label>
          <label>Timeout ms <input type="number" min="1" value="${escapeHtml(server.timeoutMs || 60000)}" data-mcp="${index}" data-setting-field="timeoutMs"></label>
          <label class="wide">Tool capabilities (name: read_only | write | unknown; empty = mutation roles only)<textarea rows="3" data-mcp="${index}" data-setting-field="tools">${escapeHtml(mcpToolCapabilityText(server))}</textarea></label>
          <label class="wide">Environment JSON <textarea rows="2" data-mcp="${index}" data-setting-field="environment">${escapeHtml(JSON.stringify(server.environment || {}, null, 2))}</textarea></label>
          <label class="wide">Headers JSON <textarea rows="2" data-mcp="${index}" data-setting-field="headers">${escapeHtml(JSON.stringify(server.headers || {}, null, 2))}</textarea></label>
        </div>
      </div>`).join("");

    const installedProviders = availableProviders();
    const installedProviderIds = new Set(installedProviders.map((provider) => provider.id));
    const modelAssignmentCards = (pipeline.roles || []).map((role, index) => {
      const selectedProvider = installedProviderIds.has(role.provider) ? role.provider : "";
      const unavailableProvider = role.provider && !installedProviderIds.has(role.provider)
        ? `<span class="provider-unavailable">Configured provider '${escapeHtml(role.provider)}' is not installed.</span>`
        : "";
      const providerOptions = installedProviders
        .map((provider) => `<option value="${escapeHtml(provider.id)}"${provider.id === selectedProvider ? " selected" : ""}>${escapeHtml(provider.label || provider.id)} (${(provider.models || []).length})</option>`)
        .join("");
      const filteredModel = selectedProvider && (providerCatalog()[selectedProvider]?.models || []).includes(role.model || "")
        ? role.model || ""
        : "";
      const modelOptions = selectedProvider
        ? buildProviderModelOptions(selectedProvider, filteredModel)
        : `<option value="" selected>Select a provider first</option>`;
      return `
        <div class="settings-item compact-settings-item model-assignment-item">
          <div class="settings-item-title"><strong>${escapeHtml(role.id)}</strong><span class="composer-hint">${escapeHtml(role.description || role.modelRole)}</span>${unavailableProvider}</div>
          <div class="settings-grid model-assignment-grid">
            <label>Provider / CLI <select class="settings-provider-select" data-role-setting="${index}" data-setting-field="provider"><option value="">Per session</option>${providerOptions}</select></label>
            <label>Available model <select class="settings-model-select" data-role-setting="${index}" data-setting-field="model" ${selectedProvider ? "" : "disabled"}>${modelOptions}</select></label>
            <label>Variant <input value="${escapeHtml(role.variant || "")}" data-role-setting="${index}" data-setting-field="variant" placeholder="Provider default"></label>
          </div>
        </div>`;
    }).join("");

    const settingsContent = settingsSection === "models"
      ? `<div class="card settings-section-card" data-settings-section="models">
          <h3>Model providers / agent CLIs</h3>
          <p class="composer-hint">Each provider is the installed agent CLI that discovers and runs its own models.</p>
          ${providerCards}<button class="btn secondary" id="add-provider">Add provider</button>
          <h3>Agent model assignments</h3>
          <p class="composer-hint">Choose one installed provider. The model list contains only models owned by that provider.</p>
          ${modelAssignmentCards}
        </div>`
      : `<div class="card settings-section-card" data-settings-section="tools">
          <h3>Web search</h3>
          <div class="settings-grid"><label>Web search <input id="web-enabled" type="checkbox" ${tools.webSearch?.enabled ? "checked" : ""}></label><label>Search mode <select id="web-mode">${optionList(["cached", "live"], tools.webSearch?.mode || "cached")}</select></label></div>
          <h3>MCP servers</h3>
          ${mcpCards}<button class="btn secondary" id="add-mcp">Add MCP server</button>
          <p class="settings-global-note">Enabled web search and MCP servers are applied to every agent in the pipeline.</p>
        </div>`;

    root.innerHTML = `
      <div class="settings-page">
        <div class="toolbar sticky-toolbar"><button class="btn secondary" id="settings-back">Back</button><h2>Agent Loop Settings</h2><button class="btn" id="settings-save">Save Settings</button></div>
        <div class="settings-tabs" role="tablist" aria-label="Agent Loop settings sections">
          <button class="settings-tab${settingsSection === "models" ? " active" : ""}" data-settings-tab="models" role="tab" aria-selected="${settingsSection === "models"}">Models</button>
          <button class="settings-tab${settingsSection === "tools" ? " active" : ""}" data-settings-tab="tools" role="tab" aria-selected="${settingsSection === "tools"}">Tools</button>
        </div>
        ${settingsContent}
      </div>`;
    bindSettings();
  }

  function listValue(value) {
    return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }

  function bindSettings() {
    const rerenderSettings = () => { lastStateSig = ""; render(); };
    document.getElementById("settings-back").onclick = () => { settingsOpen = false; settingsDraft = null; lastStateSig = ""; render(); };
    document.getElementById("settings-save").onclick = () => {
      vscode.postMessage({ command: "saveSystemSettings", settings: settingsDraft });
    };
    document.querySelectorAll("[data-settings-tab]").forEach((button) => button.onclick = () => {
      settingsSection = button.dataset.settingsTab;
      rerenderSettings();
    });
    const webEnabled = document.getElementById("web-enabled");
    const webMode = document.getElementById("web-mode");
    if (webEnabled) webEnabled.onchange = (event) => { settingsDraft.toolAccess.webSearch.enabled = event.target.checked; };
    if (webMode) webMode.onchange = (event) => { settingsDraft.toolAccess.webSearch.mode = event.target.value; };
    document.querySelectorAll("[data-provider]").forEach((input) => input.oninput = input.onchange = (event) => {
      const provider = settingsDraft.providers[event.target.dataset.provider];
      const field = event.target.dataset.settingField;
      provider[field] = field === "enabled" ? event.target.checked : ["modelsArgs", "fallbackModels"].includes(field) ? listValue(event.target.value) : event.target.value;
    });
    document.querySelectorAll("[data-mcp]").forEach((input) => input.oninput = input.onchange = (event) => {
      const server = settingsDraft.toolAccess.mcpServers[Number(event.target.dataset.mcp)];
      const field = event.target.dataset.settingField;
      try {
        server[field] = field === "enabled" ? event.target.checked
          : field === "args" ? listValue(event.target.value)
          : field === "tools" ? parseMcpToolCapabilities(event.target.value)
          : ["environment", "headers"].includes(field) ? JSON.parse(event.target.value || "{}")
          : field === "timeoutMs" ? Number(event.target.value) : event.target.value;
        if (field === "tools") server.allowedTools = server.tools.map((tool) => tool.name);
        event.target.setCustomValidity("");
      } catch {
        event.target.setCustomValidity("Enter a valid JSON object.");
      }
    });
    document.querySelectorAll("[data-role-setting]").forEach((input) => input.oninput = input.onchange = (event) => {
      const role = settingsDraft.pipeline.roles[Number(event.target.dataset.roleSetting)];
      const field = event.target.dataset.settingField;
      if (field === "provider") {
        if (event.target.value) role.provider = event.target.value;
        else delete role.provider;
        delete role.model;
        delete role.variant;
        rerenderSettings();
        return;
      }
      if (["provider", "model", "variant"].includes(field) && !event.target.value) {
        delete role[field];
      } else role[field] = event.target.value;
    });
    document.querySelectorAll("[data-remove-provider]").forEach((button) => button.onclick = () => { delete settingsDraft.providers[button.dataset.removeProvider]; rerenderSettings(); });
    document.querySelectorAll("[data-remove-mcp]").forEach((button) => button.onclick = () => { settingsDraft.toolAccess.mcpServers.splice(Number(button.dataset.removeMcp), 1); rerenderSettings(); });
    const addProvider = document.getElementById("add-provider");
    if (addProvider) addProvider.onclick = () => {
      const id = uniqueId("provider", Object.keys(settingsDraft.providers));
      settingsDraft.providers[id] = { label: id, adapter: "opencode", binary: "opencode", enabled: true, modelsArgs: ["models"], fallbackModels: [] };
      rerenderSettings();
    };
    const addMcp = document.getElementById("add-mcp");
    if (addMcp) addMcp.onclick = () => {
      const ids = settingsDraft.toolAccess.mcpServers.map((server) => server.id);
      const id = uniqueId("mcp", ids);
      settingsDraft.toolAccess.mcpServers.push({ id, name: id, enabled: true, type: "local", command: "npx", args: [], environment: {}, headers: {}, tools: [], allowedTools: [], timeoutMs: 60000 });
      rerenderSettings();
    };
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
      state = msg.payload;
      const knownSessionIds = new Set(
        (state.registry?.sessionMetas || []).map((meta) => meta.sessionId)
      );
      if (state.selectedSessionId) knownSessionIds.add(state.selectedSessionId);
      for (const sessionId of Object.keys(logBuffers)) {
        if (!knownSessionIds.has(sessionId)) delete logBuffers[sessionId];
      }
      const configuredRoles = state.systemSettings?.pipeline?.roles || [];
      if (configuredRoles.length > 0) {
        agentRoles = configuredRoles.map((role) => role.id);
        for (const role of configuredRoles) agentRoleLabels[role.id] = role.description || role.id;
      }
      if (msg.payload.selectedSessionId !== prevSelectedSessionId) {
        prevSelectedSessionId = msg.payload.selectedSessionId;
        modelSelections = { ...(msg.payload.state?.modelMapping || modelSelections) };
        providerSelections = { ...(msg.payload.state?.providerMapping || providerSelections) };
        if (msg.payload.variantMapping) {
          variantSelections = { ...msg.payload.variantMapping };
        } else {
          variantSelections = {};
        }
      }
      if (stoppingSessionId && (!msg.payload.isRunning || msg.payload.selectedSessionId !== stoppingSessionId)) {
        stoppingSessionId = null;
      }
      requestRender();
    } else if (msg.command === "logAppend") {
      const sessionId = msg.sessionId;
      if (!sessionId) return;
      const text = msg.entry.text;
      const nextBuffer = ((logBuffers[sessionId] || "") + text).slice(-maxLogSize);
      logBuffers[sessionId] = nextBuffer;
      if (sessionId !== state.selectedSessionId) return;
      const logEl = document.querySelector(".log-content");
      if (logEl) {
        logEl.textContent = nextBuffer;
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
