import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_CORE_CAPABILITIES,
  REQUIRED_CORE_PROTOCOL_VERSION,
  validateCoreHandshake,
} from "./coreProtocol";

function validHandshake(): unknown {
  return {
    kind: "agent-loop-capabilities",
    protocolVersion: REQUIRED_CORE_PROTOCOL_VERSION,
    stateSchemaVersion: 2,
    implementationVersion: "test",
    capabilities: [...REQUIRED_CORE_CAPABILITIES],
    roots: {
      codeRoot: "C:\\code",
      configRoot: "C:\\config",
      projectRoot: "C:\\project",
      dataRoot: "C:\\data",
    },
  };
}

test("extension accepts only a matching core protocol and capability set", () => {
  assert.doesNotThrow(() => validateCoreHandshake(validHandshake()));
  assert.throws(
    () => validateCoreHandshake({ ...(validHandshake() as object), protocolVersion: 999 }),
    /protocol mismatch/
  );
  assert.throws(
    () => validateCoreHandshake({ ...(validHandshake() as object), capabilities: [] }),
    /missing required capabilities/
  );
});

