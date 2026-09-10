import type {
  ProviderAdapter,
  ProviderCapabilityMode,
  ProviderCapabilityStatus,
} from "../../../provider_capabilities";

/** Runtime-owned evidence for an adapter/CLI/OS capability lookup. */
export interface ProviderCapabilityDecision extends ProviderCapabilityStatus {
  /** Absolute executable or command-shim path inspected by the core. */
  resolvedBinary: string | null;
  /** Bounded diagnostic when the version probe could not complete. */
  diagnostic: string | null;
}

export interface ProviderCapabilityRuntimePort {
  inspect(
    adapter: ProviderAdapter,
    binary: string,
    mode: ProviderCapabilityMode
  ): Promise<ProviderCapabilityDecision>;
}
