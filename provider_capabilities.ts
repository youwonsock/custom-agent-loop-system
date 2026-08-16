export type ProviderAdapter = "opencode" | "kilo" | "codex" | "claude";
export type FilesystemCapability = "enforced" | "best_effort" | "unsupported";
export type McpIsolationCapability = "explicit" | "inherited" | "none";
export type McpToolFilteringCapability = "enforced" | "unsupported";
export type WebSearchMode = "cached" | "live";

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
}

export function assertProviderCapabilities(
  adapter: ProviderAdapter,
  capabilities: ProviderCapabilities,
  request: ProviderCapabilityRequest
): void {
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
  if (capabilities.processContainment !== "supervised_tree") {
    throw new Error(`${adapter} cannot be launched without supervised process-tree containment.`);
  }
  if (capabilities.structuredEvents !== "jsonl") {
    throw new Error(`${adapter} cannot be launched without structured JSONL events.`);
  }
}
