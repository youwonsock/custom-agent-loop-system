export type ProviderAdapter = "opencode" | "kilo" | "codex" | "claude";
export type FilesystemCapability = "enforced" | "best_effort" | "unsupported";
export type McpIsolationCapability = "explicit" | "inherited" | "none";
export type McpToolFilteringCapability = "enforced" | "unsupported";
export type WebSearchMode = "cached" | "live";
export type ToolsNoneCapability = "verified" | "unverified" | "unsupported";
export type ProviderCapabilityMode = "write" | "read-only" | "tools-none";
export type CapabilityVerificationStatus = "verified" | "unverified" | "unsupported";

/**
 * A capability decision is tied to the adapter implementation, the exact CLI
 * version observed by the core, and the host platform.  Adapter profiles alone
 * are intentionally insufficient for a tool-free recovery launch.
 */
export interface ProviderCapabilityEnvironment {
  cliVersion?: string | null;
  platform?: NodeJS.Platform;
  architecture?: string;
}

export interface ProviderCapabilityStatus {
  adapter: ProviderAdapter;
  mode: ProviderCapabilityMode;
  status: CapabilityVerificationStatus;
  cliVersion: string | null;
  expectedCliVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  key: string;
  reason: string;
}

interface VerifiedProviderCombination {
  cliVersion: string;
  platforms: readonly NodeJS.Platform[];
  architectures: readonly string[];
  modes: Readonly<Record<ProviderCapabilityMode, CapabilityVerificationStatus>>;
}

/**
 * These are the exact CLI versions exercised by the protected conformance
 * workflow.  Updating one requires changing the workflow pin and collecting
 * fresh evidence for every OS cell; an unlisted version is never promoted to
 * a verified tool-free capability by configuration alone.
 */
export const VERIFIED_PROVIDER_COMBINATIONS: Readonly<
  Record<ProviderAdapter, Readonly<VerifiedProviderCombination>>
> = Object.freeze({
  opencode: Object.freeze({
    cliVersion: "1.18.14",
    platforms: Object.freeze(["win32", "linux", "darwin"] as NodeJS.Platform[]),
    architectures: Object.freeze(["x64", "arm64"]),
    modes: Object.freeze({ write: "verified", "read-only": "verified", "tools-none": "verified" }),
  }),
  kilo: Object.freeze({
    cliVersion: "7.3.54",
    platforms: Object.freeze(["win32", "linux", "darwin"] as NodeJS.Platform[]),
    architectures: Object.freeze(["x64", "arm64"]),
    modes: Object.freeze({ write: "verified", "read-only": "verified", "tools-none": "verified" }),
  }),
  codex: Object.freeze({
    cliVersion: "0.146.1",
    platforms: Object.freeze(["win32", "linux", "darwin"] as NodeJS.Platform[]),
    architectures: Object.freeze(["x64", "arm64"]),
    // The pinned Codex CLI has no conformance-proven way to remove every
    // built-in tool. Its format recovery remains fail-closed on every OS.
    modes: Object.freeze({ write: "verified", "read-only": "verified", "tools-none": "unverified" }),
  }),
  claude: Object.freeze({
    cliVersion: "2.1.233",
    platforms: Object.freeze(["win32", "linux", "darwin"] as NodeJS.Platform[]),
    architectures: Object.freeze(["x64", "arm64"]),
    modes: Object.freeze({ write: "verified", "read-only": "verified", "tools-none": "verified" }),
  }),
});

function normalizedCliVersion(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/(?:^|[^0-9])(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?(?=$|[^0-9])/u);
  return match?.[1] ?? null;
}

/** Resolve one exact adapter/version/OS/architecture capability cell. */
export function resolveProviderCapability(
  adapter: ProviderAdapter,
  mode: ProviderCapabilityMode,
  environment: Readonly<ProviderCapabilityEnvironment> = {}
): ProviderCapabilityStatus {
  const combination = VERIFIED_PROVIDER_COMBINATIONS[adapter];
  const platform = environment.platform ?? process.platform;
  const architecture = environment.architecture ?? process.arch;
  const cliVersion = normalizedCliVersion(environment.cliVersion);
  const key = `${adapter}:${cliVersion ?? "unknown"}:${platform}:${architecture}:${mode}`;
  if (!combination.platforms.includes(platform) || !combination.architectures.includes(architecture)) {
    return {
      adapter,
      mode,
      status: "unsupported",
      cliVersion,
      expectedCliVersion: combination.cliVersion,
      platform,
      architecture,
      key,
      reason: `${adapter} has no verified capability matrix entry for ${platform}-${architecture}.`,
    };
  }
  const declared = combination.modes[mode];
  if (declared === "unsupported") {
    return {
      adapter,
      mode,
      status: "unsupported",
      cliVersion,
      expectedCliVersion: combination.cliVersion,
      platform,
      architecture,
      key,
      reason: `${adapter} does not support ${mode} on ${platform}-${architecture}.`,
    };
  }
  if (declared === "unverified") {
    return {
      adapter,
      mode,
      status: "unverified",
      cliVersion,
      expectedCliVersion: combination.cliVersion,
      platform,
      architecture,
      key,
      reason: `${adapter} has no conformance-verified ${mode} capability for ${platform}-${architecture}.`,
    };
  }
  if (!cliVersion) {
    return {
      adapter,
      mode,
      status: "unverified",
      cliVersion: null,
      expectedCliVersion: combination.cliVersion,
      platform,
      architecture,
      key,
      reason: `${adapter} ${mode} requires an exact CLI version, but the core could not determine one.`,
    };
  }
  if (cliVersion !== combination.cliVersion) {
    return {
      adapter,
      mode,
      status: "unverified",
      cliVersion,
      expectedCliVersion: combination.cliVersion,
      platform,
      architecture,
      key,
      reason: `${adapter} ${mode} is verified for CLI ${combination.cliVersion}, not ${cliVersion}.`,
    };
  }
  return {
    adapter,
    mode,
    status: "verified",
    cliVersion,
    expectedCliVersion: combination.cliVersion,
    platform,
    architecture,
    key,
    reason: `${adapter} ${mode} is verified for CLI ${cliVersion} on ${platform}-${architecture}.`,
  };
}

/**
 * Security-relevant behavior supplied by an adapter implementation.
 *
 * These values are code-owned facts, not user-owned configuration. A persisted
 * provider entry may display the profile, but normalization always replaces it
 * with the profile for the selected adapter so configuration cannot escalate an
 * adapter's authority.
 */
export interface ProviderCapabilities {
  readOnlyFilesystem: FilesystemCapability;
  workspaceWrites: FilesystemCapability;
  additionalRoots: FilesystemCapability;
  fullAccess: boolean;
  resumeSession: boolean;
  webSearchModes: WebSearchMode[];
  mcpIsolation: McpIsolationCapability;
  readOnlyMcpToolFiltering: McpToolFilteringCapability;
  processContainment: "supervised_tree";
  structuredEvents: "jsonl";
  toolsNone: ToolsNoneCapability;
}

const TRUSTED_PROVIDER_CAPABILITIES: Readonly<Record<ProviderAdapter, Readonly<ProviderCapabilities>>> = {
  opencode: Object.freeze<ProviderCapabilities>({
    readOnlyFilesystem: "enforced",
    workspaceWrites: "enforced",
    additionalRoots: "enforced",
    fullAccess: true,
    resumeSession: true,
    webSearchModes: ["live"],
    // Runtime config can add servers, but does not prove that user/project MCP
    // configuration is absent. Read-only roles therefore receive no MCP tools.
    mcpIsolation: "inherited",
    readOnlyMcpToolFiltering: "unsupported",
    processContainment: "supervised_tree",
    structuredEvents: "jsonl",
    toolsNone: "verified",
  }),
  kilo: Object.freeze<ProviderCapabilities>({
    // Enforced by selecting the runtime-owned agent-loop-readonly agent. A
    // top-level KILO_CONFIG_CONTENT permission document alone is insufficient
    // because Kilo merges selected-agent permissions afterward.
    readOnlyFilesystem: "enforced",
    workspaceWrites: "enforced",
    additionalRoots: "enforced",
    fullAccess: true,
    resumeSession: true,
    webSearchModes: ["live"],
    mcpIsolation: "inherited",
    readOnlyMcpToolFiltering: "unsupported",
    processContainment: "supervised_tree",
    structuredEvents: "jsonl",
    toolsNone: "verified",
  }),
  codex: Object.freeze<ProviderCapabilities>({
    // Read-only launches explicitly ignore user config, mark every possible
    // project root untrusted, ignore exec-policy rules, and select Codex's
    // native read-only sandbox. Runtime MCP is also withheld for these roles.
    readOnlyFilesystem: "enforced",
    workspaceWrites: "enforced",
    additionalRoots: "enforced",
    fullAccess: true,
    resumeSession: true,
    webSearchModes: ["cached", "live"],
    mcpIsolation: "inherited",
    readOnlyMcpToolFiltering: "unsupported",
    processContainment: "supervised_tree",
    structuredEvents: "jsonl",
    // Codex exposes no stable CLI switch that disables its built-in tools
    // across the supported version/OS matrix. Keep tool-free formatting
    // recovery fail-closed until an authenticated conformance run proves the
    // exact adapter/CLI/OS combination.
    toolsNone: "unverified",
  }),
  claude: Object.freeze<ProviderCapabilities>({
    readOnlyFilesystem: "enforced",
    workspaceWrites: "best_effort",
    additionalRoots: "enforced",
    fullAccess: true,
    resumeSession: true,
    webSearchModes: ["live"],
    mcpIsolation: "explicit",
    readOnlyMcpToolFiltering: "enforced",
    processContainment: "supervised_tree",
    structuredEvents: "jsonl",
    toolsNone: "verified",
  }),
};

export function capabilitiesForAdapter(adapter: ProviderAdapter): ProviderCapabilities {
  const trusted = TRUSTED_PROVIDER_CAPABILITIES[adapter];
  return {
    ...trusted,
    webSearchModes: [...trusted.webSearchModes],
  };
}

export interface ProviderCapabilityRequest {
  readOnly: boolean;
  fullAccess: boolean;
  hasAdditionalRoots: boolean;
  resumeSession: boolean;
  webSearch: boolean;
  webSearchMode: WebSearchMode;
  hasMcpServers: boolean;
  toolsNone?: boolean;
  /** Exact capability decision collected before a tool-free launch. */
  toolsNoneCapability?: ProviderCapabilityStatus;
}

export function assertProviderCapabilities(
  adapter: ProviderAdapter,
  capabilities: ProviderCapabilities,
  request: ProviderCapabilityRequest
): void {
  const suppliedToolsNone = request.toolsNoneCapability;
  const resolvedToolsNone = suppliedToolsNone
    ? resolveProviderCapability(adapter, "tools-none", {
        cliVersion: suppliedToolsNone.cliVersion,
        platform: process.platform,
        architecture: process.arch,
      })
    : null;
  if (request.readOnly && capabilities.readOnlyFilesystem !== "enforced") {
    throw new Error(
      `${adapter} read-only roles are unsupported: an enforceable read-only filesystem ` +
      "and isolated inherited tool configuration are required."
    );
  }
  if (!request.readOnly && capabilities.workspaceWrites === "unsupported") {
    throw new Error(`${adapter} cannot run a mutation-capable role because workspace writes are unsupported.`);
  }
  if (request.hasAdditionalRoots && capabilities.additionalRoots === "unsupported") {
    throw new Error(`${adapter} cannot enforce access to additional project roots.`);
  }
  if (request.fullAccess && !request.readOnly && !capabilities.fullAccess) {
    throw new Error(`${adapter} does not support the requested full-access mode.`);
  }
  if (request.resumeSession && !capabilities.resumeSession) {
    throw new Error(`${adapter} does not support resuming a provider session.`);
  }
  if (request.webSearch && !capabilities.webSearchModes.includes(request.webSearchMode)) {
    throw new Error(
      `${adapter} does not support ${request.webSearchMode} web search; supported modes: ` +
      `${capabilities.webSearchModes.join(", ") || "none"}.`
    );
  }
  if (request.hasMcpServers && capabilities.mcpIsolation === "none") {
    throw new Error(`${adapter} cannot receive MCP servers because it has no enforceable MCP boundary.`);
  }
  if (
    request.toolsNone &&
    (capabilities.toolsNone !== "verified" ||
      request.readOnly !== true ||
      request.fullAccess === true ||
      request.hasMcpServers === true ||
      request.webSearch === true ||
      request.toolsNoneCapability?.status !== "verified" ||
      request.toolsNoneCapability.adapter !== adapter ||
      request.toolsNoneCapability.mode !== "tools-none" ||
      request.toolsNoneCapability.platform !== process.platform ||
      request.toolsNoneCapability.architecture !== process.arch ||
      request.toolsNoneCapability.cliVersion !== request.toolsNoneCapability.expectedCliVersion ||
      request.toolsNoneCapability.key !==
        `${adapter}:${request.toolsNoneCapability.cliVersion ?? "unknown"}:${process.platform}:${process.arch}:tools-none` ||
      resolvedToolsNone?.status !== "verified" ||
      resolvedToolsNone.key !== request.toolsNoneCapability.key)
  ) {
    const detail = request.toolsNoneCapability?.reason;
    throw new Error(
      `${adapter} cannot start a tool-free invocation without a verified tools-none capability.` +
      (detail ? ` ${detail}` : "")
    );
  }
  if (capabilities.processContainment !== "supervised_tree") {
    throw new Error(`${adapter} cannot be launched without supervised process-tree containment.`);
  }
  if (capabilities.structuredEvents !== "jsonl") {
    throw new Error(`${adapter} cannot be launched without structured JSONL events.`);
  }
}
