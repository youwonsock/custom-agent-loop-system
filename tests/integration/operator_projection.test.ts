import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptySessionIndexProjection,
  createOperatorSnapshotV3,
  emptyOperatorSnapshot,
  validateOperatorSnapshotV3,
  validateProviderDiscoveryResultV2,
  validateRunProjectionV2,
  validateSessionIndexProjectionV4,
} from "../../src/interfaces/operator/contracts";
import type { ProviderDiscoveryResultV2, RunProjectionV2 } from "../../src/interfaces/operator/contracts";

const projection: RunProjectionV2 = {
  projectionSchemaVersion: 2,
  stateVersion: 5,
  sessionId: "run_test",
  runId: "run_test",
  definitionHash: "hash",
  revision: 2,
  fencingEpoch: 1,
  status: "RUNNING",
  statusReason: null,
  phase: "planning",
  currentNodeId: "planner",
  currentAgentId: "planner",
  activeActivation: null,
  pendingInput: null,
  goal: "Test projection",
  targetProjectPath: "C:\\repo",
  additionalAllowedPaths: [],
  accessMode: "ask",
  awaitingPlanApproval: false,
  planApproved: false,
  selectedPlanChoiceId: null,
  planChoices: [],
  interruptBriefing: null,
  requirements: [],
  requirementEvidence: [],
  verification: { contract: null, elapsedMs: 0, contractRevision: null, contractHash: null, currentVerificationId: null, currentCommandId: null, completedCommands: 0, commandCount: 0, proofId: null, proofValid: false, pendingApproval: null, invalidationReason: null, commands: [] },
  budgets: {
    workflowSteps: { consumed: 0, limit: 10, remaining: 10 },
    cycles: { consumed: 0, completed: 0, limit: 3, remaining: 3 },
  },
  latestEvent: null,
  events: [],
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

test("current projection and snapshot contracts validate only v2/v3 wire shapes", () => {
  assert.equal(validateRunProjectionV2(projection), projection);
  assert.throws(() => validateRunProjectionV2({ ...projection, projectionSchemaVersion: 1, stateVersion: 4 }), /schema 2 and state schema 5/);
  const snapshot = createOperatorSnapshotV3({
    projection,
    sessionIndex: createEmptySessionIndexProjection(),
    settings: null,
    providerDiscovery: [],
    capturedAt: "2026-08-31T00:00:00.000Z",
  });
  assert.equal(validateOperatorSnapshotV3(snapshot), snapshot);
  assert.equal(emptyOperatorSnapshot().schemaVersion, 3);
  assert.throws(() => validateOperatorSnapshotV3({ ...snapshot, schemaVersion: 2 }), /version 3/);
});

test("operator contracts validate provider discovery and strict session index fields", () => {
  const discovery: ProviderDiscoveryResultV2 = {
    schemaVersion: 2, providerId: "opencode", label: "OpenCode", adapter: "opencode", binary: "opencode",
    enabled: true, available: true, models: ["model-a"], discoveredAt: "2026-08-31T00:00:00.000Z",
    command: "opencode models", catalogSource: "command", error: null,
  };
  assert.equal(validateProviderDiscoveryResultV2(discovery), discovery);
  assert.throws(() => validateProviderDiscoveryResultV2({ ...discovery, adapter: "codex", catalogSource: "command" }), /configured catalog/u);
  const index = createEmptySessionIndexProjection();
  assert.equal(validateSessionIndexProjectionV4(index), index);
  assert.throws(() => validateSessionIndexProjectionV4({ ...index, modelsDiscoveredAt: undefined }), /string or null/u);
  assert.throws(() => validateSessionIndexProjectionV4({ ...index, activeSessionIds: ["bad id"] }), /unsafe/u);
  assert.throws(() => validateSessionIndexProjectionV4({ ...index, activeSessionIds: ["run-1"] }), /corresponding/u);
  assert.throws(() => validateSessionIndexProjectionV4({ ...index, availableModels: [""] }), /empty model/u);
  assert.throws(() => validateSessionIndexProjectionV4({ ...index, manualModelsOverride: {} }), /must be null/u);
});
