import type { StudioData } from "../hooks/useStudioData";
import type { GraphEditor } from "../hooks/useGraphEditor";
import type { Connections } from "../hooks/useConnections";
import type { RunController } from "../hooks/useRunController";

// Explicit view capabilities. State stays in the app-level hooks across lazy views.
type StudioFields = StudioData & GraphEditor & Connections & RunController;

export type GraphsViewModel = Pick<
  StudioFields,
  | "boot"
  | "setDraft"
  | "view"
  | "setGraphs"
  | "connections"
  | "target"
  | "setError"
  | "attempt"
  | "draft"
  | "draftRef"
  | "dirty"
  | "saveStatus"
  | "conflict"
  | "graphBusy"
  | "past"
  | "future"
  | "selectedNode"
  | "setSelectedNode"
  | "installDraft"
  | "change"
  | "undo"
  | "redo"
  | "newGraph"
  | "copyGraph"
  | "exportGraph"
  | "removeNodes"
  | "addNode"
  | "connect"
  | "selected"
> &
  GraphInspectorModel &
  RunComposerModel;

export type ConnectionsViewModel = Pick<
  StudioFields,
  | "view"
  | "connections"
  | "setConnections"
  | "catalogs"
  | "target"
  | "setTarget"
  | "attempt"
  | "connectionForm"
  | "setConnectionForm"
  | "connectionBusy"
  | "setConnectionBusy"
  | "querying"
  | "query"
>;

export type RunsViewModel = Pick<
  StudioFields,
  | "view"
  | "setView"
  | "sessions"
  | "setSessions"
  | "attempt"
  | "selectedNode"
  | "setSelectedNode"
  | "selectedRun"
  | "setSelectedRun"
  | "actionBusy"
  | "interruptText"
  | "setInterruptText"
  | "run"
  | "act"
> &
  PlanReviewModel &
  LogPanelModel;

export type PlanReviewModel = Pick<
  StudioFields,
  | "planText"
  | "setPlanText"
  | "planEditing"
  | "setPlanEditing"
  | "setPlanChoice"
  | "actionBusy"
  | "run"
  | "pendingVisit"
  | "plan"
  | "act"
>;

export type DirectoryDialogModel = Pick<
  StudioFields,
  | "setTarget"
  | "setNotice"
  | "directory"
  | "setDirectory"
  | "directoryBusy"
  | "browse"
>;

export type LogPanelModel = Pick<
  StudioFields,
  "log" | "logRef" | "logBottom" | "run" | "visit"
>;

export type GraphInspectorModel = Pick<
  StudioFields,
  | "draft"
  | "selected"
  | "selectedNode"
  | "setSelectedNode"
  | "graphBusy"
  | "change"
  | "updateNode"
  | "removeNodes"
  | "connections"
  | "catalogs"
  | "target"
  | "query"
  | "querying"
  | "issues"
>;

export type RunComposerModel = Pick<
  StudioFields,
  | "goalRef"
  | "goal"
  | "setGoal"
  | "target"
  | "setTarget"
  | "browse"
  | "directoryBusy"
  | "accessMode"
  | "setAccessMode"
  | "maxIterations"
  | "setMaxIterations"
  | "sessionMinutes"
  | "setSessionMinutes"
  | "maxSessionAttempts"
  | "setMaxSessionAttempts"
  | "starting"
  | "start"
  | "issues"
  | "conflict"
>;
