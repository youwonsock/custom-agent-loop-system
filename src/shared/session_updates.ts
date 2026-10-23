import { SessionState } from "./domain";

export type SessionSummary = Pick<SessionState, "id" | "goal" | "status" | "statusReason" | "createdAt" | "updatedAt" | "revision" | "currentNodeId" | "activeVisitId" | "automaticRecovery"> & { graph: Pick<SessionState["graph"], "id" | "name"> };
export function sessionSummary(s: SessionState): SessionSummary {
  return { id: s.id, goal: s.goal, status: s.status, statusReason: s.statusReason, createdAt: s.createdAt, updatedAt: s.updatedAt,
    revision: s.revision, currentNodeId: s.currentNodeId, activeVisitId: s.activeVisitId, automaticRecovery: s.automaticRecovery, graph: { id: s.graph.id, name: s.graph.name } };
}
export function isNewerSession(incoming: SessionSummary, current: SessionSummary): boolean {
  if (incoming.revision !== undefined || current.revision !== undefined)
    return (incoming.revision ?? 0) > (current.revision ?? 0);
  return incoming.updatedAt > current.updatedAt;
}
export function mergeSessions<T extends SessionSummary>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map(s => [s.id, s]));
  let changed = false;
  for (const s of incoming) {
    const previous = byId.get(s.id);
    if (!previous || isNewerSession(s, previous)) { byId.set(s.id, s); changed = true; }
  }
  return changed ? [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : current;
}

/** Remove absent records only if they have not changed since this list request began. */
export function reconcileSessionList<T extends SessionSummary>(current: T[], incoming: T[], atRequest: T[]): T[] {
  const present = new Set(incoming.map(s => s.id)), previous = new Map(atRequest.map(s => [s.id, s]));
  return mergeSessions(current.filter(s => {
    const old = previous.get(s.id);
    return present.has(s.id) || !old || isNewerSession(s, old);
  }), incoming);
}
