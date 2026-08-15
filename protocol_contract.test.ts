import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_CAPABILITIES,
  CORE_PROTOCOL_VERSION,
  createCoreCapabilityHandshake,
  validateCoreCapabilityHandshake,
} from "./protocol_contract";

const roots = {
  codeRoot: "/code",
  configRoot: "/config",
  projectRoot: "/project",
  dataRoot: "/data",
  legacyRoot: null,
  warnings: [],
};

test("core handshake exposes the shared protocol, roots, and required capabilities", () => {
  const handshake = createCoreCapabilityHandshake(roots);
  assert.equal(handshake.protocolVersion, CORE_PROTOCOL_VERSION);
  assert.deepEqual(handshake.capabilities, CORE_CAPABILITIES);
  assert.deepEqual(validateCoreCapabilityHandshake(handshake), handshake);
});

test("core handshake rejects protocol and capability mismatches", () => {
  const handshake = createCoreCapabilityHandshake(roots);
  assert.throws(
    () => validateCoreCapabilityHandshake({ ...handshake, protocolVersion: 999 }),
    /protocol mismatch/
  );
  assert.throws(
    () => validateCoreCapabilityHandshake({ ...handshake, capabilities: [] }),
    /missing required capabilities/
  );
});

