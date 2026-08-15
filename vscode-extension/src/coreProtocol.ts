import protocolContract from "./generated_protocol_contract.json";

export interface CoreCapabilityHandshake {
  kind: "agent-loop-capabilities";
  protocolVersion: number;
  stateSchemaVersion: number;
  implementationVersion: string;
  capabilities: string[];
  roots: {
    codeRoot: string;
    configRoot: string;
    projectRoot: string;
    dataRoot: string;
  };
}

export const REQUIRED_CORE_PROTOCOL_VERSION = protocolContract.protocolVersion;
export const REQUIRED_CORE_CAPABILITIES = Object.freeze([
  ...protocolContract.capabilities,
]);

export function validateCoreHandshake(value: unknown): CoreCapabilityHandshake {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Loop core returned an invalid capability handshake.");
  }
  const handshake = value as Partial<CoreCapabilityHandshake>;
  if (handshake.kind !== "agent-loop-capabilities") {
    throw new Error("Agent Loop core capability handshake kind is invalid.");
  }
  if (handshake.protocolVersion !== REQUIRED_CORE_PROTOCOL_VERSION) {
    throw new Error(
      `Agent Loop core protocol mismatch: extension requires ${REQUIRED_CORE_PROTOCOL_VERSION}, ` +
      `core reported ${String(handshake.protocolVersion)}.`
    );
  }
  if (!Array.isArray(handshake.capabilities)) {
    throw new Error("Agent Loop core did not report capabilities.");
  }
  const missing = REQUIRED_CORE_CAPABILITIES.filter(
    (capability) => !handshake.capabilities!.includes(capability)
  );
  if (missing.length > 0) {
    throw new Error(`Agent Loop core is missing required capabilities: ${missing.join(", ")}.`);
  }
  return handshake as CoreCapabilityHandshake;
}

