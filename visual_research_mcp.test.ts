import test from "node:test";
import assert from "node:assert/strict";
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
    extractVisualAssistantText(JSON.stringify({ type: "result", result: "fallback result" })),
    "fallback result"
  );
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
