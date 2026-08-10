import { createHash } from "node:crypto";

export const SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/;
export const ENV_REFERENCE = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

export type McpSecretScope = "environment" | "headers";

export interface SecretStorageAdapter {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

function fieldDigest(fieldName: string): string {
  return createHash("sha256").update(fieldName).digest("hex").slice(0, 24);
}

export function legacyMcpSecretStorageKey(
  serverId: string,
  scope: McpSecretScope,
  fieldName: string
): string {
  return `agentLoop.mcp.${serverId}.${scope}.${fieldDigest(fieldName)}`;
}

export function namespacedMcpSecretStorageKey(
  namespace: string,
  serverId: string,
  scope: McpSecretScope,
  fieldName: string
): string {
  return `agentLoop.mcp.v2.${namespace}.${serverId}.${scope}.${fieldDigest(fieldName)}`;
}

export async function protectMcpCredentialValue(
  value: string,
  currentKey: string,
  legacyKey: string,
  storage?: SecretStorageAdapter
): Promise<string> {
  if (ENV_REFERENCE.test(value)) return value;
  const secretReference = value.match(SECRET_REFERENCE)?.[1];
  if (secretReference) {
    if (secretReference !== currentKey && secretReference !== legacyKey) {
      if (secretReference.startsWith("agentLoop.mcp.")) {
        throw new Error(
          "MCP credential reference belongs to a different Agent Loop data root. Re-enter the credential."
        );
      }
      return value;
    }
    if (!storage) {
      return value;
    }
    let storedValue = await storage.get(currentKey);
    if (storedValue === undefined) {
      storedValue = await storage.get(legacyKey);
      if (storedValue !== undefined) await storage.store(currentKey, storedValue);
    }
    if (storedValue === undefined && secretReference === legacyKey) return value;
    return `\${secret:${currentKey}}`;
  }
  if (!storage) {
    throw new Error("VS Code SecretStorage is unavailable; MCP credentials cannot be saved safely.");
  }
  await storage.store(currentKey, value);
  return `\${secret:${currentKey}}`;
}

export function assertSecureRemoteMcpTransport(
  serverId: string,
  url: string | undefined,
  environment: Record<string, string> | undefined,
  headers: Record<string, string> | undefined
): void {
  let remoteUrl: URL;
  try {
    remoteUrl = new URL(url ?? "");
  } catch {
    throw new Error(`Remote MCP server ${serverId} needs a valid http(s) URL.`);
  }
  if (remoteUrl.protocol !== "http:" && remoteUrl.protocol !== "https:") {
    throw new Error(`Remote MCP server ${serverId} needs an http(s) URL.`);
  }
  const hostname = remoteUrl.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "[::1]" || hostname === "::1";
  const credentialBearing = Boolean(
    remoteUrl.username || remoteUrl.password || remoteUrl.search ||
    Object.keys(environment ?? {}).length || Object.keys(headers ?? {}).length
  );
  if (credentialBearing && remoteUrl.protocol !== "https:" && !loopback) {
    throw new Error(
      `Credential-bearing remote MCP server ${serverId} must use HTTPS (HTTP is allowed only for localhost).`
    );
  }
}
