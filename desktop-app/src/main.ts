import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { DesktopController } from "./controller";
import { PRODUCT_FOLDER, resolveDesktopRoots } from "./paths";
import type { DesktopSettings, DesktopSnapshot, BridgeResult } from "./shared";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: DesktopController | null = null;
let quitting = false;
let trayNoticeShown = false;
let detachState: (() => void) | null = null;
let detachLog: (() => void) | null = null;
let detachNotification: (() => void) | null = null;

const TRAY_ICON_DATA = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMyIDMyIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI3IiBmaWxsPSIjNGY4Y2ZmIi8+PHBhdGggZD0iTTggMTBoMTZ2M0g4em0wIDVoMTZ2M0g4em0wIDVoMTB2M0g4eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string | undefined;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string | undefined;

function dialogParent(): Electron.BaseWindow {
  if (!mainWindow) throw new Error("The desktop window is not ready.");
  return mainWindow;
}

function result<T>(value: T): BridgeResult<T> { return { ok: true, value }; }
function failure<T>(error: unknown): BridgeResult<T> {
  return { ok: false, error: { code: "request-failed", message: error instanceof Error ? error.message : String(error) } };
}

function assertRenderer(event: Electron.IpcMainInvokeEvent, payload: unknown, maxBytes = 1_024 * 1_024): void {
  const url = event.senderFrame?.url ?? "";
  let trusted = false;
  try {
    const parsed = new URL(url);
    trusted = (parsed.protocol === "file:" && (parsed.hostname === "" || parsed.hostname === "localhost"))
      || (parsed.protocol === "http:" && parsed.hostname === "localhost");
  } catch {
    trusted = false;
  }
  if (!trusted) throw new Error("Renderer origin is not trusted.");
  if (payload !== undefined && Buffer.byteLength(JSON.stringify(payload), "utf8") > maxBytes) throw new Error("IPC payload is too large.");
}

function payloadObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("IPC payload must be an object.");
  return payload as Record<string, unknown>;
}

function assertPayloadKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(payload)) if (!fields.has(key)) throw new Error(`IPC payload contains unsupported field '${key}'.`);
}

function assertNoPayload(payload: unknown): void {
  if (payload !== undefined) throw new Error("This IPC operation does not accept a payload.");
}

function stringField(payload: Record<string, unknown>, field: string): string {
  if (typeof payload[field] !== "string" || !payload[field]) throw new Error(`${field} is required.`);
  return payload[field] as string;
}

function optionalStringField(payload: Record<string, unknown>, field: string): string | undefined {
  if (payload[field] === undefined) return undefined;
  if (typeof payload[field] !== "string" || !payload[field]) throw new Error(`${field} must be a non-empty string when provided.`);
  return payload[field] as string;
}

function getController(): DesktopController {
  if (!controller) throw new Error("Desktop controller is not initialized.");
  return controller;
}

function registerIpc(): void {
  const handle = <T>(channel: string, callback: (payload: unknown) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (event, payload) => {
      try { assertRenderer(event, payload); return result(await callback(payload)); }
      catch (error) { return failure<T>(error); }
    });
  };
  handle("desktop:getStartupStatus", (raw) => { assertNoPayload(raw); return getController().getStartupStatus(); });
  handle("desktop:runMaintenance", async (raw) => {
    const payload = payloadObject(raw);
    assertPayloadKeys(payload, ["dryRun"]);
    if (typeof payload.dryRun !== "boolean") throw new Error("dryRun must be a boolean.");
    if (!payload.dryRun) {
      const confirmation = await dialog.showMessageBox(dialogParent(), {
        type: "warning",
        buttons: ["Reset sessions", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        title: "Reset Agent Loop profile",
        message: "Reset registered sessions and install the packaged definitions?",
        detail: "Project source files, working-tree changes, settings, and secure credentials are preserved. The desktop app must be restarted afterward.",
      });
      if (confirmation.response !== 0) throw new Error("Profile maintenance was cancelled.");
    }
    return getController().runMaintenance(payload.dryRun === true);
  });
  handle<DesktopSnapshot>("desktop:getSnapshot", async (raw) => {
    if (raw === undefined) return getController().getSnapshot();
    const payload = payloadObject(raw);
    assertPayloadKeys(payload, ["sessionId"]);
    return getController().getSnapshot(optionalStringField(payload, "sessionId"));
  });
  handle("desktop:getSessionBundle", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId"]); return getController().getSessionBundle(stringField(payload, "sessionId")); });
  handle<DesktopSettings>("desktop:getSettings", (raw) => { assertNoPayload(raw); return getController().getSettings(); });
  handle<string | null>("desktop:chooseProjectDirectory", async (raw) => {
    assertNoPayload(raw);
    const chosen = await dialog.showOpenDialog(dialogParent(), { properties: ["openDirectory", "createDirectory"] });
    return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
  });
  handle<string | null>("desktop:chooseProviderBinary", async (raw) => {
    assertNoPayload(raw);
    const chosen = await dialog.showOpenDialog(dialogParent(), { properties: ["openFile"], filters: [{ name: "Executables", extensions: ["exe", "cmd", "bat", "com"] }] });
    return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
  });
  handle("desktop:startSession", (raw) => {
    const payload = payloadObject(raw);
    assertPayloadKeys(payload, ["goal", "projectPath", "accessMode", "sessionId"]);
    if (payload.accessMode !== undefined && payload.accessMode !== "ask" && payload.accessMode !== "full_access") throw new Error("accessMode must be ask or full_access.");
    const accessMode = payload.accessMode === "full_access" ? "full_access" : "ask";
    if (accessMode === "full_access") {
      return dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Enable Full Access", "Cancel"], defaultId: 1, cancelId: 1, title: "Enable Full Access", message: "Allow the provider to modify the selected project?" }).then((confirmation) => {
        if (confirmation.response !== 0) throw new Error("Full Access was not enabled.");
      return getController().startSession({ goal: stringField(payload, "goal"), projectPath: stringField(payload, "projectPath"), accessMode, sessionId: optionalStringField(payload, "sessionId") });
      });
    }
    return getController().startSession({
      goal: stringField(payload, "goal"),
      projectPath: stringField(payload, "projectPath"),
      accessMode,
      sessionId: optionalStringField(payload, "sessionId"),
    });
  });
  handle("desktop:resumeSession", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId"]); return getController().resumeSession(stringField(payload, "sessionId")); });
  handle("desktop:stopSession", async (raw) => {
    const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId"]);
    const sessionId = stringField(payload, "sessionId");
    const confirmation = await dialog.showMessageBox(dialogParent(), {
      type: "warning",
      buttons: ["Stop session", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Stop session",
      message: "Stop this active session?",
      detail: "The session can be resumed later if its provider and state remain available.",
    });
    if (confirmation.response !== 0) throw new Error("Stop cancelled.");
    return getController().stopSession(sessionId);
  });
  handle("desktop:interruptSession", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "message"]); return getController().interruptSession(stringField(payload, "sessionId"), stringField(payload, "message")); });
  handle("desktop:deleteSession", async (raw) => {
    const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId"]);
    const id = stringField(payload, "sessionId");
    const confirmation = await dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Delete", "Cancel"], defaultId: 1, cancelId: 1, title: "Delete session", message: "Delete this session and its logs?", detail: "Session data is removed after a recoverable tombstone rename." });
    if (confirmation.response !== 0) throw new Error("Deletion cancelled.");
    return getController().deleteSession(id);
  });
  handle("desktop:resolveAccessRequest", async (raw) => {
    const payload = payloadObject(raw);
    assertPayloadKeys(payload, ["sessionId", "approved"]);
    if (typeof payload.approved !== "boolean") throw new Error("approved must be a boolean.");
    const approved = payload.approved === true;
    if (approved) {
      const confirmation = await dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Allow", "Cancel"], defaultId: 1, cancelId: 1, title: "Provider access request", message: "Allow this provider attempt to access the project?" });
      if (confirmation.response !== 0) return getController().resolveAccessRequest(stringField(payload, "sessionId"), false);
    }
    return getController().resolveAccessRequest(stringField(payload, "sessionId"), approved);
  });
  handle("desktop:setAccessMode", async (raw) => {
    const payload = payloadObject(raw);
    assertPayloadKeys(payload, ["sessionId", "mode"]);
    if (payload.mode !== "ask" && payload.mode !== "full_access") throw new Error("mode must be ask or full_access.");
    const mode = payload.mode === "full_access" ? "full_access" : "ask";
    if (mode === "full_access") {
      const confirmation = await dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Enable Full Access", "Cancel"], defaultId: 1, cancelId: 1, title: "Enable Full Access", message: "Allow the provider to modify the selected project?" });
      if (confirmation.response !== 0) throw new Error("Full Access was not enabled.");
    }
    return getController().setAccessMode(stringField(payload, "sessionId"), mode);
  });
  handle("desktop:selectPlanChoice", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "choiceId"]); return getController().selectPlanChoice(stringField(payload, "sessionId"), stringField(payload, "choiceId")); });
  handle("desktop:approvePlan", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "choiceId"]); return getController().approvePlan(stringField(payload, "sessionId"), optionalStringField(payload, "choiceId")); });
  handle("desktop:revisePlan", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "message"]); return getController().revisePlan(stringField(payload, "sessionId"), stringField(payload, "message")); });
  handle("desktop:approveVerification", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "requestId", "candidateHash"]); return getController().approveVerification(stringField(payload, "sessionId"), stringField(payload, "requestId"), stringField(payload, "candidateHash")); });
  handle("desktop:rejectVerification", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "requestId", "candidateHash", "message"]); return getController().rejectVerification(stringField(payload, "sessionId"), stringField(payload, "requestId"), stringField(payload, "candidateHash"), stringField(payload, "message")); });
  handle<DesktopSettings>("desktop:saveSettings", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["settings", "secrets"]); return getController().saveSettings(payload.settings as DesktopSettings, payload.secrets as Record<string, string> | undefined); });
  handle("desktop:discoverModels", (raw) => { assertNoPayload(raw); return getController().discoverModels(); });
  handle<void>("desktop:revealSessionFolder", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId"]); return getController().revealSessionFolder(stringField(payload, "sessionId")); });
  handle("desktop:openExternal", async (raw) => {
    const payload = payloadObject(raw); assertPayloadKeys(payload, ["url"]);
    const url = stringField(payload, "url");
    if (!/^https?:\/\//iu.test(url)) throw new Error("Only HTTP(S) links can be opened.");
    const confirmation = await dialog.showMessageBox(dialogParent(), { type: "question", buttons: ["Open", "Cancel"], defaultId: 1, cancelId: 1, title: "Open external link", message: url });
    if (confirmation.response !== 0) throw new Error("Opening the link was cancelled.");
    await shell.openExternal(url);
  });
  handle("desktop:requestQuit", async (raw) => {
    assertNoPayload(raw);
    const confirmation = await dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Stop & Quit", "Cancel"], defaultId: 1, cancelId: 1, title: "Quit Agent Loop Orchestrator", message: "Stop all active sessions and quit?" });
    if (confirmation.response !== 0) throw new Error("Quit cancelled.");
    const released = await getController().release();
    if (released.failures.length > 0) throw new Error(`Quit cancelled: ${released.failures.map((entry) => `${entry.resource}${entry.resourceId ? `(${entry.resourceId})` : ""}: ${entry.message}`).join("; ")}`);
    quitting = true;
    app.quit();
    return released;
  });
}

function refreshTray(): void {
  if (!tray || !controller) return;
  void controller.getSnapshot().then((snapshot) => {
    const active = snapshot.sessionIndex.activeSessionIds.length;
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: "Open", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: `${active} active session${active === 1 ? "" : "s"}`, enabled: false },
      { type: "separator" },
      { label: "Quit", click: () => { void mainWindow?.webContents.executeJavaScript("window.desktopBridge.requestQuit()", true); } },
    ]));
  }).catch((error) => {
    console.error(`[desktop-tray] ${error instanceof Error ? error.message : String(error)}`);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: typeof MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY === "string"
        ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
        : path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const rendererEntry = typeof MAIN_WINDOW_WEBPACK_ENTRY === "string" ? MAIN_WINDOW_WEBPACK_ENTRY : null;
  const load = rendererEntry ? mainWindow.loadURL(rendererEntry) : mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  load.catch((error) => dialog.showErrorBox("Agent Loop Orchestrator", String(error)));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
    if (!trayNoticeShown) {
      trayNoticeShown = true;
      void dialog.showMessageBox({ type: "info", buttons: ["OK"], title: "Agent Loop Orchestrator", message: "The window was hidden to the system tray. Active sessions continue running." });
    }
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The renderer never needs arbitrary browser permissions or file downloads.
  // Keep these denied even if a future dependency attempts to request them.
  const webSession = mainWindow.webContents.session;
  webSession.setPermissionCheckHandler(() => false);
  webSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  webSession.on("will-download", (event) => event.preventDefault());
  // Windows sends these window lifecycle events for shutdown/logoff, where
  // app.before-quit is intentionally skipped. Pause the shutdown long enough
  // for a best-effort control request; lease/fencing recovery handles crashes.
  mainWindow.on("query-session-end", () => {
    if (quitting || !controller) return;
    // Do not prevent the Windows shutdown/logoff from completing. Mark the
    // process as quitting immediately so before-quit cannot turn this best-
    // effort cleanup into a second blocking confirmation. Any remaining
    // lease/process is reconciled by fencing recovery on the next start.
    quitting = true;
    void controller.release().then((released) => {
      if (released.failures.length > 0) {
        console.error(`[desktop-session-end] ${released.failures.length} resource(s) could not be released before Windows ended the session.`);
      }
    }).catch((error) => {
      console.error(`[desktop-session-end] release failed during Windows shutdown/logoff: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  mainWindow.on("session-end", () => {
    if (!quitting && controller) void controller.release().catch((error) => {
      console.error(`[desktop-session-end] ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

export async function initDesktopApplication(): Promise<void> {
  // Electron's default user-data directory is the generic `Electron` folder;
  // isolate this app so another Electron product cannot steal our instance
  // lock or profile during development and packaged execution.
  const configuredAppData = !app.isPackaged && process.env.AGENT_LOOP_APP_DATA_ROOT
    ? path.resolve(process.env.AGENT_LOOP_APP_DATA_ROOT)
    : app.getPath("appData");
  app.setPath("userData", path.join(configuredAppData, PRODUCT_FOLDER, "user-data"));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => { mainWindow?.show(); mainWindow?.focus(); });
  await app.whenReady();
  const localAppData = !app.isPackaged && process.env.AGENT_LOOP_LOCAL_DATA_ROOT
    ? path.resolve(process.env.AGENT_LOOP_LOCAL_DATA_ROOT)
    : process.env.LOCALAPPDATA ?? app.getPath("appData");
  const developmentAppRoot = !app.isPackaged && process.env.AGENT_LOOP_APP_ROOT
    ? process.env.AGENT_LOOP_APP_ROOT
    : app.getAppPath();
  const roots = resolveDesktopRoots(developmentAppRoot, configuredAppData, localAppData);
  controller = new DesktopController(roots);
  let initializationError: Error | null = null;
  try {
    await controller.init();
  } catch (error) {
    // Keep the operator console available when the profile has an old
    // manifest or an interrupted maintenance journal. The maintenance IPC
    // is deliberately registered below even though normal session APIs stay
    // fenced behind the controller's failed lifecycle.
    initializationError = error instanceof Error ? error : new Error(String(error));
  }
  registerIpc();
  createWindow();
  // Register shutdown handling before the failed-initialization early return
  // so the maintenance screen can still be closed cleanly. The controller's
  // failed lifecycle makes release a no-op while a version transition is
  // waiting for operator repair.
  app.on("before-quit", (event) => {
    if (quitting || !controller) return;
    event.preventDefault();
    void controller.release().then((released) => {
      if (released.failures.length > 0) {
        const details = released.failures.map((entry) => `${entry.resource}${entry.resourceId ? `(${entry.resourceId})` : ""}: ${entry.message}`).join("; ");
        dialog.showErrorBox("Quit cancelled", `Some resources could not be released. Repair them and try again.\n\n${details}`);
        return;
      }
      quitting = true;
      app.quit();
    }).catch((error) => {
      dialog.showErrorBox("Quit cancelled", error instanceof Error ? error.message : String(error));
    });
  });
  app.on("window-all-closed", () => undefined);
  if (initializationError) {
    // Renderer bootstrap reads getStartupStatus and presents the repair
    // controls. No session listeners or tray are attached because the core
    // has not passed its version/manifest checks.
    return;
  }
  detachState = controller.on("state", (snapshot) => { mainWindow?.webContents.send("desktop:state-invalidated", snapshot); refreshTray(); });
  detachLog = controller.on("log", (event) => mainWindow?.webContents.send("desktop:log", event));
  detachNotification = controller.on("notification", (event) => mainWindow?.webContents.send("desktop:notification", event));
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA));
  tray.setToolTip("Agent Loop Orchestrator");
  tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
  refreshTray();
  // Recover stale sessions only after the bridge listeners and window exist so
  // provider-missing/recovery notifications are visible to the operator.
  void controller.recoverPersistedSessions();
}

function handleSquirrelStartupEvent(): boolean {
  if (process.platform !== "win32") return false;
  const event = process.argv.find((argument) => argument.startsWith("--squirrel-"));
  if (!event) return false;
  // Squirrel invokes the executable for install/update/uninstall lifecycle
  // events. Handle them before creating windows, tray state, or core roots.
  // Creating/removing the shortcut here keeps Setup.exe useful even though
  // the app does not depend on electron-squirrel-startup at runtime.
  const updateExe = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  const executableName = path.basename(process.execPath);
  const runUpdate = (args: string[]): void => {
    if (!fs.existsSync(updateExe)) return;
    try {
      const child = spawn(updateExe, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    } catch {
      // Setup remains installed; a missing shortcut is preferable to
      // starting the operator console during a Squirrel lifecycle callback.
    }
  };
  if (event === "--squirrel-install" || event === "--squirrel-updated") {
    runUpdate(["--createShortcut", executableName]);
  } else if (event === "--squirrel-uninstall") {
    runUpdate(["--removeShortcut", executableName]);
  }
  // Give the detached Update.exe a moment to create/remove shortcuts before
  // the lifecycle process exits. No app bootstrap or secure-root access runs.
  setTimeout(() => app.quit(), 1_000);
  return true;
}

if (!handleSquirrelStartupEvent()) void initDesktopApplication().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[desktop-bootstrap] ${message}`);
  if (process.env.AGENT_LOOP_E2E === "1") { app.exit(1); return; }
  dialog.showErrorBox("Agent Loop Orchestrator failed to start", message);
  app.quit();
});

process.once("exit", () => { detachState?.(); detachLog?.(); detachNotification?.(); tray?.destroy(); });
