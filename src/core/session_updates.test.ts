import test from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../shared/domain";
import { isNewerSession, mergeSessions, reconcileSessionList, sessionSummary, SessionSummary } from "../shared/session_updates";
import { SessionCoordinator } from "../server/coordinator";
import { StudioStore } from "./store";
const summary = (revision = 1): SessionSummary => ({ id: "session", revision, goal: "goal", status: "RUNNING", statusReason: null, currentNodeId: "test", activeVisitId: null, automaticRecovery: null, graph: {id:"graph",name:"Graph"},createdAt:"2026-10-24T00:00:00Z",updatedAt:"2026-10-24T00:00:00Z" });
test("monotonic revisions reject delayed snapshots even within the same millisecond", () => {
  const done = { ...summary(3), status: "SUCCESS" as const }, current = [done];
  assert.equal(mergeSessions(current, [summary(2)]), current);
  assert.equal(mergeSessions(current, [summary(3)]), current);
  assert.equal(isNewerSession(summary(4), done), true);
  assert.equal(isNewerSession({...summary(), revision:undefined},done),false);
});
test("reconnect list retains newer events and new sessions while removing deleted records", () => {
  const atRequest = [summary(1), {...summary(), id:"deleted"}];
  const current = [{...summary(3),status:"SUCCESS" as const}, {...summary(),id:"new"}, atRequest[1]!];
  const next = reconcileSessionList(current,[summary(2)],atRequest);
  assert.equal(next.find(s=>s.id==="session")!.status,"SUCCESS");
  assert.ok(next.some(s=>s.id==="new"));
  assert.ok(!next.some(s=>s.id==="deleted"));
});
test("coordinator suppresses duplicate and delayed snapshots; summaries omit detailed evidence", () => {
  const coordinator = new SessionCoordinator({} as StudioStore), events: unknown[] = [];
  coordinator.on("studio", e=>events.push(e));
  const state = {...summary(3),graph:{...summary().graph,nodes:[]},visits:[{output:"large evidence"}]} as unknown as SessionState;
  coordinator.emitStudio({type:"session",data:state});
  coordinator.emitStudio({type:"session",data:state});
  coordinator.emitStudio({type:"session",data:{...state,revision:2}});
  assert.equal(events.length,1);
  assert.equal("visits" in sessionSummary(state),false);
  assert.equal("nodes" in sessionSummary(state).graph,false);
});
