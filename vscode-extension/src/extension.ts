import * as vscode from "vscode";
import { readExtensionConfig, SessionMeta, ExtensionConfig } from "./types";
import { StateStore, setGlobalContext } from "./stateStore";
import { LoopClient } from "./loopClient";
import { LoopWebviewPanel } from "./webviewPanel";
import { PlanReviewViewProvider } from "./planReviewView";
import { decideRecoveryAction } from "./resilience";
import { activationSideEffectsAllowed } from "./workspaceExecutionPolicy";
import {
  assertPathOutsideBases,
  resolveConfiguredDataRoot,
  runWithIsolatedDataRoot,
} from "./pathSafety";

let store: StateStore | undefined;
let client: LoopClient | undefined;
let config: ExtensionConfig;
let globalContext: vscode.ExtensionContext | undefined;
let planReviewView: PlanReviewViewProvider | undefined;
let recoveryMonitorTimer: NodeJS.Timeout | null = null;
let recoveryPassPromise: Promise<void> | null = null;
let recoveryPassPending = false;
let recoveryMonitorEnabled = false;

function requireTrustedWorkspace(action: string): boolean {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage(
    `Agent Loop cannot ${action} until this workspace is trusted.`
  );
  return false;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationAllowed = activationSideEffectsAllowed(vscode.workspace.isTrusted);
  if (!activationAllowed) {
    console.warn("[agentLoop] Activation side effects are disabled for an untrusted workspace.");
    return;
  }
  setGlobalContext(context);
  globalContext = context;

  config = readExtensionConfig();
  store = new StateStore(config);
  client = new LoopClient(config, store);

  const protectedWorkspaceRoots = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const assertSafeDataRoot = async (): Promise<string> => {
    const root = await store!.getRootDir();
    try {
      return await assertPathOutsideBases(
        root,
        protectedWorkspaceRoots(),
        "Agent Loop data root"
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${reason} Clear "agentLoop.rootDir" to use VS Code global storage.`);
    }
  };
  const ensureSafeInitialized = async (): Promise<void> => {
    const root = await store!.getRootDir();
    await runWithIsolatedDataRoot(root, protectedWorkspaceRoots(), async () => {
      await store!.ensureInitialized();
    });
  };

  const sessionExplorerProvider = new SessionExplorerProvider(store);

  const updateNoSessionsContext = async () => {
    try {
      await assertSafeDataRoot();
      const registry = await store!.readRegistry();
      const noSessions = !registry.sessionMetas || registry.sessionMetas.length === 0;
      await vscode.commands.executeCommand("setContext", "agentLoop.noSessions", noSessions);
    } catch (err) {
      console.error("[agentLoop] Failed to update noSessions context:", err);
    }
  };
  store.onChange(() => {
    updateNoSessionsContext().catch(() => {});
  });

  try {
    await ensureSafeInitialized();
    store.startPolling(config.pollIntervalMs);
    startRecoveryMonitor(store, client, config.heartbeatIntervalMs);
    await scheduleRecoveryPass(store, client);
    const autoOpenedFlag = "agentLoop.panelAutoOpened";
    const alreadyOpened = context.globalState.get<boolean>(autoOpenedFlag, false);
    if (!alreadyOpened) {
      const registry = await store.readRegistry();
      if (registry.sessionMetas.length === 0) {
        const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
        panel.show();
      }
      await context.globalState.update(autoOpenedFlag, true);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[agentLoop] Initialization was blocked:", err);
    void vscode.window.showErrorMessage(`Agent Loop initialization blocked: ${reason}`);
  }
  updateNoSessionsContext().catch(() => {});

  context.subscriptions.push(
    vscode.commands.registerCommand("agentLoop.showPanel", async (sessionId?: string) => {
      if (!requireTrustedWorkspace("open the control panel")) return;
      await ensureSafeInitialized();
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.show();
      if (sessionId) {
        panel.selectSession(sessionId);
        planReviewView?.selectSession(sessionId);
      }
    }),

    vscode.commands.registerCommand("agentLoop.newSession", async () => {
      if (!requireTrustedWorkspace("start a new session")) return;
      await ensureSafeInitialized();
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.postFocusComposer();
    }),

    vscode.commands.registerCommand("agentLoop.resumeSession", async () => {
      if (!requireTrustedWorkspace("resume a session")) return;
      await ensureSafeInitialized();
      const registry = await store!.readRegistry();
      if (registry.sessionMetas.length === 0) {
        vscode.window.showInformationMessage("Agent Loop: No sessions found to resume.");
        return;
      }
      const items = registry.sessionMetas.map((m: SessionMeta) => ({
        label: m.sessionId,
        description: m.status,
        detail: m.goal,
        sessionId: m.sessionId,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a session to resume",
        ignoreFocusOut: true,
      });
      if (!picked) return;
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.show();
      panel.postResumeSession(picked.sessionId);
    }),

    vscode.commands.registerCommand("agentLoop.discoverModels", async () => {
      if (!requireTrustedWorkspace("discover models")) return;
      await ensureSafeInitialized();
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.show();
      panel.postDiscoverModels();
    }),

    vscode.commands.registerCommand("agentLoop.stopSession", async () => {
      if (!requireTrustedWorkspace("stop a session")) return;
      await ensureSafeInitialized();
      const registry = await store!.readRegistry();
      const runningMetaIds = registry.sessionMetas
        .filter((m) => m.status === "RUNNING" || m.status === "RECOVERING")
        .map((m) => m.sessionId);
      const candidateIds = [...new Set([...client!.getActiveSessionIds(), ...runningMetaIds])];
      if (candidateIds.length === 0) {
        vscode.window.showInformationMessage("Agent Loop: No active or recovering sessions to stop.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        candidateIds.map((sid) => ({ label: sid, sessionId: sid })),
        { placeHolder: "Select an active session to stop", ignoreFocusOut: true }
      );
      if (!picked) return;
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      const stopped = await panel.requestStopSession(picked.sessionId);
      if (stopped) {
        vscode.window.showInformationMessage(`Agent Loop: Session ${picked.sessionId} stopped.`);
      } else {
        vscode.window.showWarningMessage(
          `Agent Loop: Session ${picked.sessionId} could not be verified as stopped.`
        );
      }
    }),

    vscode.commands.registerCommand("agentLoop.deleteSession", async (arg?: { sessionId?: string }) => {
      if (!requireTrustedWorkspace("delete a session")) return;
      await ensureSafeInitialized();
      const targetId = arg?.sessionId;
      const registry = await store!.readRegistry();
      let sessionId: string | undefined = targetId;
      if (!sessionId) {
        if (registry.sessionMetas.length === 0) {
          vscode.window.showInformationMessage("Agent Loop: No sessions to delete.");
          return;
        }
        const items = registry.sessionMetas.map((m: SessionMeta) => ({
          label: m.sessionId,
          description: m.status,
          detail: m.goal,
          sessionId: m.sessionId,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: "Select a session to delete",
          ignoreFocusOut: true,
        });
        if (!picked) return;
        sessionId = picked.sessionId;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete session "${sessionId}"? This removes all loop state, history, and progress notes. This cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") return;
      const preparation = await client!.prepareSessionDeletion(sessionId);
      if (!preparation.safe) {
        vscode.window.showWarningMessage(
          `Agent Loop: Session cannot be deleted safely yet. ${preparation.reason}`
        );
        return;
      }
      const result = await store!.deleteSession(sessionId);
      if (result.error) {
        vscode.window.showWarningMessage(`Agent Loop: Partial delete — ${result.error}`);
      } else if (result.removedFromRegistry && result.dirRemoved) {
        vscode.window.showInformationMessage(`Agent Loop: Session "${sessionId}" deleted.`);
      } else if (result.removedFromRegistry) {
        vscode.window.showInformationMessage(`Agent Loop: Session "${sessionId}" removed from registry.`);
      } else {
        vscode.window.showInformationMessage(`Agent Loop: Session "${sessionId}" was not found.`);
      }
      sessionExplorerProvider.refresh();
    }),

    vscode.commands.registerCommand(
      "agentLoop.openProgressNotes",
      async (arg?: SessionNode | { sessionId?: string }) => {
        if (!requireTrustedWorkspace("open progress notes")) return;
        const sessionId = arg?.sessionId;
        if (!sessionId) return;
        const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
        await panel.openProgressNotes(sessionId);
      }
    ),

    vscode.commands.registerCommand("agentLoop.refresh", async () => {
      sessionExplorerProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("agentLoop")) {
        const freshConfig = readExtensionConfig();
        try {
          const candidateRoot = freshConfig.rootDir
            ? resolveConfiguredDataRoot(freshConfig.rootDir)
            : context.globalStorageUri.fsPath;
          await assertPathOutsideBases(
            candidateRoot,
            protectedWorkspaceRoots(),
            "Agent Loop data root"
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Agent Loop configuration rejected: ${reason} Clear "agentLoop.rootDir" to use VS Code global storage.`
          );
          return;
        }
        stopRecoveryMonitor();
        store?.stopPolling();
        config = freshConfig;
        store?.updateConfig(freshConfig);
        client?.updateConfig(freshConfig);
        if (store && client && vscode.workspace.isTrusted) {
          try {
            await ensureSafeInitialized();
            store.startPolling(freshConfig.pollIntervalMs);
            startRecoveryMonitor(store, client, freshConfig.heartbeatIntervalMs);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Agent Loop configuration could not be initialized: ${reason}`);
            return;
          }
        } else {
          stopRecoveryMonitor();
        }
        try {
          globalContext?.globalState.update("agentLoop.detectedRoot", undefined).then(() => {}, () => {});
        } catch {
          // ignore
        }
        sessionExplorerProvider.refresh();
        vscode.window.showInformationMessage(
          `Agent Loop: Configuration updated (cliProfile=${freshConfig.cliProfile}, cliBinary=${freshConfig.cliBinary}).`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentLoopExplorer", sessionExplorerProvider)
  );

  planReviewView = new PlanReviewViewProvider(context, store!, client!);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agentLoopPlanReview", planReviewView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push({
    dispose: () => {
      store?.stopPolling();
    },
  });
}

export async function deactivate(): Promise<void> {
  stopRecoveryMonitor();
  client?.setRecoveryWakeup(null);
  await recoveryPassPromise?.catch(() => {});
  if (client) {
    await client.gracefullyStopAll();
  }
  store?.stopPolling();
  client?.dispose();
}

async function recoverAbnormalSessions(
  stateStore: StateStore,
  loopClient: LoopClient
): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const registry = await stateStore.readRegistry();
  for (const meta of registry.sessionMetas) {
    try {
      const state = await stateStore.readState(meta.sessionId);
      if (!state || (state.status !== "RUNNING" && state.status !== "RECOVERING")) continue;
      const runtime = await stateStore.inspectLease(meta.sessionId);
      const action = decideRecoveryAction(
        state.status,
        state.stateVersion,
        runtime.disposition,
        loopClient.isRunning(meta.sessionId),
        state.automaticRecovery?.resumeAt ?? null
      );
      if (action === "recover") {
        loopClient.stopFollowingExternalSession(meta.sessionId);
        await loopClient.resumeSession(meta.sessionId, true);
      } else if (action === "pause_legacy") {
        await stateStore.pauseLegacyRunningSession(meta.sessionId);
      } else if (action === "follow") {
        loopClient.followExternalSession(meta.sessionId);
      }
    } catch (err) {
      console.error(`[agentLoop] Failed to evaluate recovery for ${meta.sessionId}:`, err);
    }
  }
}

function scheduleRecoveryPass(
  stateStore: StateStore,
  loopClient: LoopClient
): Promise<void> {
  if (!vscode.workspace.isTrusted) return Promise.resolve();
  recoveryPassPending = true;
  if (!recoveryPassPromise) {
    recoveryPassPromise = (async () => {
      while (recoveryPassPending) {
        recoveryPassPending = false;
        await recoverAbnormalSessions(stateStore, loopClient);
      }
    })().finally(() => {
      recoveryPassPromise = null;
      if (recoveryMonitorEnabled && recoveryPassPending) {
        void scheduleRecoveryPass(stateStore, loopClient).catch((err) => {
          console.error("[agentLoop] Recovery monitor failed:", err);
        });
      }
    });
  }
  return recoveryPassPromise;
}

function startRecoveryMonitor(
  stateStore: StateStore,
  loopClient: LoopClient,
  heartbeatIntervalMs: number
): void {
  stopRecoveryMonitor();
  if (!vscode.workspace.isTrusted) return;
  recoveryMonitorEnabled = true;
  const intervalMs = Math.max(1_000, Math.min(5_000, heartbeatIntervalMs));
  const wakeup = () => {
    void scheduleRecoveryPass(stateStore, loopClient).catch((err) => {
      console.error("[agentLoop] Recovery monitor failed:", err);
    });
  };
  loopClient.setRecoveryWakeup(wakeup);
  recoveryMonitorTimer = setInterval(wakeup, intervalMs);
}

function stopRecoveryMonitor(): void {
  recoveryMonitorEnabled = false;
  recoveryPassPending = false;
  if (recoveryMonitorTimer) {
    clearInterval(recoveryMonitorTimer);
    recoveryMonitorTimer = null;
  }
  client?.setRecoveryWakeup(null);
}

class SessionExplorerProvider implements vscode.TreeDataProvider<SessionNode> {
  private readonly emitter = new vscode.EventEmitter<SessionNode | undefined | null>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: StateStore
  ) {
    this.store.onChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: SessionNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionNode): Promise<SessionNode[]> {
    if (element) {
      return [];
    }
    const registry = await this.store.readRegistry();
    const nodes: SessionNode[] = [];
    for (const m of registry.sessionMetas) {
      const displayStatus = await this.store.resolveSessionDisplayStatus(
        m.sessionId,
        m.status
      );
      nodes.push(
        new SessionNode(
          m.sessionId,
          displayStatus,
          m.goal,
          vscode.TreeItemCollapsibleState.None,
          {
            command: "agentLoop.showPanel",
            title: "Show Panel",
            arguments: [m.sessionId],
          }
        )
      );
    }
    return nodes;
  }
}

class SessionNode extends vscode.TreeItem {
  constructor(
    public readonly sessionId: string,
    status: string,
    goal: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    command?: vscode.Command
  ) {
    super(sessionId, collapsibleState);
    this.description = status;
    this.tooltip = goal;
    this.command = command;
    this.contextValue = "session";
    this.iconPath = new vscode.ThemeIcon(
      status === "RUNNING"
        ? "sync~spin"
        : status === "RECOVERING"
        ? "refresh"
        : status === "SUCCESS"
        ? "check-all"
        : status === "FAILED"
        ? "error"
        : status === "PAUSED"
        ? "debug-pause"
        : status === "WAITING_USER"
        ? "feedback"
        : status === "STOPPED"
        ? "debug-stop"
        : status === "BLOCKED"
        ? "lock"
        : "circle-outline"
    );
  }
}
