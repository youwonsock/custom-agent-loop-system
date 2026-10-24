import test from "node:test";
import assert from "node:assert/strict";
import { createSessionBudget, sessionBudgetReason, pauseForBudget } from "./session_budget";
import { executionSettings, autonomousExecutionSettings } from "./settings";
import { SessionState } from "../shared/domain";
import { prepareManualResume } from "./session_transitions";
test("whole-session deadlines and native attempts include report retries without renewal",()=>{
 const settings=executionSettings({sessionTimeoutMs:1000,maxSessionAttempts:2});const b=createSessionBudget(settings,10000);
 const s={settings,executionBudget:b,visits:[{id:"v",status:"running",attempts:[{mode:"standard"},{mode:"completion_recovery"}]}],activeVisitId:"v",automaticRecovery:{count:1,resumeAt:"later"},currentNodeId:"test",visitLimit:100,iterationLimit:20,completedIterations:0}as unknown as SessionState;
 assert.equal(sessionBudgetReason(s,false,10500),null);assert.match(sessionBudgetReason(s,true,10500)!,/2회/);assert.match(sessionBudgetReason(s,false,11000)!,/시간/);
 pauseForBudget(s,"exhausted");assert.equal(s.status,"PAUSED");assert.equal(s.automaticRecovery,null);assert.equal(sessionBudgetReason(s),"exhausted");
 const copy=JSON.stringify(b);s.visits=[];s.activeVisitId=null;prepareManualResume(s,20000);assert.equal(JSON.stringify(b),copy);
 assert.equal(autonomousExecutionSettings().maxAutomaticRecoveryCycles,1);assert.equal(autonomousExecutionSettings().phaseTimeoutMs,600000);
 assert.equal(sessionBudgetReason({visits:[]}as unknown as SessionState),null,"legacy records are not silently assigned a new budget");
});
