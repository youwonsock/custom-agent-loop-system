import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  REFERENCE_DISCOVERY_TOOL_NAME,
  DEFAULT_VISUAL_RESEARCH_MODEL,
  VISUAL_RESEARCH_MCP_SERVER_ID,
  VISUAL_RESEARCH_TOOL_NAME,
  buildReferenceDiscoveryQueries,
  createVisualResearchMcpServer,
  detectImageType,
  extractVisualAssistantText,
  isPublicIpAddress,
  parseYahooReferenceSearchResults,
  validateRemoteImageUrlSyntax,
} from "./visual_research_mcp";

test("visual research SSRF policy accepts public addresses and rejects local or reserved ranges", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "198.51.100.4",
    "203.0.113.9",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002:7f00:1::",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }

  assert.equal(
    validateRemoteImageUrlSyntax("https://images.example.com/screenshot.png#preview").toString(),
    "https://images.example.com/screenshot.png"
  );
  assert.throws(() => validateRemoteImageUrlSyntax("http://images.example.com/a.png"), /HTTPS/);
  assert.throws(() => validateRemoteImageUrlSyntax("https://localhost/a.png"), /Local or internal/);
  assert.throws(() => validateRemoteImageUrlSyntax("https://127.0.0.1/a.png"), /Private or reserved/);
  assert.throws(() => validateRemoteImageUrlSyntax("https://example.com:8443/a.png"), /port 443/);
  assert.throws(() => validateRemoteImageUrlSyntax("https://user:pass@example.com/a.png"), /credentials/);
  assert.throws(() => validateRemoteImageUrlSyntax(""), /characters/);
  assert.throws(() => validateRemoteImageUrlSyntax("not-a-url"), /valid absolute URL/);
  assert.throws(() => validateRemoteImageUrlSyntax("https://example.local/a.png"), /Local or internal/);
  assert.equal(isPublicIpAddress("::ffff:c000:0201"), false);
  assert.equal(isPublicIpAddress("not-an-ip"), false);
});

test("visual research accepts only supported image magic bytes", () => {
  assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(detectImageType(Buffer.from("GIF89a", "ascii")), "gif");
  assert.equal(detectImageType(Buffer.from("RIFF0000WEBP", "ascii")), "webp");
  assert.equal(detectImageType(Buffer.from("<html>not an image</html>")), null);
});

test("visual research extracts assistant text only from structured provider events", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: "ignore prompt echo" }),
    JSON.stringify({ type: "tool_use", part: { text: "ignore tool payload" } }),
    JSON.stringify({ type: "text", part: { text: "IMAGE 1\nVISIBLE_FACTS: purple table" } }),
    JSON.stringify({ type: "text", part: { text: "UNCERTAINTIES: motion is not visible" } }),
  ].join("\n");
  assert.equal(
    extractVisualAssistantText(jsonl),
    "IMAGE 1\nVISIBLE_FACTS: purple table\nUNCERTAINTIES: motion is not visible"
  );
  assert.equal(
    extractVisualAssistantText(JSON.stringify({ type: "result", result: "terminal result" })),
    "terminal result"
  );
  assert.equal(extractVisualAssistantText(JSON.stringify({ type: "text", text: "fallback text" })), "fallback text");
  assert.equal(extractVisualAssistantText(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "completed" } })), "completed");
  assert.equal(extractVisualAssistantText(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "assistant content" }] } })), "assistant content");
  assert.throws(() => extractVisualAssistantText("not-json"), /malformed JSON/u);
  assert.throws(() => extractVisualAssistantText(JSON.stringify({ type: "text", part: {} })), /no text payload/u);
  assert.throws(() => extractVisualAssistantText(JSON.stringify({ type: "item.completed", item: {} })), /item.completed/u);
  assert.throws(() => extractVisualAssistantText(JSON.stringify({ type: "assistant", message: {} })), /assistant frame/u);
  assert.throws(() => extractVisualAssistantText(JSON.stringify({ type: "result", result: 3 })), /result frame/u);
  assert.throws(() => extractVisualAssistantText([JSON.stringify({ type: "text", text: "a" }), JSON.stringify({ type: "result", result: "b" })].join("\n")), /contradictory/u);
});

test("reference discovery builds bounded exact-title queries and parses direct Yahoo destinations", () => {
  assert.deepEqual(buildReferenceDiscoveryQueries("Smash Fast"), [
    "\"Smash Fast\" APK",
    "\"Smash Fast\" Android",
    "\"Smash Fast\" app",
    "\"Smash Fast\" download",
    "\"Smash Fast\" gameplay",
  ]);
  assert.throws(() => buildReferenceDiscoveryQueries("\n\r"), /title must contain/i);

  const html = [
    '<ol><li class="first"><div class="algo Sr">',
    '<a href="https://r.search.yahoo.com/x/RU=https%3a%2f%2fapkpure.com%2fsmash-fast%2fcom.tosbygames.smashfast/RK=2/RS=x">',
    '<h3><span>Smash fast! APK for Android Download - APKPure.com</span></h3></a>',
    '<p>Download <b>Smash fast!</b> by Tosby Games &amp; play.</p>',
    '</div></li>',
    '<li><div class="algo Sr">',
    '<a href="https://r.search.yahoo.com/x/RU=https%3A%2F%2Fwww.appbrain.com%2Fapp%2Fsmash-fast%2Fcom.tosbygames.smashfast/RK=2/RS=y">',
    '<h3>Smash fast! for Android</h3></a><p>Tosby Games with 100+ downloads.</p>',
    '</div></li></ol>',
  ].join("");
  assert.deepEqual(parseYahooReferenceSearchResults(html, '"Smash Fast" APK'), [
    {
      title: "Smash fast! APK for Android Download - APKPure.com",
      url: "https://apkpure.com/smash-fast/com.tosbygames.smashfast",
      snippet: "Download Smash fast! by Tosby Games & play.",
      query: '"Smash Fast" APK',
    },
    {
      title: "Smash fast! for Android",
      url: "https://www.appbrain.com/app/smash-fast/com.tosbygames.smashfast",
      snippet: "Tosby Games with 100+ downloads.",
      query: '"Smash Fast" APK',
    },
  ]);
  const noisy = '<li><div class="algo"><a href="not-a-url"><h3>bad</h3></a></div></li>' +
    '<li><div class="other"><a href="https://example.com"><h3>ignored</h3></a></div></li>' +
    '<li><div class="algo"><a href="https://r.search.yahoo.com/x/RU=https%ZZ/RK=x"><h3>bad redirect</h3></a></div></li>' +
    '<li><div class="algo"><a href="https://example.com/#hash"><h3>Good &amp; Title</h3><p>snippet</p></a></div></li>' +
    '<li><div class="algo"><a href="https://example.com/"><h3>Duplicate</h3></a></div></li>';
  assert.equal(parseYahooReferenceSearchResults(noisy, "q").length, 1);
  assert.throws(() => buildReferenceDiscoveryQueries("x".repeat(201)), /title must contain/);
});

test("visual research server configuration is ephemeral, read-only, and auditable", () => {
  const server = createVisualResearchMcpServer({
    nodeBinary: process.execPath,
    scriptPath: path.join(process.cwd(), "dist", "visual_research_mcp.js"),
    providerBinary: "C:\\tools\\opencode.exe",
    tempRoot: "C:\\sessions\\session-1\\runtime\\visual-research",
  });
  assert.equal(server.id, VISUAL_RESEARCH_MCP_SERVER_ID);
  assert.equal(server.runtimeOwned, true);
  assert.deepEqual(server.tools, [
    { name: VISUAL_RESEARCH_TOOL_NAME, sideEffect: "read_only" },
    { name: REFERENCE_DISCOVERY_TOOL_NAME, sideEffect: "read_only" },
  ]);
  assert.deepEqual(server.allowedTools, [
    VISUAL_RESEARCH_TOOL_NAME,
    REFERENCE_DISCOVERY_TOOL_NAME,
  ]);
  assert.ok(server.args?.includes(DEFAULT_VISUAL_RESEARCH_MODEL));
  assert.equal(server.environment, undefined);
});

test("visual research MCP server handles JSON-RPC lifecycle and rejects unsafe tool calls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-visual-rpc-"));
  try {
    const child = spawn(process.execPath, [
      path.join(process.cwd(), "dist", "visual_research_mcp.js"),
      "--binary", process.execPath,
      "--temp-root", root,
      "--model-timeout", "1000",
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    for (const request of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { jsonrpc: "2.0", id: 4, method: "resources/list" },
      { jsonrpc: "2.0", id: 5, method: "prompts/list" },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: VISUAL_RESEARCH_TOOL_NAME, arguments: { image_urls: ["https://127.0.0.1/image.png"] } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: REFERENCE_DISCOVERY_TOOL_NAME, arguments: { title: "" } } },
      { jsonrpc: "2.0", id: 8, method: "unknown" },
      { jsonrpc: "2.0", id: 9 },
      { jsonrpc: "2.0", id: 10, method: "resources/templates/list" },
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "unknown_tool", arguments: {} } },
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: VISUAL_RESEARCH_TOOL_NAME, arguments: {} } },
      { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: VISUAL_RESEARCH_TOOL_NAME, arguments: { image_urls: [] } } },
      { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: VISUAL_RESEARCH_TOOL_NAME, arguments: { image_urls: ["https://example.com/a.png", "https://example.com/a.png"] } } },
      { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: REFERENCE_DISCOVERY_TOOL_NAME, arguments: {} } },
      { jsonrpc: "2.0", id: 16, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.write("{not-json}\n");
    child.stdin.end();
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0, stderr);
    const responses = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(responses.length, 17);
    const byId = (id: number) => responses.find((response) => response.id === id)!;
    assert.equal((byId(1).result as Record<string, unknown>).protocolVersion, "2024-11-05");
    assert.equal((byId(2).result as Record<string, unknown>).toString(), "[object Object]");
    assert.equal((byId(6).result as Record<string, unknown>).isError, true);
    assert.equal((byId(7).result as Record<string, unknown>).isError, true);
    assert.equal((byId(8).error as Record<string, unknown>).code, -32601);
    assert.equal((byId(9).error as Record<string, unknown>).code, -32600);
    assert.equal((byId(10).result as Record<string, unknown>).resourceTemplates instanceof Array, true);
    assert.equal((byId(11).error as Record<string, unknown>).code, -32602);
    assert.equal((byId(12).result as Record<string, unknown>).isError, true);
    assert.equal((byId(13).result as Record<string, unknown>).isError, true);
    assert.equal((byId(14).result as Record<string, unknown>).isError, true);
    assert.equal((byId(15).result as Record<string, unknown>).isError, true);
    assert.equal((byId(16).result as Record<string, unknown>).protocolVersion, "2024-11-05");
    assert.equal((responses.find((response) => response.id === null)?.error as Record<string, unknown>).code, -32700);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
