import { SessionState } from "../shared/domain";
import { AppError } from "./errors";
import { safeId, validateGraphDocument } from "./graph";
import { executionSettings } from "./settings";
import { validContractSnapshot, validateManifest } from "./verification_contract";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const nullableText = (v: unknown) => v === null || text(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const member = (v: unknown, values: readonly string[]) => text(v) && values.includes(v);
const array = (v: unknown, check: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(check);
const statuses = ["RUNNING", "RECOVERING", "WAITING_USER", "PAUSED", "STOPPED", "BLOCKED", "SUCCESS", "FAILED"];
const failures = ["transport_timeout", "idle_timeout", "tool_timeout", "phase_timeout", "spawn_error", "process_exit", "incomplete_response", "network", "tool_arguments", "rate_limited", "quota_exhausted", "auth", "model_unavailable", "permission", "role_violation", "cancelled", "orphaned_process", "unknown", "worker_crash"];
const receipt = (v: unknown): boolean => object(v) && text(v.id) && text(v.command) && (v.exitCode === null || Number.isSafeInteger(v.exitCode)) && nullableText(v.environmentError);
const binding = (v: unknown): boolean => object(v) && safeId(v.connectionId) && text(v.modelId) && (v.variant === undefined || text(v.variant));
const plan = (v: unknown): boolean => object(v) && count(v.id) && count(v.revision) && text(v.body) && text(v.title);
function attempt(v: unknown): boolean {
  return object(v) && safeId(v.id) && count(v.number) && member(v.status, [...failures, "starting", "running", "retry_wait", "succeeded", "interrupted"]) &&
    text(v.startedAt) && nullableText(v.endedAt) && (v.pid === null || Number.isSafeInteger(v.pid)) && nullableText(v.cliSessionId) &&
    typeof v.reconnectUsed === "boolean" && member(v.mode, ["standard", "completion_recovery"]) && (v.failureKind === null || member(v.failureKind, failures)) &&
    nullableText(v.message) && text(v.logPath) && nullableText(v.lastProgressAt) && member(v.activity, ["initial_transport", "model_generation", "tool_execution"]) &&
    text(v.deadlineAt) && text(v.requestedModelId) && nullableText(v.actualModelId) && count(v.assistantTextBytes) && count(v.maxTokens) &&
    (v.commands === undefined || array(v.commands, receipt)) && (v.completionAccepted === undefined || typeof v.completionAccepted === "boolean") &&
    (v.fileMutation === undefined || typeof v.fileMutation === "boolean") &&
    (v.pricing === undefined || (object(v.pricing) && member(v.pricing.status,["free","paid","unknown"]) && member(v.pricing.source,["native_flag","native_cost","unavailable"]) && text(v.pricing.checkedAt) && text(v.pricing.reason)));
}
function visit(v: unknown): boolean {
  return object(v) && safeId(v.id) && safeId(v.nodeId) && count(v.number) && member(v.status, ["running", "waiting_approval", "succeeded", "failed", "paused"]) &&
    text(v.startedAt) && nullableText(v.completedAt) && array(v.attempts, attempt) && text(v.output) &&
    (v.verdict === null || member(v.verdict, ["PASS","FAIL","BLOCKED","APPROVED","REJECTED"])) && array(v.plans, plan) &&
    (v.selectedPlanId === null || count(v.selectedPlanId)) && text(v.cycleStartedAt) && text(v.cycleDeadlineAt) && count(v.recoveryCount) &&
    typeof v.transitionCommitted === "boolean" && count(v.automaticCycles) && (v.verifiedCommands === undefined || array(v.verifiedCommands, receipt));
}

/** Decode at the persistence boundary without inventing missing evidence or migrating v3. */
export function decodeSession(value: unknown, expectedId: string): SessionState {
  const invalid = (field: string): never => { throw new AppError(500, `세션 snapshot 형식이 손상되었습니다 (${field}). 원본 파일을 보존하고 확인하세요.`, "invalid_session"); };
  const require = (ok: boolean, field: string) => { if (!ok) invalid(field); };
  if (!object(value)) return invalid("root");
  const s = value;
  require(s.stateVersion === 3, "stateVersion");
  require(s.id === expectedId && safeId(s.id) && safeId(s.requestId), "identity");
  require(s.revision === undefined || count(s.revision), "revision");
  require(text(s.goal) && text(s.targetProjectPath) && text(s.createdAt) && text(s.updatedAt) && member(s.status, statuses) && nullableText(s.statusReason), "session");
  try { validateGraphDocument(s.graph); } catch { invalid("graph"); }
  require(array(s.connections, c => object(c) && safeId(c.id) && member(c.type,["codex","claude","kilo","opencode"]) && text(c.label) && text(c.binary)), "connections");
  require(object(s.bindings) && Object.values(s.bindings).every(binding), "bindings");
  require(object(s.settings) && Object.keys(executionSettings()).filter(key=>!["sessionTimeoutMs","maxSessionAttempts"].includes(key)).every(key => key in (s.settings as Obj)), "settings");
  try { executionSettings(s.settings as SessionState["settings"]); } catch { invalid("settings"); }
  require(array(s.visits, visit), "visits/attempts");
  require(nullableText(s.currentNodeId) && nullableText(s.activeVisitId) && nullableText(s.interruptMessage), "execution references");
  require(count(s.completedIterations) && count(s.visitLimit) && count(s.iterationLimit), "budgets");
  require(member(s.accessMode,["ask","full_access"]) && array(s.additionalAllowedPaths,text) && array(s.processedRequests,safeId), "access/requests");
  const ref = (v: unknown) => object(v) && safeId(v.nodeId) && safeId(v.visitId);
  require(s.pendingApproval === null || ref(s.pendingApproval), "pendingApproval");
  require(s.pendingAccess === null || (ref(s.pendingAccess) && array((s.pendingAccess as Obj).paths,text)), "pendingAccess");
  require(s.approvedPlanRef === null || (object(s.approvedPlanRef) && safeId(s.approvedPlanRef.visitId) && count(s.approvedPlanRef.choiceId) && count(s.approvedPlanRef.revision)), "approvedPlanRef");
  require(s.automaticRecovery === null || (object(s.automaticRecovery) && count(s.automaticRecovery.count) && text(s.automaticRecovery.resumeAt)), "automaticRecovery");
  require(object(s.requirements), "requirements");
  const r = s.requirements as Obj;
  require(r.version === 1 && text(r.derivedAt) && array(r.items, i => object(i) && text(i.id) && /^REQ-\d{3,}$/.test(i.id) && text(i.text) && member(i.category,["deliverable","behavior","constraint","research"]) && i.mandatory === true && i.source === "original_goal"), "requirements.items");
  require(array(r.evidence, e => object(e) && text(e.requirementId) && text(e.stageId) && text(e.role) && member(e.status,["SATISFIED","PARTIAL","FAILED","BLOCKED"]) && text(e.summary) && nullableText(e.attemptId) && text(e.recordedAt)), "requirements.evidence");
  require(object(s.convergence) && count(s.convergence.stagnantCycles) && array(s.convergence.history, h => object(h) && count(h.loopCount) && count(h.score) && text(h.signature) && array(h.unresolvedRequirementIds,text) && text(h.recordedAt)), "convergence");
  const state = value as unknown as SessionState;
  if (s.executionBudget !== undefined) {
    const b = s.executionBudget;
    require(object(b) && text(b.startedAt) && Number.isFinite(Date.parse(b.startedAt)) && text(b.deadlineAt) && Date.parse(b.deadlineAt)>Date.parse(b.startedAt) && count(b.maxAttempts) && (b.maxAttempts as number)>0 && nullableText(b.exhaustedReason), "executionBudget");
  }
  if (s.verificationContract !== undefined) {
    require(validContractSnapshot(s.verificationContract), "verificationContract");
    if (state.verificationContract?.status === "locked") {
      try { validateManifest(state.verificationContract.manifest,state.requirements.items.map(r=>r.id),!!state.graph.automation?.browserVerification); } catch { invalid("verificationContract.manifest"); }
    }
  }
  const visits = new Set(state.visits.map(v => v.id)), nodes = new Set(state.graph.nodes.map(n => n.id));
  require(visits.size === state.visits.length && state.visits.every(v=>nodes.has(v.nodeId)), "visit identities");
  require(state.activeVisitId === null || visits.has(state.activeVisitId), "activeVisitId");
  for (const pending of [state.pendingAccess,state.pendingApproval]) if (pending)
    require(state.visits.some(v=>v.id===pending.visitId && v.nodeId===pending.nodeId), "pending visit reference");
  require(state.graph.nodes.every(n=>binding(state.bindings[n.id])), "node bindings");
  return state;
}
