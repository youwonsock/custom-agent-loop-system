import protocolContract from "./protocol_contract.json";
import { RootSet } from "./root_set";

export interface CoreCapabilityHandshake {
  kind: "agent-loop-capabilities";
  protocolVersion: number;
  stateSchemaVersion: number;
  implementationVersion: string;
  capabilities: string[];
  roots: Pick<RootSet, "codeRoot" | "configRoot" | "projectRoot" | "dataRoot">;
}

export const CORE_PROTOCOL_VERSION = protocolContract.protocolVersion;
export const CORE_STATE_SCHEMA_VERSION = protocolContract.stateSchemaVersion;
export const CORE_CAPABILITIES = Object.freeze([...protocolContract.capabilities]);

export function createCoreCapabilityHandshake(roots: RootSet): CoreCapabilityHandshake {
  return {
    kind: "agent-loop-capabilities",
    protocolVersion: CORE_PROTOCOL_VERSION,
    stateSchemaVersion: CORE_STATE_SCHEMA_VERSION,
    implementationVersion: process.env.npm_package_version ?? "7.0.0",
    capabilities: [...CORE_CAPABILITIES],
    roots: {
      codeRoot: roots.codeRoot,
      configRoot: roots.configRoot,
      projectRoot: roots.projectRoot,
      dataRoot: roots.dataRoot,
    },
  };
}

export function validateCoreCapabilityHandshake(
  value: unknown,
  requiredCapabilities: readonly string[] = CORE_CAPABILITIES
): CoreCapabilityHandshake {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Core capability handshake must be an object.");
  }
  const handshake = value as Partial<CoreCapabilityHandshake>;
  if (handshake.kind !== "agent-loop-capabilities") {
    throw new Error("Core capability handshake kind is invalid.");
  }
  if (handshake.protocolVersion !== CORE_PROTOCOL_VERSION) {
    throw new Error(
      `Core protocol mismatch: expected ${CORE_PROTOCOL_VERSION}, received ${String(handshake.protocolVersion)}.`
    );
  }
  if (handshake.stateSchemaVersion !== CORE_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Core state schema mismatch: expected ${CORE_STATE_SCHEMA_VERSION}, received ${String(handshake.stateSchemaVersion)}.`
    );
  }
  if (!Array.isArray(handshake.capabilities)) {
    throw new Error("Core capability handshake is missing capabilities.");
  }
  if (typeof handshake.implementationVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(handshake.implementationVersion)) {
    throw new Error("Core capability handshake implementation version is invalid.");
  }
  const missing = requiredCapabilities.filter(
    (capability) => !handshake.capabilities!.includes(capability)
  );
  if (missing.length > 0) {
    throw new Error(`Core is missing required capabilities: ${missing.join(", ")}.`);
  }
  if (!handshake.roots || typeof handshake.roots !== "object") {
    throw new Error("Core capability handshake is missing RootSet data.");
  }
  return handshake as CoreCapabilityHandshake;
}
