import { ProviderConfig } from "./provider_runtime";
import { LoopStatus } from "./workflow_contracts";

export interface SessionMeta {
  sessionId: string;
  goal: string;
  targetProjectPath: string;
  status: LoopStatus;
  createdAt: string;
}

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  adapter: ProviderConfig["adapter"];
  binary: string;
  enabled: boolean;
  available: boolean;
  models: string[];
  modelLabels?: Record<string, string>;
  modelVariants?: Record<string, string[]>;
  discoveredAt: string | null;
  error: string | null;
}

export interface SessionRegistry {
  version: number;
  activeSessionIds: string[];
  availableModels: string[];
  modelsDiscoveredAt: string | null;
  modelsDiscoveredCli: string | null;
  sessionMetas: SessionMeta[];
  manualModelsOverride: string[] | null;
  modelVariants: Record<string, string[]> | null;
  providerCatalog?: Record<string, ProviderCatalogEntry>;
}

export interface SessionMetaPatch {
  sessionId: string;
  goal?: string;
  targetProjectPath?: string;
  status?: LoopStatus;
  createdAt?: string;
}

