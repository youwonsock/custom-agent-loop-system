/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/renderer/styles.css"
/*!*********************************!*\
  !*** ./src/renderer/styles.css ***!
  \*********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
// extracted by mini-css-extract-plugin


/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	const __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		const cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		const module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			const e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = (exports) => {
/******/ 		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/ 	
/************************************************************************/
let __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
let exports = __webpack_exports__;
/*!*************************!*\
  !*** ./src/renderer.ts ***!
  \*************************/

Object.defineProperty(exports, "__esModule", ({ value: true }));
__webpack_require__(/*! ./renderer/styles.css */ "./src/renderer/styles.css");
const bridge = window.desktopBridge;
let snapshot = null;
let selectedSession;
let activeTab = "overview";
const logsBySession = new Map();
let settingsDraft = null;
let sessionBundle = null;
let sessionBundleId;
const planDraftChoices = new Map();
const el = (id) => {
    const node = document.getElementById(id);
    if (!node)
        throw new Error(`Missing UI element ${id}`);
    return node;
};
function escapeHtml(value) {
    return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
function sanitizeMarkdown(value) {
    // Escape first so raw HTML/script blocks can never become DOM nodes. Remote
    // images are omitted; HTTP(S) links become inert buttons whose navigation
    // is confirmed by the main process through DesktopBridge.
    const escaped = escapeHtml(value);
    return escaped
        .replace(/!\[([^\]]*)\]\((?:https?:\/\/|data:)[^)]+\)/giu, "[$1 image omitted]")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/giu, (_match, label, url) => `<button type="button" class="markdown-link" data-external-url="${url}">${label}</button>`);
}
function setNotice(message, level = "info") {
    const notice = el("notice");
    notice.hidden = !message;
    notice.textContent = message;
    notice.dataset.level = level;
}
function statusLabel(status) { return status.replace(/_/gu, " ").toLowerCase().replace(/(^|\s)\S/gu, (value) => value.toUpperCase()); }
function currentProjection() { return snapshot?.projection ?? null; }
function renderSessions() {
    const list = el("session-list");
    list.replaceChildren();
    const sessions = snapshot?.sessionIndex.sessionMetas ?? [];
    if (sessions.length === 0) {
        list.innerHTML = `<div class="empty">No sessions yet.</div>`;
        return;
    }
    for (const session of [...sessions].reverse()) {
        const button = document.createElement("button");
        button.className = `session-item${session.sessionId === selectedSession ? " selected" : ""}`;
        button.innerHTML = `<strong>${escapeHtml(session.goal)}</strong><small>${escapeHtml(statusLabel(session.status))} · ${escapeHtml(session.sessionId)}</small>`;
        button.addEventListener("click", () => { selectedSession = session.sessionId; void loadSnapshot(); });
        list.append(button);
    }
}
function renderOverview(projection) {
    const panel = el("tab-overview");
    if (!projection) {
        panel.innerHTML = `<div class="empty">Choose New Session to start.</div>`;
        return;
    }
    const pending = projection.pendingInput;
    const accessGate = pending?.kind === "access_approval"
        ? `<div class="card access-gate"><h3>Provider access request</h3><p>${escapeHtml(String(pending.prompt ?? "The provider requested project access."))}</p><div class="actions"><button id="allow-access" class="primary">Allow</button><button id="deny-access" class="secondary">Deny</button></div></div>`
        : pending?.kind === "custom"
            ? `<div class="card access-gate"><h3>Operator input required</h3><p>${escapeHtml(String(pending.prompt ?? "The session is waiting for input."))}</p></div>`
            : "";
    const verification = projection.verification;
    const candidate = verification?.pendingApproval;
    const candidateCommandRows = candidate?.commands?.length
        ? `<details><summary>Proposed commands</summary><ul>${candidate.commands.slice(0, 10).map((command) => {
            const invocation = `${String(command.executable ?? "")} ${(Array.isArray(command.args) ? command.args : []).map(String).join(" ")}`.trim();
            return `<li><strong>${escapeHtml(String(command.label ?? command.id ?? "command"))}</strong>: <code>${escapeHtml(invocation)}</code> · ${escapeHtml(String(command.timeoutMs ?? "—"))} ms</li>`;
        }).join("")}</ul></details>`
        : "";
    const candidateDiff = candidate
        ? `<p class="muted">Added: ${escapeHtml((candidate.addedPaths ?? []).filter((value) => typeof value === "string").slice(0, 20).join(", ") || "none")}</p><p class="muted">Modified: ${escapeHtml((candidate.modifiedPaths ?? []).filter((value) => typeof value === "string").slice(0, 20).join(", ") || "none")}</p><p class="muted">Deleted: ${escapeHtml((candidate.deletedPaths ?? []).filter((value) => typeof value === "string").slice(0, 20).join(", ") || "none")}</p>`
        : "";
    const contract = verification?.contract;
    const contractPaths = contract
        ? `<p class="muted">Protected: ${escapeHtml(contract.protectedPaths.slice(0, 12).join(", ") || "none")}</p><p class="muted">Tests: ${escapeHtml(contract.testRoots.slice(0, 12).join(", ") || "none")} · New tests: ${escapeHtml(contract.allowedNewTestRoots.slice(0, 12).join(", ") || "none")}</p><p class="muted">Generated output: ${escapeHtml(contract.generatedOutputPaths.slice(0, 12).join(", ") || "none")}</p>`
        : "";
    const verificationGate = pending?.kind === "verification_approval" && candidate
        ? `<div class="card access-gate"><h3>Verification reapproval required</h3><p>${escapeHtml(String(pending.prompt ?? "Verification criteria changed."))}</p><p class="muted">Candidate ${escapeHtml(String(candidate.candidateHash ?? ""))}</p><p class="muted">Changed: ${escapeHtml((candidate.changedPaths ?? []).filter((value) => typeof value === "string").slice(0, 20).join(", ") || "none")}</p>${candidateDiff}${candidateCommandRows}<p class="muted">Total timeout: ${escapeHtml(String(candidate.totalTimeoutMs ?? "—"))} ms</p><p class="muted">Protected: ${escapeHtml((candidate.protectedPaths ?? []).filter((value) => typeof value === "string").slice(0, 12).join(", ") || "none")}</p><p class="muted">Tests: ${escapeHtml((candidate.testRoots ?? []).filter((value) => typeof value === "string").slice(0, 12).join(", ") || "none")} · New tests: ${escapeHtml((candidate.allowedNewTestRoots ?? []).filter((value) => typeof value === "string").slice(0, 12).join(", ") || "none")}</p><div class="actions"><button id="approve-verification" class="primary">Approve</button><button id="reject-verification" class="secondary">Reject</button></div></div>`
        : "";
    const commandRows = verification?.commands?.length
        ? `<table class="verification-commands"><thead><tr><th>Command</th><th>Status</th><th>Exit</th><th>Time</th></tr></thead><tbody>${verification.commands.map((command) => {
            const item = command;
            const status = String(item.status ?? "unknown");
            const exit = item.exitCode === null || item.exitCode === undefined ? "—" : String(item.exitCode);
            const elapsed = typeof item.elapsedMs === "number" ? `${item.elapsedMs} ms` : "—";
            const invocation = `${String(item.executable ?? "")} ${(Array.isArray(item.args) ? item.args : []).map(String).join(" ")}`.trim();
            return `<tr><td title="${escapeHtml(invocation)}">${escapeHtml(String(item.commandId ?? ""))}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(exit)}</td><td>${escapeHtml(elapsed)}</td></tr>`;
        }).join("")}</tbody></table>`
        : "";
    const criteriaChanges = verification?.criteriaChanges?.length
        ? `<p class="warning">Criteria changes: ${escapeHtml(verification.criteriaChanges.slice(0, 12).join(", "))}</p>`
        : "";
    const verificationCard = verification
        ? `<div class="card details-card"><h3>Core verification</h3><p>Contract revision ${verification.contractRevision ?? "—"} · ${verification.completedCommands}/${verification.commandCount} commands${contract ? ` · ${verification.elapsedMs} / ${contract.totalTimeoutMs} ms` : ""}</p><p>Proof: ${escapeHtml(verification.proofId ?? "none")} · ${verification.proofValid ? "valid" : "pending or invalid"}</p>${contract ? `<p class="muted">Contract hash: ${escapeHtml(contract.contractHash)}</p><p class="muted">Baseline: ${escapeHtml(contract.baselineFingerprint)}</p>${contractPaths}` : ""}${criteriaChanges}${verification.invalidationReason ? `<p class="error">${escapeHtml(verification.invalidationReason)}</p>` : ""}${commandRows}</div>`
        : "";
    panel.innerHTML = `${accessGate}${verificationGate}<div class="cards"><div class="card"><h3>Status</h3><strong>${escapeHtml(statusLabel(projection.status))}</strong></div><div class="card"><h3>Current phase</h3><strong>${escapeHtml(projection.phase || projection.currentNodeId)}</strong></div><div class="card"><h3>Access</h3><strong>${escapeHtml(projection.accessMode === "full_access" ? "Full Access" : "Ask")}</strong></div><div class="card"><h3>Workflow steps</h3><strong>${projection.budgets.workflowSteps.consumed} / ${projection.budgets.workflowSteps.limit}</strong></div><div class="card"><h3>Cycles</h3><strong>${projection.budgets.cycles.completed} / ${projection.budgets.cycles.limit}</strong></div><div class="card"><h3>Revision</h3><strong>${projection.revision}</strong></div></div>${verificationCard}<div class="card details-card"><h3>Goal</h3><p>${escapeHtml(projection.goal)}</p><h3>Project</h3><p>${escapeHtml(projection.targetProjectPath)}</p><div class="actions"><button id="stop-session" class="danger secondary">Stop</button><button id="interrupt-session" class="secondary">Interrupt</button><button id="resume-session" class="secondary">Resume</button><button id="reveal-session" class="secondary">Open Folder</button><button id="delete-session" class="danger secondary">Delete</button></div></div>`;
    el("stop-session").onclick = () => void action(() => bridge.stopSession(projection.sessionId));
    el("interrupt-session").onclick = () => { const message = window.prompt("Interrupt message", "Operator requested an interruption."); if (message)
        void action(() => bridge.interruptSession(projection.sessionId, message)); };
    el("resume-session").onclick = () => void action(() => bridge.resumeSession(projection.sessionId));
    el("reveal-session").onclick = () => void action(() => bridge.revealSessionFolder(projection.sessionId));
    el("delete-session").onclick = () => void action(() => bridge.deleteSession(projection.sessionId));
    if (pending?.kind === "access_approval") {
        el("allow-access").onclick = () => void action(() => bridge.resolveAccessRequest(projection.sessionId, true));
        el("deny-access").onclick = () => void action(() => bridge.resolveAccessRequest(projection.sessionId, false));
    }
    if (pending?.kind === "verification_approval" && typeof candidate?.candidateHash === "string") {
        el("approve-verification").onclick = () => void action(() => bridge.approveVerification(projection.sessionId, String(projection.pendingInput.requestId ?? ""), candidate.candidateHash));
        el("reject-verification").onclick = () => { const message = window.prompt("Why should this verification change be rejected?", ""); if (message)
            void action(() => bridge.rejectVerification(projection.sessionId, String(projection.pendingInput.requestId ?? ""), candidate.candidateHash, message)); };
    }
}
function renderPlan(projection) {
    const panel = el("tab-plan");
    if (!projection) {
        panel.innerHTML = `<div class="empty">No plan is available.</div>`;
        return;
    }
    const choices = projection.planChoices ?? [];
    if (choices.length === 0) {
        panel.innerHTML = `<div class="empty">The planner has not produced choices yet.</div>`;
        return;
    }
    if (projection.awaitingPlanApproval && !projection.selectedPlanChoiceId && !planDraftChoices.has(projection.sessionId))
        planDraftChoices.set(projection.sessionId, choices[0].id);
    const selected = planDraftChoices.get(projection.sessionId) ?? projection.selectedPlanChoiceId ?? choices[0].id;
    if (!choices.some((choice) => choice.id === selected))
        planDraftChoices.delete(projection.sessionId);
    const effectiveSelected = choices.some((choice) => choice.id === selected) ? selected : choices[0].id;
    const selectedChoice = choices.find((choice) => choice.id === effectiveSelected);
    const verification = selectedChoice?.verification;
    const verificationSummary = verification
        ? `<div class="card details-card"><h3>Verification contract draft</h3><p>${Array.isArray(verification.commands) ? verification.commands.length : 0} command(s) · ${escapeHtml(String(verification.totalTimeoutMs ?? "—"))} ms total</p><p class="muted">Protected: ${escapeHtml((verification.protectedPaths ?? []).filter((value) => typeof value === "string").slice(0, 12).join(", ") || "none")}</p><p class="muted">Test roots: ${escapeHtml((verification.testRoots ?? []).filter((value) => typeof value === "string").slice(0, 12).join(", ") || "none")} · New tests: ${escapeHtml((verification.allowedNewTestRoots ?? []).filter((value) => typeof value === "string").slice(0, 12).join(", ") || "none")}</p></div>`
        : "";
    panel.innerHTML = `<p class="muted">Select a plan choice. Selection is a local draft until approval.</p><div id="choices">${choices.map((choice) => `<button class="plan-choice${choice.id === effectiveSelected ? " selected" : ""}" data-choice="${escapeHtml(choice.id)}"><strong>${escapeHtml(choice.title)}</strong><br /><span>${escapeHtml(choice.body.slice(0, 220))}</span></button>`).join("")}</div><article class="plan-body">${sanitizeMarkdown(selectedChoice?.body ?? "")}</article>${verificationSummary}<div class="actions"><button id="approve-plan" class="primary" ${projection.awaitingPlanApproval ? "" : "disabled"}>Approve</button><button id="revise-plan" class="secondary" ${projection.awaitingPlanApproval ? "" : "disabled"}>Revise</button></div>`;
    let draft = effectiveSelected;
    panel.querySelectorAll("[data-choice]").forEach((button) => button.onclick = () => { draft = button.dataset.choice ?? effectiveSelected; planDraftChoices.set(projection.sessionId, draft); void action(() => bridge.selectPlanChoice(projection.sessionId, draft)); renderPlan({ ...projection, selectedPlanChoiceId: draft }); });
    panel.querySelectorAll("[data-external-url]").forEach((button) => button.onclick = () => { const url = button.dataset.externalUrl; if (url)
        void action(() => bridge.openExternal(url)); });
    el("approve-plan").onclick = () => void action(async () => { const response = await bridge.approvePlan(projection.sessionId, draft); if (response.ok)
        planDraftChoices.delete(projection.sessionId); return response; });
    el("revise-plan").onclick = () => { const message = window.prompt("What should change in the plan?", ""); if (message)
        void action(() => bridge.revisePlan(projection.sessionId, message)); };
}
function renderTimeline(projection) {
    const panel = el("tab-timeline");
    panel.innerHTML = projection?.events?.length ? projection.events.map((event) => `<div class="timeline-item"><time>${escapeHtml(String(event.recordedAt ?? ""))}</time><strong>${escapeHtml(String(event.type ?? "Event"))}</strong><span>${escapeHtml(String(event.summary ?? ""))}</span></div>`).join("") : `<div class="empty">No timeline events.</div>`;
}
function renderNotes(projection) {
    const panel = el("tab-notes");
    if (!projection) {
        panel.innerHTML = `<div class="empty">No operator notes.</div>`;
        return;
    }
    const briefing = projection.interruptBriefing
        ? `<div class="card"><h3>Interrupt briefing</h3><p>${escapeHtml(projection.interruptBriefing)}</p></div>`
        : "";
    const progress = sessionBundle && sessionBundleId === projection.sessionId && sessionBundle.progress
        ? `<div class="card"><h3>Progress notes</h3><pre class="notes">${escapeHtml(sessionBundle.progress)}</pre></div>`
        : "";
    panel.innerHTML = briefing || progress ? `${briefing}${progress}` : `<div class="empty">No operator notes.</div>`;
}
function renderSummary(projection) {
    const panel = el("tab-summary");
    if (!projection || projection.status !== "SUCCESS") {
        panel.innerHTML = `<div class="empty">A final summary is available after successful completion.</div>`;
        return;
    }
    const summary = sessionBundleId === projection.sessionId ? sessionBundle?.summary ?? null : null;
    panel.innerHTML = summary
        ? `<div class="card"><h3>Completed</h3><pre class="notes">${escapeHtml(JSON.stringify(summary, null, 2))}</pre></div>`
        : `<div class="card"><h3>Completed</h3><p>This session completed successfully. Open the session folder for the final summary artifact.</p></div>`;
}
function render() {
    const projection = currentProjection();
    renderSessions();
    renderOverview(projection);
    renderPlan(projection);
    renderTimeline(projection);
    renderNotes(projection);
    renderSummary(projection);
    el("session-title").textContent = projection?.goal ?? "No session selected";
    el("session-subtitle").textContent = projection ? projection.targetProjectPath : "Create a session to begin.";
    const pill = el("status-pill");
    pill.textContent = projection ? statusLabel(projection.status) : "Idle";
    pill.className = `status${projection ? ` ${projection.status.toLowerCase()}` : ""}`;
    document.querySelectorAll(".tabs [data-tab]").forEach((button) => { const active = button.dataset.tab === activeTab; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
    document.querySelectorAll(".tab-panel").forEach((panel) => { panel.hidden = panel.id !== `tab-${activeTab}`; });
    el("log-output").textContent = (selectedSession ? logsBySession.get(selectedSession) : "") || "No live output yet.";
}
async function action(operation) {
    const response = await operation();
    if (!response.ok)
        setNotice(response.error?.message ?? "Operation failed.", "error");
    else {
        setNotice("");
        await loadSnapshot();
    }
}
function showStartupError(status) {
    snapshot = null;
    selectedSession = undefined;
    el("new-session").disabled = true;
    el("settings").disabled = true;
    el("refresh").disabled = true;
    el("session-list").innerHTML = `<div class="empty">The current profile cannot be opened.</div>`;
    el("session-title").textContent = "Profile validation failed";
    el("session-subtitle").textContent = status.error ?? "The packaged core could not load this profile.";
    const pill = el("status-pill");
    pill.textContent = "Invalid profile";
    pill.className = "status failed";
    el("tab-overview").innerHTML = `<div class="card details-card"><h2>Profile validation failed</h2><p>${escapeHtml(status.error ?? "The packaged core could not load this profile.")}</p><p class="muted">Expected current contracts: product 8.0.0, protocol 3/state 2, session index 4, run projection 2/state 5, operator snapshot 3.</p><p class="muted">Config root: <code>${escapeHtml(status.configRoot)}</code><br />Data root: <code>${escapeHtml(status.dataRoot)}</code></p><p class="muted">No files were changed. Review the configuration and data folders, then restart after correcting the reported contract.</p><div class="actions"><button id="open-config-folder" class="secondary">Open config folder</button><button id="open-data-folder" class="secondary">Open data folder</button><button id="quit-invalid-profile" class="danger primary">Quit</button></div></div>`;
    for (const panelId of ["tab-plan", "tab-log", "tab-timeline", "tab-notes", "tab-summary"]) {
        el(panelId).innerHTML = `<div class="empty">Available after profile validation succeeds.</div>`;
    }
    el("open-config-folder").onclick = () => void action(() => bridge.openProfileFolder("config"));
    el("open-data-folder").onclick = () => void action(() => bridge.openProfileFolder("data"));
    el("quit-invalid-profile").onclick = () => void action(() => bridge.requestQuit());
    activeTab = "overview";
}
async function loadSnapshot() {
    const response = await bridge.getSnapshot(selectedSession);
    if (!response.ok) {
        setNotice(response.error.message, "error");
        return;
    }
    const next = response.value;
    snapshot = next;
    selectedSession = next.projection?.sessionId ?? selectedSession;
    if (!next.projection) {
        sessionBundle = null;
        sessionBundleId = undefined;
    }
    else if (sessionBundleId !== next.projection.sessionId || next.projection.status === "SUCCESS") {
        const bundleResponse = await bridge.getSessionBundle(next.projection.sessionId);
        if (bundleResponse.ok) {
            sessionBundle = bundleResponse.value;
            sessionBundleId = next.projection.sessionId;
        }
        else {
            sessionBundle = null;
            sessionBundleId = undefined;
        }
    }
    render();
}
async function bootstrapRenderer() {
    const response = await bridge.getStartupStatus();
    if (!response.ok) {
        setNotice(response.error.message, "error");
        return;
    }
    if (!response.value.ready) {
        showStartupError(response.value);
        return;
    }
    await loadSnapshot();
}
async function openNewSession() { el("session-form").reset(); el("project").value = ""; el("session-dialog").showModal(); }
async function openSettings() {
    const response = await bridge.getSettings();
    if (!response.ok) {
        setNotice(response.error.message, "error");
        return;
    }
    settingsDraft = structuredClone(response.value);
    const container = el("provider-settings");
    const providers = settingsDraft.providers;
    container.innerHTML = Object.entries(providers).map(([id, provider]) => {
        const catalog = provider.modelCatalog && typeof provider.modelCatalog === "object" && !Array.isArray(provider.modelCatalog)
            ? provider.modelCatalog
            : {};
        const configured = catalog.source === "configured" && Array.isArray(catalog.models)
            ? catalog.models.filter((model) => typeof model === "string")
            : [];
        const editable = catalog.source === "configured";
        return `<div class="provider-row"><div><strong>${escapeHtml(String(provider.label ?? id))}</strong><label class="checkbox"><input type="checkbox" data-provider-enabled="${escapeHtml(id)}" ${provider.enabled === false ? "" : "checked"} /> Enabled</label><div class="picker"><input readonly data-provider-binary-input="${escapeHtml(id)}" value="${escapeHtml(String(provider.binary ?? id))}" aria-label="${escapeHtml(String(provider.label ?? id))} executable" /><button type="button" class="secondary" data-provider-binary="${escapeHtml(id)}">Choose…</button></div><label>Configured models (${editable ? "editable" : "discovered by command"})<input ${editable ? "" : "disabled"} data-provider-models="${escapeHtml(id)}" value="${escapeHtml(configured.join(", "))}" /></label></div><span><b data-provider-status="${escapeHtml(id)}">Not discovered</b><small data-provider-model-list="${escapeHtml(id)}"></small></span></div>`;
    }).join("");
    const toolAccess = settingsDraft.toolAccess;
    const webSearch = toolAccess.webSearch ?? {};
    el("web-search-enabled").checked = webSearch.enabled === true;
    el("web-search-mode").value = webSearch.mode === "live" ? "live" : "cached";
    const defaults = settingsDraft.defaults;
    el("phase-timeout").value = String(defaults.phaseTimeoutMs ?? 900000);
    el("transport-timeout").value = String(defaults.transportTimeoutMs ?? 120000);
    el("idle-timeout").value = String(defaults.idleTimeoutMs ?? 300000);
    el("tool-timeout").value = String(defaults.toolTimeoutMs ?? 600000);
    el("max-attempts").value = String(defaults.maxAgentAttempts ?? 3);
    el("retry-backoff").value = Array.isArray(defaults.retryBackoffMs) ? defaults.retryBackoffMs.join(", ") : "5000, 30000";
    el("mcp-json").value = JSON.stringify(toolAccess.mcpServers ?? [], null, 2);
    el("secret-json").value = "";
    container.querySelectorAll("[data-provider-enabled]").forEach((input) => input.addEventListener("change", () => {
        const id = input.dataset.providerEnabled;
        if (!id || !settingsDraft?.providers[id])
            return;
        settingsDraft.providers[id].enabled = input.checked;
    }));
    container.querySelectorAll("[data-provider-binary-input]").forEach((input) => input.addEventListener("change", () => {
        const id = input.dataset.providerBinaryInput;
        if (!id || !settingsDraft?.providers[id])
            return;
        settingsDraft.providers[id].binary = input.value.trim();
    }));
    container.querySelectorAll("[data-provider-models]").forEach((input) => input.addEventListener("change", () => {
        const id = input.dataset.providerModels;
        if (!id || !settingsDraft?.providers[id])
            return;
        const catalog = settingsDraft.providers[id].modelCatalog;
        if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || catalog.source !== "configured")
            return;
        catalog.models = input.value.split(",").map((model) => model.trim()).filter(Boolean);
    }));
    container.querySelectorAll("[data-provider-binary]").forEach((button) => button.addEventListener("click", async () => {
        const id = button.dataset.providerBinary;
        if (!id || !settingsDraft?.providers[id])
            return;
        const chosen = await bridge.chooseProviderBinary();
        if (!chosen.ok) {
            setNotice(chosen.error.message, "error");
            return;
        }
        if (chosen.value) {
            settingsDraft.providers[id].binary = chosen.value;
            const input = container.querySelector(`[data-provider-binary-input="${CSS.escape(id)}"]`);
            if (input)
                input.value = chosen.value;
        }
    }));
    el("settings-dialog").showModal();
}
el("new-session").addEventListener("click", () => void openNewSession());
el("settings").addEventListener("click", () => void openSettings());
el("refresh").addEventListener("click", () => void loadSnapshot());
el("quit").addEventListener("click", () => void action(() => bridge.requestQuit()));
el("pick-project").addEventListener("click", async () => { const response = await bridge.chooseProjectDirectory(); if (response.ok && response.value)
    el("project").value = response.value;
else if (!response.ok)
    setNotice(response.error.message, "error"); });
el("session-form").addEventListener("submit", async (event) => { event.preventDefault(); const response = await bridge.startSession({ goal: el("goal").value, projectPath: el("project").value, accessMode: el("full-access").checked ? "full_access" : "ask" }); if (!response.ok) {
    setNotice(response.error.message, "error");
    return;
} el("session-dialog").close(); selectedSession = response.value.sessionId; await loadSnapshot(); });
el("discover").addEventListener("click", async () => { const response = await bridge.discoverModels(); if (!response.ok) {
    setNotice(response.error.message, "error");
    return;
} for (const provider of response.value.providers) {
    const target = document.querySelector(`[data-provider-status="${CSS.escape(provider.providerId)}"]`);
    if (target) {
        target.textContent = provider.available ? `${provider.models.length} model(s)` : provider.error?.message ?? "Unavailable";
        target.className = provider.available ? "provider-ok" : "provider-bad";
    }
    const models = document.querySelector(`[data-provider-model-list="${CSS.escape(provider.providerId)}"]`);
    if (models)
        models.textContent = provider.available ? (provider.models.slice(0, 20).join(", ") || "No models returned") : "";
} });
el("save-settings").addEventListener("click", async () => {
    if (!settingsDraft)
        return;
    const toolAccess = settingsDraft.toolAccess;
    toolAccess.webSearch = { ...(toolAccess.webSearch ?? {}), enabled: el("web-search-enabled").checked, mode: el("web-search-mode").value };
    const defaults = settingsDraft.defaults;
    for (const [id, value] of [["phaseTimeoutMs", el("phase-timeout").value], ["transportTimeoutMs", el("transport-timeout").value], ["idleTimeoutMs", el("idle-timeout").value], ["toolTimeoutMs", el("tool-timeout").value], ["maxAgentAttempts", el("max-attempts").value]]) {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1) {
            setNotice(`${id} must be a positive integer.`, "error");
            return;
        }
        defaults[id] = number;
    }
    const retryText = el("retry-backoff").value.trim();
    const retryBackoff = retryText ? retryText.split(",").map((value) => Number(value.trim())) : [];
    if (retryBackoff.length === 0 || retryBackoff.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        setNotice("Retry backoff must contain non-negative integers.", "error");
        return;
    }
    defaults.retryBackoffMs = retryBackoff;
    try {
        const parsedMcp = JSON.parse(el("mcp-json").value);
        if (!Array.isArray(parsedMcp))
            throw new Error("MCP configuration must be a JSON array.");
        toolAccess.mcpServers = parsedMcp;
    }
    catch (error) {
        setNotice(error instanceof Error ? error.message : "MCP configuration is not valid JSON.", "error");
        return;
    }
    let secrets;
    const secretText = el("secret-json").value.trim();
    if (secretText) {
        try {
            const parsed = JSON.parse(secretText);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("Secret values must be a JSON object.");
            secrets = {};
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value !== "string")
                    throw new Error(`Secret ${key} must be a string.`);
                secrets[key] = value;
            }
        }
        catch (error) {
            setNotice(error instanceof Error ? error.message : "Secret values are not valid JSON.", "error");
            return;
        }
    }
    const response = await bridge.saveSettings(settingsDraft, secrets);
    if (!response.ok) {
        setNotice(response.error.message, "error");
        return;
    }
    settingsDraft = response.value;
    el("secret-json").value = "";
    el("settings-dialog").close();
    setNotice("Settings saved.");
    await loadSnapshot();
});
document.querySelectorAll(".tabs [data-tab]").forEach((button) => button.addEventListener("click", () => { activeTab = button.dataset.tab ?? "overview"; render(); }));
bridge.onStateInvalidated((next) => {
    // A concurrent session may invalidate state while the operator is viewing
    // another one. Keep the shared index fresh without unexpectedly changing
    // the selected projection; a matching event updates the visible session.
    if (selectedSession && snapshot && next.projection?.sessionId !== selectedSession && next.sessionIndex.sessionMetas.some((meta) => meta.sessionId === selectedSession)) {
        snapshot = { ...snapshot, capturedAt: next.capturedAt, sessionIndex: next.sessionIndex, settings: next.settings, providerDiscovery: next.providerDiscovery };
        render();
        return;
    }
    snapshot = next;
    selectedSession = next.projection?.sessionId ?? selectedSession;
    render();
});
bridge.onLog((event) => {
    let logText = logsBySession.get(event.sessionId) ?? "";
    logText += `[${event.stream}] ${event.text}`;
    if (logText.length > 512 * 1024)
        logText = logText.slice(-512 * 1024);
    logsBySession.set(event.sessionId, logText);
    if (selectedSession === event.sessionId)
        render();
});
bridge.onNotification((event) => setNotice(event.message, event.level));
void bootstrapRenderer();

})();

/******/ })()
;
//# sourceMappingURL=index.js.map