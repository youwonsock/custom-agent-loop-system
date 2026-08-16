export type WorkspaceProcessLaunch =
  | "discoverModels"
  | "newSession"
  | "resumeSession"
  | "recoverSession"
  | "revisePlan"
  | "approvePlan"
  | "controlSession";

const PROCESS_ACTION_LABELS: Record<WorkspaceProcessLaunch, string> = {
  discoverModels: "discover models",
  newSession: "start a session",
  resumeSession: "resume a session",
  recoverSession: "recover a session",
  revisePlan: "revise a plan",
  approvePlan: "approve a plan",
  controlSession: "control a session",
};

export function activationSideEffectsAllowed(isTrusted: boolean): boolean {
  return isTrusted;
}

export function requireWorkspaceTrust(isTrusted: boolean, action: string): void {
  if (!isTrusted) {
    throw new Error(
      `Agent Loop cannot ${action} in an untrusted workspace. ` +
      `Trust the workspace before running external processes.`
    );
  }
}

export function launchTrusted<T>(
  isTrusted: boolean,
  launchKind: WorkspaceProcessLaunch,
  launch: () => T
): T {
  requireWorkspaceTrust(isTrusted, PROCESS_ACTION_LABELS[launchKind]);
  return launch();
}
