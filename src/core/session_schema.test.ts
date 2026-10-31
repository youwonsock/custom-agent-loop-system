import test from "node:test";
import assert from "node:assert/strict";
import { NativeScopeTracker } from "./native_scope";
import { validProgramIoAudit, validScopeAudit } from "./session_schema";

const programIo = {
  version: 1,
  backend: "apple-container-vm",
  policyId: "policy",
  profileDigest: "digest",
  cwd: "/work",
  preflightPassed: true,
  nativeCommands: 1,
  completedCommands: 1,
  unwrappedCommands: 0,
  unresolvedCommands: 0,
  invalidReceipts: 0,
  runtimeReadRoots: ["/runtime"],
  commands: [
    {
      id: "one",
      command: "cat a",
      exitCode: 0,
      pid: 12,
      processGroupStopped: true,
      containerRemoved: true,
      containerName: "agio-one",
    },
  ],
};
test("saved audits are checked by shape, and optional command fields may be absent", () => {
  assert.ok(validProgramIoAudit(programIo));
  const seatbelt = structuredClone(programIo);
  delete (seatbelt.commands[0] as Partial<(typeof seatbelt.commands)[0]>)
    .containerRemoved;
  delete (seatbelt.commands[0] as Partial<(typeof seatbelt.commands)[0]>)
    .containerName;
  assert.ok(validProgramIoAudit({ ...seatbelt, backend: "macos-seatbelt" }));
  for (const bad of [
    { ...programIo, version: 2 },
    { ...programIo, backend: "other" },
    { ...programIo, invalidReceipts: -1 },
    { ...programIo, preflightPassed: "yes" },
    { ...programIo, commands: [{ id: "one" }] },
    { ...programIo, commands: [{ ...programIo.commands[0], pid: 1.5 }] },
    null,
  ])
    assert.equal(validProgramIoAudit(bad), false);
});
test("the audit a scope tracker produces passes the saved shape", () => {
  const tracker = new NativeScopeTracker("/work", ["/work"]);
  assert.ok(validScopeAudit(tracker.audit));
  assert.equal(validScopeAudit({ ...tracker.audit, outsideCalls: "0" }), false);
  assert.equal(
    validScopeAudit({ ...tracker.audit, violations: [{ tool: "read" }] }),
    false,
  );
  assert.equal(validScopeAudit({ ...tracker.audit, version: 2 }), false);
});
