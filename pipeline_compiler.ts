import { createHash } from "node:crypto";
import {
  PipelineDefinition,
  PipelineStage,
  executorForStage,
  roleForStage,
  validatePipeline,
} from "./pipeline";

const TERMINAL_TARGETS = new Set(["SUCCESS", "PAUSED", "BLOCKED"]);
const MUTATION_EXECUTORS = new Set(["implementation", "test"]);
const READ_ONLY_MODEL_ROLES = new Set(["planner", "qa_lead", "master", "interrupter"]);

export interface PipelineCycleAnalysis {
  stageIds: string[];
  consumesCycle: boolean;
  consumesWorkflowStep: true;
}

export interface PipelineCompilation {
  compilerVersion: 1;
  pipelineHash: string;
  compiledAt: string;
  reachableStageIds: string[];
  approvalGateStageIds: string[];
  terminalTargets: string[];
  cyclicComponents: PipelineCycleAnalysis[];
}

export interface CompiledPipeline {
  pipeline: PipelineDefinition;
  compilation: PipelineCompilation;
}

function clonePipeline(input: PipelineDefinition): PipelineDefinition {
  return JSON.parse(JSON.stringify(input)) as PipelineDefinition;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function pipelineHash(pipeline: PipelineDefinition): string {
  return createHash("sha256").update(canonicalJson(pipeline)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function stageTargets(stage: PipelineStage): string[] {
  return [...new Set([stage.onSuccess, stage.onFailure])];
}

function reachableStages(pipeline: PipelineDefinition): Set<string> {
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage]));
  const reachable = new Set<string>();
  const pending = [pipeline.startStageId];
  while (pending.length > 0) {
    const stageId = pending.pop()!;
    if (reachable.has(stageId)) continue;
    reachable.add(stageId);
    const stage = byId.get(stageId)!;
    for (const target of stageTargets(stage)) {
      if (byId.has(target) && !reachable.has(target)) pending.push(target);
    }
  }
  return reachable;
}

function stagesWithTerminalRoute(pipeline: PipelineDefinition): Set<string> {
  const routable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of pipeline.stages) {
      if (routable.has(stage.id)) continue;
      if (
        stageTargets(stage).some(
          (target) => TERMINAL_TARGETS.has(target) || routable.has(target)
        )
      ) {
        routable.add(stage.id);
        changed = true;
      }
    }
  }
  return routable;
}

function terminalTargetsFromStart(pipeline: PipelineDefinition): Set<string> {
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage]));
  const visited = new Set<string>();
  const terminals = new Set<string>();
  const pending = [pipeline.startStageId];
  while (pending.length > 0) {
    const stageId = pending.pop()!;
    if (visited.has(stageId)) continue;
    visited.add(stageId);
    for (const target of stageTargets(byId.get(stageId)!)) {
      if (TERMINAL_TARGETS.has(target)) terminals.add(target);
      else if (!visited.has(target)) pending.push(target);
    }
  }
  return terminals;
}

function stronglyConnectedComponents(
  pipeline: PipelineDefinition,
  reachable: ReadonlySet<string>
): string[][] {
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage]));
  const indexByStage = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (stageId: string): void => {
    indexByStage.set(stageId, nextIndex);
    lowLink.set(stageId, nextIndex);
    nextIndex += 1;
    stack.push(stageId);
    onStack.add(stageId);

    for (const target of stageTargets(byId.get(stageId)!)) {
      if (!reachable.has(target)) continue;
      if (!indexByStage.has(target)) {
        visit(target);
        lowLink.set(stageId, Math.min(lowLink.get(stageId)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(stageId, Math.min(lowLink.get(stageId)!, indexByStage.get(target)!));
      }
    }

    if (lowLink.get(stageId) !== indexByStage.get(stageId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === stageId) break;
    }
    components.push(component.sort());
  };

  for (const stageId of [...reachable].sort()) {
    if (!indexByStage.has(stageId)) visit(stageId);
  }
  return components;
}

function cyclicComponents(
  pipeline: PipelineDefinition,
  reachable: ReadonlySet<string>
): PipelineCycleAnalysis[] {
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage]));
  return stronglyConnectedComponents(pipeline, reachable)
    .filter((component) => {
      if (component.length > 1) return true;
      const stage = byId.get(component[0])!;
      return stageTargets(stage).includes(stage.id);
    })
    .map((stageIds) => ({
      stageIds,
      consumesCycle: stageIds.some((stageId) => byId.get(stageId)!.countsIteration),
      // Every stage activation is durably charged by the workflow budget controller.
      consumesWorkflowStep: true as const,
    }));
}

function assertNoApprovalBypass(
  pipeline: PipelineDefinition,
  approvalGateStageIds: ReadonlySet<string>
): void {
  if (approvalGateStageIds.size === 0) return;
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage]));
  const pending: Array<{ stageId: string; approved: boolean }> = [
    {
      stageId: pipeline.startStageId,
      approved: approvalGateStageIds.has(pipeline.startStageId),
    },
  ];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const key = `${current.stageId}:${current.approved ? "1" : "0"}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const target of stageTargets(byId.get(current.stageId)!)) {
      if (target === "SUCCESS" && !current.approved) {
        throw new Error(
          `Pipeline can reach SUCCESS from ${current.stageId} without an approval executor.`
        );
      }
      if (!byId.has(target)) continue;
      pending.push({
        stageId: target,
        approved: current.approved || approvalGateStageIds.has(target),
      });
    }
  }
}

export function compilePipeline(
  input: PipelineDefinition,
  compiledAt = new Date().toISOString()
): CompiledPipeline {
  const pipeline = validatePipeline(clonePipeline(input));
  const reachable = reachableStages(pipeline);
  const unreachable = pipeline.stages
    .map((stage) => stage.id)
    .filter((stageId) => !reachable.has(stageId));
  if (unreachable.length > 0) {
    throw new Error(`Pipeline has unreachable stage(s): ${unreachable.join(", ")}.`);
  }

  const routable = stagesWithTerminalRoute(pipeline);
  const unbounded = [...reachable].filter((stageId) => !routable.has(stageId));
  if (unbounded.length > 0) {
    throw new Error(
      `Pipeline stage(s) have no bounded route to PAUSED, BLOCKED, or SUCCESS: ` +
        `${unbounded.join(", ")}.`
    );
  }

  const terminals = terminalTargetsFromStart(pipeline);
  if (!terminals.has("SUCCESS")) {
    throw new Error("Pipeline start stage cannot reach SUCCESS.");
  }

  for (const stage of pipeline.stages) {
    const executor = executorForStage(pipeline, stage);
    const role = roleForStage(pipeline, stage);
    if (MUTATION_EXECUTORS.has(executor) && READ_ONLY_MODEL_ROLES.has(role.modelRole)) {
      throw new Error(
        `Mutation executor ${executor} on stage ${stage.id} cannot use read-only role ${role.id}.`
      );
    }
  }

  const approvalGateStageIds = new Set(
    pipeline.stages
      .filter((stage) => executorForStage(pipeline, stage) === "approval")
      .map((stage) => stage.id)
  );
  assertNoApprovalBypass(pipeline, approvalGateStageIds);

  const compilation: PipelineCompilation = {
    compilerVersion: 1,
    pipelineHash: pipelineHash(pipeline),
    compiledAt,
    reachableStageIds: [...reachable].sort(),
    approvalGateStageIds: [...approvalGateStageIds].sort(),
    terminalTargets: [...terminals].sort(),
    cyclicComponents: cyclicComponents(pipeline, reachable),
  };
  return {
    pipeline: deepFreeze(pipeline),
    compilation: deepFreeze(compilation),
  };
}

export function verifyCompiledPipeline(
  pipeline: PipelineDefinition,
  compilation: PipelineCompilation
): CompiledPipeline {
  if (compilation.compilerVersion !== 1) {
    throw new Error(`Unsupported pipeline compiler version: ${compilation.compilerVersion}.`);
  }
  const compiled = compilePipeline(pipeline, compilation.compiledAt);
  if (compiled.compilation.pipelineHash !== compilation.pipelineHash) {
    throw new Error(
      `Stored pipeline hash mismatch: expected ${compilation.pipelineHash}, ` +
        `actual ${compiled.compilation.pipelineHash}.`
    );
  }
  return compiled;
}
