import type { JsonSchema } from "../../definitions/json-schema";
import { SchemaRegistry } from "../../definitions/registries";

const requirementEvidence: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requirementId", "status", "evidence"],
  properties: {
    requirementId: { type: "string", minLength: 1, maxLength: 128 },
    status: { enum: ["satisfied", "unsatisfied", "unknown"] },
    evidence: { type: "string", minLength: 1, maxLength: 8_000 },
    artifactIds: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
};

export const TASK_RESULT_ENVELOPE_SCHEMA: JsonSchema = {
  $id: "task_result_envelope.v1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "signal", "summary", "requirementEvidence", "payload"],
  properties: {
    schemaVersion: { const: 1 },
    signal: { type: "string", minLength: 1, maxLength: 128 },
    summary: { type: "string", minLength: 1, maxLength: 4_096 },
    requirementEvidence: {
      type: "array",
      maxItems: 200,
      items: requirementEvidence,
    },
    payload: {},
  },
};

const requirementList: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "text"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 128 },
      text: { type: "string", minLength: 1, maxLength: 8_000 },
    },
  },
};

const commonInputProperties: Record<string, JsonSchema> = {
  goal: { type: "string", minLength: 1, maxLength: 100_000 },
  requirements: requirementList,
  approved_plan: {},
  selected_plan_choice_id: { type: ["string", "null"] },
  target_project_path: { type: "string", minLength: 1 },
  additional_allowed_paths: {
    type: "array",
    maxItems: 64,
    items: { type: "string", minLength: 1 },
  },
  planning_output: {},
  plan_approval: {},
  implementation_output: {},
  test_output: {},
  review_output: {},
  failure: {},
  recovery: {},
  verification_contract: {},
  verification_result: {},
  verification_feedback: {},
  verification_criteria_changes: {},
  previous_cycle_feedback: {},
  open_findings: {},
  planning_feedback: {},
};

function inputSchema(required: string[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties: commonInputProperties,
  };
}

const verificationCommand: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "executable", "args", "cwd", "timeoutMs", "requirementIds"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    label: { type: "string", minLength: 1, maxLength: 500 },
    executable: { type: "string", minLength: 1, maxLength: 4096 },
    args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 8192 } },
    cwd: { type: "string", minLength: 1, maxLength: 4096 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 86400000 },
    requirementIds: { type: "array", minItems: 1, uniqueItems: true, maxItems: 200, items: { type: "string", minLength: 1, maxLength: 128 } },
  },
};

const planChoice: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "plan", "requirementCoverage"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    title: { type: "string", minLength: 1, maxLength: 500 },
    plan: { type: "string", minLength: 1, maxLength: 200_000 },
    requirementCoverage: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 128 },
    },
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["commands", "totalTimeoutMs", "protectedPaths", "testRoots", "allowedNewTestRoots", "generatedOutputPaths"],
      properties: {
        commands: { type: "array", minItems: 1, maxItems: 10, items: verificationCommand },
        totalTimeoutMs: { type: "integer", minimum: 1 },
        protectedPaths: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4096 } },
        testRoots: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4096 } },
        allowedNewTestRoots: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4096 } },
        generatedOutputPaths: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4096 } },
      },
    },
  },
};

const planChoiceV2: JsonSchema = {
  ...planChoice,
  required: ["id", "title", "plan", "requirementCoverage", "verification"],
};

const commandObservation: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "exitCode", "summary"],
  properties: {
    command: { type: "string", minLength: 1, maxLength: 8_000 },
    exitCode: { type: "integer" },
    summary: { type: "string", minLength: 1, maxLength: 8_000 },
  },
};

export function createDefaultSchemaRegistry(): SchemaRegistry {
  const registry = new SchemaRegistry();
  registry.register("task_result_envelope.v1", TASK_RESULT_ENVELOPE_SCHEMA);
  registry.register(
    "task_input.produce_plan.v1",
    inputSchema(["goal", "requirements", "target_project_path"])
  );
  registry.register(
    "task_input.implement_changes.v1",
    inputSchema([
      "goal",
      "requirements",
      "approved_plan",
      "plan_approval",
      "target_project_path",
      "additional_allowed_paths",
    ])
  );
  registry.register(
    "task_input.run_tests.v1",
    inputSchema(["goal", "requirements", "implementation_output", "target_project_path"])
  );
  registry.register(
    "task_input.audit_quality.v1",
    inputSchema(["goal", "requirements", "implementation_output", "test_output"])
  );
  registry.register(
    "task_input.approve_completion.v1",
    inputSchema([
      "goal",
      "requirements",
      "implementation_output",
      "test_output",
      "review_output",
    ])
  );
  registry.register(
    "task_input.analyze_interrupt.v1",
    inputSchema(["goal", "failure", "recovery"])
  );
  registry.register("task_result.produce_plan.v1", {
    type: "object",
    additionalProperties: false,
    required: ["choices"],
    properties: {
      choices: { type: "array", minItems: 1, maxItems: 10, items: planChoice },
    },
  });
  registry.register("task_result.implement_changes.v1", {
    type: "object",
    additionalProperties: false,
    required: ["changedFiles", "verification", "notes"],
    properties: {
      changedFiles: {
        type: "array",
        maxItems: 1_000,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      verification: {
        type: "array",
        maxItems: 200,
        items: commandObservation,
      },
      notes: { type: "string", maxLength: 20_000 },
    },
  });
  registry.register("task_result.run_tests.v1", {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "commands", "failures"],
    properties: {
      verdict: { enum: ["pass", "fail"] },
      commands: { type: "array", minItems: 1, maxItems: 200, items: commandObservation },
      failures: {
        type: "array",
        maxItems: 200,
        items: { type: "string", minLength: 1, maxLength: 8_000 },
      },
    },
  });
  const auditResult: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["decision", "findings"],
    properties: {
      decision: { enum: ["approved", "rejected"] },
      findings: {
        type: "array",
        maxItems: 200,
        items: { type: "string", minLength: 1, maxLength: 8_000 },
      },
      proofId: { type: "string", minLength: 1, maxLength: 256 },
      contractRevision: { type: "integer", minimum: 1 },
      resolvedFindingIds: {
        type: "array",
        maxItems: 200,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 256 },
      },
      rationale: { type: "string", maxLength: 20_000 },
    },
  };
  registry.register("task_result.audit_quality.v1", auditResult);
  registry.register("task_result.approve_completion.v1", {
    ...auditResult,
    properties: {
      ...auditResult.properties,
      rationale: { type: "string", minLength: 1, maxLength: 20_000 },
    },
    required: ["decision", "findings", "rationale"],
  });
  registry.register("task_result.analyze_interrupt.v1", {
    type: "object",
    additionalProperties: false,
    required: ["briefing", "facts", "recoveryAction"],
    properties: {
      briefing: { type: "string", minLength: 1, maxLength: 20_000 },
      facts: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 8_000 },
      },
      recoveryAction: { type: "string", minLength: 1, maxLength: 8_000 },
    },
  });

  // v2 task contracts carry the verification draft and feedback explicitly.
  // The v1 registrations above remain available for the stable envelope parser;
  // the shipped v8 task definitions reference only these v2 contracts, and a
  // model still cannot manufacture a verification proof.
  registry.register("task_input.produce_plan.v2", inputSchema(["goal", "requirements", "target_project_path"]));
  registry.register("task_input.implement_changes.v2", inputSchema([
    "goal", "requirements", "approved_plan", "plan_approval", "target_project_path", "additional_allowed_paths",
  ]));
  registry.register("task_input.run_tests.v2", inputSchema([
    "goal", "requirements", "implementation_output", "target_project_path", "verification_contract", "verification_feedback", "open_findings",
  ]));
  registry.register("task_input.audit_quality.v2", inputSchema([
    "goal", "requirements", "implementation_output", "test_output", "verification_contract", "verification_result", "open_findings",
  ]));
  registry.register("task_input.approve_completion.v2", inputSchema([
    "goal", "requirements", "implementation_output", "test_output", "review_output", "verification_contract", "verification_result", "open_findings",
  ]));
  registry.register("task_input.analyze_interrupt.v2", inputSchema(["goal", "failure", "recovery", "verification_feedback", "open_findings"]));
  registry.register("task_result.produce_plan.v2", {
    type: "object",
    additionalProperties: false,
    required: ["choices"],
    properties: { choices: { type: "array", minItems: 1, maxItems: 10, items: planChoiceV2 } },
  });
  registry.register("task_result.implement_changes.v2", {
    type: "object",
    additionalProperties: false,
    required: ["changedFiles", "notes"],
    properties: {
      changedFiles: { type: "array", maxItems: 1_000, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4_096 } },
      notes: { type: "string", maxLength: 20_000 },
    },
  });
  registry.register("task_result.run_tests.v2", {
    type: "object",
    additionalProperties: false,
    required: ["changedFiles", "issues", "verificationCriteriaChanges"],
    properties: {
      changedFiles: { type: "array", maxItems: 1_000, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4_096 } },
      issues: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 8_000 } },
      verificationCriteriaChanges: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 8_000 } },
    },
  });
  const approvalV2: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["decision", "findings", "proofId", "contractRevision", "resolvedFindingIds", "rationale"],
    properties: {
      decision: { enum: ["approved", "rejected"] },
      findings: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 8_000 } },
      proofId: { type: "string", minLength: 1, maxLength: 256 },
      contractRevision: { type: "integer", minimum: 1 },
      resolvedFindingIds: { type: "array", maxItems: 200, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
      rationale: { type: "string", minLength: 1, maxLength: 20_000 },
    },
  };
  registry.register("task_result.audit_quality.v2", approvalV2);
  registry.register("task_result.approve_completion.v2", approvalV2);
  registry.register("task_result.analyze_interrupt.v2", {
    type: "object",
    additionalProperties: false,
    required: ["briefing", "facts", "recoveryAction"],
    properties: {
      briefing: { type: "string", minLength: 1, maxLength: 20_000 },
      facts: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 8_000 },
      },
      recoveryAction: { type: "string", minLength: 1, maxLength: 8_000 },
    },
  });
  return registry;
}
