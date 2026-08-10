import test from "node:test";
import assert from "node:assert/strict";
import {
  activationSideEffectsAllowed,
  launchTrusted,
  WorkspaceProcessLaunch,
} from "./workspaceExecutionPolicy";

test("untrusted activation disables initialization and recovery side effects", () => {
  let activationSideEffects = 0;
  if (activationSideEffectsAllowed(false)) activationSideEffects += 1;
  assert.equal(activationSideEffects, 0);
});

test("every external process launch kind is fail-closed with spawn count zero", () => {
  const launchKinds: WorkspaceProcessLaunch[] = [
    "discoverModels",
    "newSession",
    "resumeSession",
    "recoverSession",
    "revisePlan",
  ];
  let spawnCount = 0;
  for (const launchKind of launchKinds) {
    assert.throws(
      () => launchTrusted(false, launchKind, () => {
        spawnCount += 1;
        return {};
      }),
      /untrusted workspace/
    );
  }
  assert.equal(spawnCount, 0);
});

test("trusted launch invokes the process seam exactly once", () => {
  let spawnCount = 0;
  const result = launchTrusted(true, "newSession", () => {
    spawnCount += 1;
    return "spawned";
  });
  assert.equal(result, "spawned");
  assert.equal(spawnCount, 1);
});
