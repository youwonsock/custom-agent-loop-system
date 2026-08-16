import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSecureRemoteMcpTransport,
  namespacedMcpSecretStorageKey,
  protectMcpCredentialValue,
  SecretStorageAdapter,
} from "./mcpSecurityPolicy";

class MemorySecrets implements SecretStorageAdapter {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

test("removed MCP secret namespaces fail instead of being migrated", async () => {
  const storage = new MemorySecrets();
  const removedKey = "agentLoop.mcp.server.headers.removed";
  const currentKey = namespacedMcpSecretStorageKey("root-a", "server", "headers", "Authorization");
  storage.values.set(removedKey, "Bearer removed-token");
  await assert.rejects(
    protectMcpCredentialValue(`\${secret:${removedKey}}`, currentKey, storage),
    /different Agent Loop data root/
  );
  assert.equal(storage.values.get(currentKey), undefined);
});

test("secret keys are isolated across data-root namespaces", () => {
  const rootA = namespacedMcpSecretStorageKey("root-a", "server", "environment", "TOKEN");
  const rootB = namespacedMcpSecretStorageKey("root-b", "server", "environment", "TOKEN");
  assert.notEqual(rootA, rootB);
  assert.match(rootA, /^agentLoop\.mcp\.v2\.root-a\./);
});

test("a namespaced reference copied from another data root is rejected", async () => {
  const storage = new MemorySecrets();
  const currentKey = namespacedMcpSecretStorageKey("root-b", "server", "environment", "TOKEN");
  const foreignKey = namespacedMcpSecretStorageKey("root-a", "server", "environment", "TOKEN");
  await assert.rejects(
    protectMcpCredentialValue(
      `\${secret:${foreignKey}}`,
      currentKey,
      storage
    ),
    /different Agent Loop data root/
  );
});

test("remote MCP credentials require HTTPS except on loopback", () => {
  assert.doesNotThrow(() => assertSecureRemoteMcpTransport("public", "http://example.com/mcp", {}, {}));
  assert.doesNotThrow(() => assertSecureRemoteMcpTransport("secure", "https://example.com/mcp", {}, { Authorization: "x" }));
  assert.doesNotThrow(() => assertSecureRemoteMcpTransport("local", "http://localhost:3000/mcp", {}, { Authorization: "x" }));
  for (const insecure of [
    () => assertSecureRemoteMcpTransport("header", "http://example.com/mcp", {}, { Authorization: "x" }),
    () => assertSecureRemoteMcpTransport("env", "http://example.com/mcp", { TOKEN: "x" }, {}),
    () => assertSecureRemoteMcpTransport("userinfo", "http://user:pass@example.com/mcp", {}, {}),
    () => assertSecureRemoteMcpTransport("query", "http://example.com/mcp?token=x", {}, {}),
  ]) {
    assert.throws(insecure, /must use HTTPS/);
  }
});
