import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopSettings, DesktopSnapshot, BridgeResult } from "./shared";

function invoke<T>(channel: string, payload?: unknown): Promise<BridgeResult<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<BridgeResult<T>>;
}

const bridge: DesktopBridge = {
  getStartupStatus: () => invoke("desktop:getStartupStatus"),
  openProfileFolder: (kind) => invoke("desktop:openProfileFolder", { kind }),
  getSnapshot: (sessionId) => invoke("desktop:getSnapshot", { sessionId }),
  getSessionBundle: (sessionId) => invoke("desktop:getSessionBundle", { sessionId }),
  getSettings: () => invoke<DesktopSettings>("desktop:getSettings"),
  chooseProjectDirectory: () => invoke("desktop:chooseProjectDirectory"),
  chooseProviderBinary: () => invoke("desktop:chooseProviderBinary"),
  startSession: (input) => invoke("desktop:startSession", input),
  resumeSession: (sessionId) => invoke("desktop:resumeSession", { sessionId }),
  stopSession: (sessionId) => invoke("desktop:stopSession", { sessionId }),
  interruptSession: (sessionId, message) => invoke("desktop:interruptSession", { sessionId, message }),
  deleteSession: (sessionId) => invoke("desktop:deleteSession", { sessionId }),
  resolveAccessRequest: (sessionId, approved) => invoke("desktop:resolveAccessRequest", { sessionId, approved }),
  setAccessMode: (sessionId, mode) => invoke("desktop:setAccessMode", { sessionId, mode }),
  selectPlanChoice: (sessionId, choiceId) => invoke("desktop:selectPlanChoice", { sessionId, choiceId }),
  approvePlan: (sessionId, choiceId) => invoke("desktop:approvePlan", { sessionId, choiceId }),
  revisePlan: (sessionId, message) => invoke("desktop:revisePlan", { sessionId, message }),
  approveVerification: (sessionId, requestId, candidateHash) => invoke("desktop:approveVerification", { sessionId, requestId, candidateHash }),
  rejectVerification: (sessionId, requestId, candidateHash, message) => invoke("desktop:rejectVerification", { sessionId, requestId, candidateHash, message }),
  saveSettings: (settings, secrets) => invoke<DesktopSettings>("desktop:saveSettings", { settings, secrets }),
  discoverModels: () => invoke("desktop:discoverModels"),
  revealSessionFolder: (sessionId) => invoke("desktop:revealSessionFolder", { sessionId }),
  requestQuit: () => invoke("desktop:requestQuit"),
  openExternal: (url) => invoke("desktop:openExternal", { url }),
  onStateInvalidated: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot) => listener(snapshot);
    ipcRenderer.on("desktop:state-invalidated", callback);
    return () => ipcRenderer.removeListener("desktop:state-invalidated", callback);
  },
  onLog: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, value: { sessionId: string; stream: "stdout" | "stderr"; text: string }) => listener(value);
    ipcRenderer.on("desktop:log", callback);
    return () => ipcRenderer.removeListener("desktop:log", callback);
  },
  onNotification: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, value: { level: "info" | "warning" | "error"; message: string }) => listener(value);
    ipcRenderer.on("desktop:notification", callback);
    return () => ipcRenderer.removeListener("desktop:notification", callback);
  },
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);
