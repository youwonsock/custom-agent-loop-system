import test from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../shared/domain";
import { beginResume, interruptSession, prepareManualResume, stopSession } from "./session_transitions";
import { createGraph } from "./graph";
const state = () => ({ status:"RUNNING", graph:createGraph(), visits:[], activeVisitId:null, automaticRecovery:{count:1,resumeAt:"later"}, currentNodeId:"implementation", visitLimit:10, iterationLimit:2, completedIterations:0, settings:{maxIterations:2}, convergence:{stagnantCycles:1}, pendingApproval:null,pendingAccess:null } as unknown as SessionState);
test("stop and interrupt share lifecycle rules and cancel automatic recovery", () => {
  const stopped = state(); stopSession(stopped); assert.equal(stopped.status,"STOPPED"); assert.equal(stopped.automaticRecovery,null);
  const interrupted=state(); interruptSession(interrupted,"inspect"); assert.equal(interrupted.currentNodeId,"interrupt"); assert.equal(interrupted.automaticRecovery,null); assert.equal(interrupted.interruptMessage,"inspect");
});
test("resume preserves approvals and only a manual terminal resume resets reentry budget", () => {
  const s = state(); s.pendingApproval={nodeId:"planning",visitId:"pending"};
  assert.throws(()=>beginResume(s),/먼저 승인/);
  s.pendingApproval=null; s.status="SUCCESS"; assert.throws(()=>beginResume(s),/완료된/);
  s.status="PAUSED"; s.currentNodeId="PAUSED"; prepareManualResume(s,0);
  assert.equal(s.currentNodeId,"implementation"); assert.equal(s.convergence.stagnantCycles,0);
  beginResume(s); assert.equal(s.status,"RUNNING");
});
