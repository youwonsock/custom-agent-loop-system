import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DefaultAgentTaskRunner } from "./src/application/agent-task-runner";
import { CommandService } from "./src/application/command-service";
import { PromptComposer } from "./src/application/prompt-composer";
import { createRunAggregate } from "./src/application/run-factory";
import { RunReducer } from "./src/application/run-reducer";
import { TaskInputAssembler } from "./src/application/task-input-assembler";
import { TransitionRouter } from "./src/application/transition-router";
import { WorkflowRunner } from "./src/application/workflow-runner";
import type {
  AgentRuntimePort,
  AgentRuntimeRequest,
  AgentRuntimeResponse,
} from "./src/application/ports/agent-runtime-port";
import { NoopProjection } from "./src/application/ports/projection";
import { createDefaultDefinitionRegistries } from "./src/definitions/default-registries";
import { loadDefinitionSource } from "./src/definitions/definition-loader";
import { compileWorkflow } from "./src/definitions/workflow-compiler";
import { FileArtifactStore } from "./src/infrastructure/file-artifact-store";
import type {
  RunControlCommand,
  RunControlCommandPort,
  RunControlType,
} from "./src/application/ports/control-command";
import {
  FileRunRepository,
  RunRevisionConflictError,
} from "./src/infrastructure/file-run-repository";

function envelope(signal: string, payload: unknown, evidence = true): string {
  return JSON.stringify({
    schemaVersion: 1,
    signal,
    summary: `${signal} summary`,
    requirementEvidence: evidence
      ? [
          {
            requirementId: "REQ-001",
            status: "satisfied",
            evidence: "Observed in the fake acceptance run.",
          },
        ]
      : [],
    payload,
  });
}

class ScriptedRuntime implements AgentRuntimePort {
  readonly requests: AgentRuntimeRequest[] = [];

  constructor(
    private readonly executeScript: (
      request: AgentRuntimeRequest,
      callNumber: number
    ) => AgentRuntimeResponse
  ) {}

  execute(request: AgentRuntimeRequest): Promise<AgentRuntimeResponse> {
    this.requests.push(request);
    return Promise.resolve(this.executeScript(request, this.requests.length));
  }
}

class MemoryControls implements RunControlCommandPort {
  private sequence = 0;
  readonly pending: RunControlCommand[] = [];
  readonly completed: RunControlCommand[] = [];

  enqueue(runId: string, type: RunControlType, message: string | null): Promise<RunControlCommand> {
    const command: RunControlCommand = {
      schemaVersion: 1,
      requestId: `control_test_${String(++this.sequence).padStart(12, "0")}`,
      runId,
      type,
      message,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    this.pending.push(command);
    return Promise.resolve(command);
  }

  recover(): Promise<void> {
    return Promise.resolve();
  }

  claim(): Promise<RunControlCommand | null> {
    return Promise.resolve(this.pending.shift() ?? null);
  }

  complete(command: Readonly<RunControlCommand>): Promise<void> {
    this.completed.push({ ...command });
    return Promise.resolve();
  }
}

test("v4 default definitions compile into one frozen deterministic bundle", async () => {
  const source = await loadDefinitionSource(process.cwd());
  const bundle = compileWorkflow(source, createDefaultDefinitionRegistries());
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.startNodeId, "PLANNING");
  assert.equal(bundle.nodes.PLAN_APPROVAL.kind, "human_gate");
  assert.equal(bundle.tasks.implement_changes.runner, "agent");
  assert.equal(bundle.transitions.TEST.pass, "QA_REVIEW");
  assert.equal(bundle.transitions.TEST.fail, "QA_REVIEW");
  assert.deepEqual(bundle.analysis.requiredApprovalGateIds, ["PLAN_APPROVAL"]);
  assert.equal(Object.isFrozen(bundle), true);
  assert.match(bundle.definitionHash, /^[a-f0-9]{64}$/u);
});

test("v4 compiler rejects undeclared signals, access expansion, and approval bypass", async () => {
  const source = await loadDefinitionSource(process.cwd());
  const registries = createDefaultDefinitionRegistries();

  const badSignal = structuredClone(source);
  badSignal.workflow.transitions.find(
    (rule) => rule.from === "TEST" && rule.on === "pass"
  )!.on = "maybe";
  assert.throws(() => compileWorkflow(badSignal, registries), /undeclared signal/u);

  const badAccess = structuredClone(source);
  const implementationNode = badAccess.workflow.nodes.find(
    (node) => node.id === "IMPLEMENTATION"
  );
  assert.ok(implementationNode && implementationNode.kind === "task");
  implementationNode.agentId = "planner";
  assert.throws(
    () => compileWorkflow(badAccess, registries),
    /expands agent policy|read-only agent/u
  );

  const bypass = structuredClone(source);
  bypass.tasks.tasks.find((task) => task.id === "produce_plan")!.allowedSignals.push("skip");
  bypass.workflow.transitions.push({ from: "PLANNING", on: "skip", to: "SUCCESS" });
  assert.throws(() => compileWorkflow(bypass, registries), /without required gate/u);
});

test("one TaskDefinition can be reused by multiple agents and nodes", async () => {
  const source = structuredClone(await loadDefinitionSource(process.cwd()));
  const planner = source.agents.agents.find((agent) => agent.id === "planner")!;
  source.agents.agents.push({
    ...structuredClone(planner),
    id: "planner_refiner",
    role: "Plan refiner",
  });
  const planningNode = source.workflow.nodes.find((node) => node.id === "PLANNING")!;
  assert.equal(planningNode.kind, "task");
  source.workflow.nodes.push({
    ...structuredClone(planningNode),
    id: "PLAN_REFINEMENT",
    agentId: "planner_refiner",
  });
  source.workflow.transitions.find(
    (transition) => transition.from === "PLANNING" && transition.on === "success"
  )!.to = "PLAN_REFINEMENT";
  source.workflow.transitions.push({
    from: "PLAN_REFINEMENT",
    on: "success",
    to: "PLAN_APPROVAL",
  });
  const approvalNode = source.workflow.nodes.find((node) => node.id === "PLAN_APPROVAL")!;
  approvalNode.inputs = approvalNode.inputs.map((binding) =>
    binding.source.kind === "node_output"
      ? { ...binding, source: { kind: "node_output" as const, nodeId: "PLAN_REFINEMENT" } }
      : binding
  );

  const bundle = compileWorkflow(source, createDefaultDefinitionRegistries());
  assert.equal(bundle.nodes.PLANNING.taskId, "produce_plan");
  assert.equal(bundle.nodes.PLAN_REFINEMENT.taskId, "produce_plan");
  assert.equal(bundle.nodes.PLANNING.agentId, "planner");
  assert.equal(bundle.nodes.PLAN_REFINEMENT.agentId, "planner_refiner");
});

test("JSON-only task runner rejects legacy completion text after one tool-free recovery", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-loop-v4-json-"));
  try {
    const source = await loadDefinitionSource(process.cwd());
    const registries = createDefaultDefinitionRegistries();
    const bundle = compileWorkflow(source, registries);
    const reducer = new RunReducer();
    let aggregate = createRunAggregate({
      runId: "json_contract",
      definition: bundle,
      goal: "Implement the requested behavior.",
      requirements: [{ id: "REQ-001", text: "Implement the requested behavior." }],
      targetProjectPath: process.cwd(),
      now: "2026-08-16T00:00:00.000Z",
    });
    aggregate = reducer.reserveNode(aggregate, "activation_1", "2026-08-16T00:00:01.000Z");
    aggregate = reducer.startAttempt(
      aggregate,
      "activation_1",
      "attempt_1",
      "2026-08-16T00:00:02.000Z"
    );
    const runtime = new ScriptedRuntime((request) => ({
      status: "succeeded",
      attemptId: request.attemptId,
      assistantText: "[PHASE_DONE]",
    }));
    const artifacts = new FileArtifactStore(path.join(temporaryRoot, "artifacts"));
    const assembler = new TaskInputAssembler(artifacts, registries.schemas);
    const runner = new DefaultAgentTaskRunner(
      runtime,
      artifacts,
      assembler,
      new PromptComposer(),
      registries
    );
    const node = bundle.nodes.PLANNING;
    const result = await runner.run(
      {
        aggregate,
        node,
        activationId: "activation_1",
        attemptId: "attempt_1",
        attemptNumber: 1,
      },
      bundle.agents.planner,
      bundle.tasks.produce_plan
    );
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.kind, "format");
    assert.equal(runtime.requests.length, 2);
    assert.equal(runtime.requests[1].mode, "format_recovery");
    assert.deepEqual(runtime.requests[1].toolPolicy, {
      workspace: "none",
      webSearch: false,
      mcpServers: [],
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("workflow runner resumes PLAN_APPROVAL without replaying planning and preserves activations", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-loop-v4-run-"));
  try {
    const source = await loadDefinitionSource(process.cwd());
    const registries = createDefaultDefinitionRegistries();
    const bundle = compileWorkflow(source, registries);
    const runsRoot = path.join(temporaryRoot, "runs");
    const repository = new FileRunRepository({ runsRoot });
    const artifacts = new FileArtifactStore(path.join(temporaryRoot, "artifacts"));
    let auditCalls = 0;
    const runtime = new ScriptedRuntime((request) => {
      let assistantText: string;
      switch (request.taskId) {
        case "produce_plan":
          assistantText = envelope(
            "success",
            {
              choices: [1, 2, 3].map((id) => ({
                id: `plan-${id}`,
                title: `Plan ${id}`,
                plan: `Implement plan ${id}.`,
                requirementCoverage: ["REQ-001"],
              })),
            },
            false
          );
          break;
        case "implement_changes":
          assistantText = envelope("success", {
            changedFiles: ["src/example.ts"],
            verification: [{ command: "npm test", exitCode: 0, summary: "passed" }],
            notes: "Implemented cumulatively.",
          });
          break;
        case "run_tests":
          assistantText = envelope("pass", {
            verdict: "pass",
            commands: [{ command: "npm test", exitCode: 0, summary: "passed" }],
            failures: [],
          });
          break;
        case "audit_quality":
          auditCalls += 1;
          assistantText = auditCalls === 1
            ? envelope("rejected", {
                decision: "rejected",
                findings: ["One more implementation cycle is required."],
              })
            : envelope("approved", {
                decision: "approved",
                findings: ["Evidence is complete."],
              });
          break;
        case "approve_completion":
          assistantText = envelope("approved", {
            decision: "approved",
            findings: ["All acceptance paths passed."],
            rationale: "Requirement evidence is complete.",
          });
          break;
        default:
          assistantText = envelope("success", {
            briefing: "No interruption required.",
            facts: ["No failure."],
            recoveryAction: "None.",
          }, false);
      }
      return {
        status: "succeeded",
        attemptId: request.attemptId,
        assistantText,
      };
    });
    const reducer = new RunReducer();
    const projection = new NoopProjection();
    const assembler = new TaskInputAssembler(artifacts, registries.schemas);
    const taskRunner = new DefaultAgentTaskRunner(
      runtime,
      artifacts,
      assembler,
      new PromptComposer(),
      registries
    );
    const runner = new WorkflowRunner(
      repository,
      reducer,
      new TransitionRouter(),
      taskRunner,
      assembler,
      projection,
      {
        now: (() => {
          let tick = 0;
          return () => `2026-08-16T00:00:${String(tick++).padStart(2, "0")}.000Z`;
        })(),
        delay: () => Promise.resolve(),
      }
    );
    const initial = createRunAggregate({
      runId: "integration_run",
      definition: bundle,
      goal: "Implement the requested behavior.",
      requirements: [{ id: "REQ-001", text: "Implement the requested behavior." }],
      targetProjectPath: process.cwd(),
      now: "2026-08-16T00:00:00.000Z",
    });
    await repository.initialize(initial);
    await repository.acquireFencingEpoch(initial.runId);

    const waiting = await runner.runUntilBoundary(initial.runId);
    assert.equal(waiting.execution.status, "WAITING_USER");
    assert.equal(waiting.execution.currentNodeId, "PLAN_APPROVAL");
    assert.equal(runtime.requests.filter((request) => request.taskId === "produce_plan").length, 1);
    assert.ok(waiting.pendingInput);

    const commands = new CommandService(repository, reducer, projection);
    await commands.respondToHumanGate(initial.runId, {
      requestId: waiting.pendingInput!.requestId,
      nodeId: "PLAN_APPROVAL",
      signal: "approved",
      choiceId: "plan-1",
      respondedAt: "2026-08-16T00:01:00.000Z",
    });
    const completed = await runner.runUntilBoundary(initial.runId);
    assert.equal(completed.execution.status, "SUCCESS");
    assert.equal(runtime.requests.filter((request) => request.taskId === "produce_plan").length, 1);
    assert.equal(runtime.requests.filter((request) => request.taskId === "implement_changes").length, 2);
    assert.equal(Object.keys(completed.nodeExecutions).length, 9);
    assert.equal(new Set(Object.keys(completed.nodeExecutions)).size, 9);
    assert.equal(completed.latestCompletedByNode.PLANNING.startsWith("activation_"), true);
    const implementationActivations = Object.values(completed.nodeExecutions)
      .filter((execution) => execution.nodeId === "IMPLEMENTATION");
    assert.equal(implementationActivations.length, 2);
    assert.equal(
      completed.latestCompletedByNode.IMPLEMENTATION,
      implementationActivations[1].activationId
    );
    assert.notEqual(implementationActivations[0].output, null);
    assert.notEqual(implementationActivations[1].output, null);
    assert.equal(completed.context.selectedPlanChoiceId, "plan-1");

    const stale = structuredClone(completed);
    stale.execution.reason = "stale writer";
    await assert.rejects(
      repository.commit(stale, completed.revision - 1, completed.fencingEpoch),
      RunRevisionConflictError
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("provider access approval retries the same activation with a new attempt", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-loop-v4-access-"));
  try {
    const source = await loadDefinitionSource(process.cwd());
    const registries = createDefaultDefinitionRegistries();
    const bundle = compileWorkflow(source, registries);
    const repository = new FileRunRepository({ runsRoot: path.join(temporaryRoot, "runs") });
    const artifacts = new FileArtifactStore(path.join(temporaryRoot, "artifacts"));
    const runtime = new ScriptedRuntime((request, callNumber) => {
      if (callNumber === 1) {
        return {
          status: "failed",
          attemptId: request.attemptId,
          failure: {
            kind: "permission",
            message: "Provider requested interactive filesystem access: Allow access to C:\\outside? [y/n]",
            retryable: false,
            providerStarted: true,
          },
        };
      }
      return {
        status: "succeeded",
        attemptId: request.attemptId,
        assistantText: envelope("success", {
          choices: [1, 2, 3].map((id) => ({
            id: `plan-${id}`,
            title: `Plan ${id}`,
            plan: `Implement plan ${id}.`,
            requirementCoverage: ["REQ-001"],
          })),
        }, false),
      };
    });
    const reducer = new RunReducer();
    const projection = new NoopProjection();
    const assembler = new TaskInputAssembler(artifacts, registries.schemas);
    const runner = new WorkflowRunner(
      repository,
      reducer,
      new TransitionRouter(),
      new DefaultAgentTaskRunner(runtime, artifacts, assembler, new PromptComposer(), registries),
      assembler,
      projection,
      {
        now: (() => {
          let tick = 0;
          return () => `2026-08-16T00:02:${String(tick++).padStart(2, "0")}.000Z`;
        })(),
        delay: () => Promise.resolve(),
      }
    );
    const initial = createRunAggregate({
      runId: "access_run",
      definition: bundle,
      goal: "Wait for access approval safely.",
      requirements: [{ id: "REQ-001", text: "Wait for access approval safely." }],
      targetProjectPath: process.cwd(),
    });
    await repository.initialize(initial);
    await repository.acquireFencingEpoch(initial.runId);

    const waitingForAccess = await runner.runUntilBoundary(initial.runId);
    const activationId = waitingForAccess.execution.activeActivationId!;
    assert.equal(waitingForAccess.execution.status, "WAITING_USER");
    assert.equal(waitingForAccess.pendingInput?.kind, "access_approval");
    assert.deepEqual(
      (waitingForAccess.pendingInput?.context as { requestedPaths: string[] }).requestedPaths,
      ["C:\\outside"]
    );
    assert.equal(waitingForAccess.nodeExecutions[activationId].status, "waiting_user");
    assert.equal(waitingForAccess.nodeExecutions[activationId].attemptIds.length, 1);

    const commands = new CommandService(repository, reducer, projection);
    const approved = await commands.respondToHumanGate(initial.runId, {
      requestId: waitingForAccess.pendingInput!.requestId,
      nodeId: waitingForAccess.pendingInput!.nodeId,
      signal: "retry",
      respondedAt: "2026-08-16T00:03:00.000Z",
    });
    assert.equal(approved.execution.activeActivationId, activationId);
    assert.equal(approved.nodeExecutions[activationId].status, "reserved");
    assert.deepEqual(approved.context.additionalAllowedPaths, ["C:\\outside"]);

    const waitingForPlan = await runner.runUntilBoundary(initial.runId);
    assert.equal(waitingForPlan.execution.status, "WAITING_USER");
    assert.equal(waitingForPlan.pendingInput?.kind, "plan_approval");
    assert.equal(waitingForPlan.latestCompletedByNode.PLANNING, activationId);
    assert.equal(waitingForPlan.nodeExecutions[activationId].attemptIds.length, 2);
    assert.equal(new Set(runtime.requests.map((request) => request.activationId)).size, 1);
    assert.deepEqual(runtime.requests[1].additionalAllowedPaths, ["C:\\outside"]);
    assert.equal(runtime.requests[1].fullAccess, false);
    assert.equal(runtime.requests.length, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("queued STOP is reduced at a checkpoint before another provider starts", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-loop-v4-control-"));
  try {
    const source = await loadDefinitionSource(process.cwd());
    const registries = createDefaultDefinitionRegistries();
    const bundle = compileWorkflow(source, registries);
    const repository = new FileRunRepository({ runsRoot: path.join(temporaryRoot, "runs") });
    const artifacts = new FileArtifactStore(path.join(temporaryRoot, "artifacts"));
    const runtime = new ScriptedRuntime((request) => ({
      status: "succeeded",
      attemptId: request.attemptId,
      assistantText: envelope("success", {}, false),
    }));
    const reducer = new RunReducer();
    const projection = new NoopProjection();
    const assembler = new TaskInputAssembler(artifacts, registries.schemas);
    const controls = new MemoryControls();
    const runner = new WorkflowRunner(
      repository,
      reducer,
      new TransitionRouter(),
      new DefaultAgentTaskRunner(runtime, artifacts, assembler, new PromptComposer(), registries),
      assembler,
      projection,
      undefined,
      undefined,
      controls
    );
    const initial = createRunAggregate({
      runId: "control_run",
      definition: bundle,
      goal: "Stop before provider execution.",
      requirements: [{ id: "REQ-001", text: "Stop before provider execution." }],
      targetProjectPath: process.cwd(),
    });
    await repository.initialize(initial);
    await repository.acquireFencingEpoch(initial.runId);
    const command = await controls.enqueue(initial.runId, "stop", "checkpoint stop");
    const stopped = await runner.runUntilBoundary(initial.runId);
    assert.equal(stopped.execution.status, "STOPPED");
    assert.equal(runtime.requests.length, 0);
    assert.ok(stopped.processedRequestIds.includes(command.requestId));
    assert.equal(controls.completed.length, 1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an interrupted mutation is never resumable as an automatic replay", async () => {
  const source = await loadDefinitionSource(process.cwd());
  const bundle = compileWorkflow(source, createDefaultDefinitionRegistries());
  const reducer = new RunReducer();
  let aggregate = createRunAggregate({
    runId: "unknown_mutation",
    definition: bundle,
    goal: "Preserve mutation safety.",
    requirements: [{ id: "REQ-001", text: "Preserve mutation safety." }],
    targetProjectPath: process.cwd(),
  });
  aggregate.execution.currentNodeId = "IMPLEMENTATION";
  aggregate.execution.activeCycleNumber = 1;
  aggregate.execution.cyclesStarted = 1;
  aggregate = reducer.reserveNode(aggregate, "activation_mutation", "2026-08-16T00:00:01.000Z");
  aggregate = reducer.startAttempt(
    aggregate,
    "activation_mutation",
    "attempt_mutation",
    "2026-08-16T00:00:02.000Z"
  );
  aggregate = reducer.completeNode(aggregate, {
    nodeId: "IMPLEMENTATION",
    activationId: "activation_mutation",
    result: {
      status: "failed",
      signal: "error",
      output: null,
      effects: [],
      artifacts: [],
      failure: {
        kind: "interrupted",
        message: "Operator interrupted mutation.",
        retryable: false,
        ambiguousMutation: true,
        attemptId: "attempt_mutation",
      },
      pendingInput: null,
    },
    targetId: bundle.applicationPolicy.interruptNodeId,
    terminalStatus: null,
    effects: [],
    completedAt: "2026-08-16T00:00:03.000Z",
  });
  assert.equal(aggregate.nodeExecutions.activation_mutation.status, "unknown_mutation");
  assert.throws(
    () => reducer.resumeRun(aggregate, "unsafe resume", "2026-08-16T00:00:04.000Z"),
    /unknown outcome/u
  );
});
