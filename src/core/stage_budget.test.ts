import test from "node:test";
import assert from "node:assert/strict";
import { createAutonomousGraph } from "./graph";
import { SessionState,NodeVisit } from "../shared/domain";
import { createSessionBudget } from "./session_budget";
import { autonomousExecutionSettings } from "./settings";
import { stageDeadline,stageBudgetReason } from "./stage_budget";
test("fixed role deadline survives recovery and preserves downstream time/calls without enlarging the whole budget",()=>{
 const graph=createAutonomousGraph(),start=10000,state={graph,settings:autonomousExecutionSettings(),executionBudget:createSessionBudget(autonomousExecutionSettings(),start),visits:[]}as unknown as SessionState;
 const node=graph.nodes.find(n=>n.type==="implementation")!,visit={startedAt:new Date(start+6*60000).toISOString(),attempts:[]}as unknown as NodeVisit;
 const fixed=stageDeadline(state,node,visit)!;assert.equal(fixed,start+42*60000);visit.stageDeadlineAt=new Date(fixed).toISOString();
 visit.cycleStartedAt=new Date(fixed).toISOString();visit.cycleDeadlineAt=new Date(fixed+31*60000).toISOString();
 assert.equal(stageBudgetReason(state,node,visit,false,fixed-1),null);assert.match(stageBudgetReason(state,node,visit,false,fixed)!,/후속/);assert.equal(Date.parse(state.executionBudget!.deadlineAt),start+60*60000);
 state.visits=[{attempts:Array.from({length:20},()=>({}))}as NodeVisit];assert.match(stageBudgetReason(state,node,visit,true,start+10*60000)!,/4회/);
 delete graph.automation!.reserveFinalizationBudget;assert.equal(stageBudgetReason(state,node,visit,true,fixed+10000),null,"historical graphs retain their policy even if a stale optional deadline is present");
});
