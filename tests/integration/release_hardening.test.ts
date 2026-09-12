import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workspaceRoot = process.cwd();

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runScript(scriptName: string, args: string[]) {
  const scriptPath = scriptName === "verify-release-bundle.js"
    ? path.join(workspaceRoot, "scripts", "verify", scriptName)
    : path.join(workspaceRoot, "scripts", "verify", scriptName);
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

function writeArtifactBundle(
  directory: string,
  name: string,
  sourceCommit: string,
  targetPlatform?: string
): string {
  const artifactPath = path.join(directory, name);
  const bytes = Buffer.from(`candidate:${name}`, "utf8");
  const digest = sha256(bytes);
  fs.writeFileSync(artifactPath, bytes);
  fs.writeFileSync(`${artifactPath}.sha256`, `${digest}  ${name}\n`, "utf8");
  fs.writeFileSync(
    `${artifactPath}.manifest.json`,
    `${JSON.stringify({
      schemaVersion: 1,
      artifactFile: name,
      targetPlatform,
      sha256: digest,
      bytes: bytes.length,
      sourceCommit,
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    `${artifactPath}.cdx.json`,
    `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        component: {
          type: "application",
          name,
          hashes: [{ alg: "SHA-256", content: digest }],
        },
      },
    })}\n`,
    "utf8"
  );
  return artifactPath;
}

function writePortableArtifactBundle(directory: string, name: string, sourceCommit: string): string {
  const artifactPath = path.join(directory, name);
  fs.mkdirSync(artifactPath, { recursive: true });
  const entry = Buffer.from(`portable:${name}`, "utf8");
  fs.writeFileSync(path.join(artifactPath, "agent-loop-orchestrator.exe"), entry);
  const entryDigest = sha256(entry);
  const treeDigest = sha256(Buffer.from(`agent-loop-orchestrator.exe\0${entryDigest}\n`, "utf8"));
  fs.writeFileSync(`${artifactPath}.sha256`, `${treeDigest}  ${name}/\n`, "utf8");
  fs.writeFileSync(
    `${artifactPath}.manifest.json`,
    `${JSON.stringify({
      schemaVersion: 1,
      artifactType: "desktop-portable",
      artifactFile: name,
      entryExecutable: "agent-loop-orchestrator.exe",
      targetPlatform: "win32-x64",
      sha256: treeDigest,
      bytes: entry.length,
      fileCount: 1,
      sourceCommit,
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    `${artifactPath}.cdx.json`,
    `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: { component: { type: "application", name, hashes: [{ alg: "SHA-256", content: treeDigest }] } },
    })}\n`,
    "utf8"
  );
  return artifactPath;
}

test("release bundle verification binds artifacts, sidecars, commit, count, and desktop targets", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-release-test-"));
  const commit = "a".repeat(40);
  try {
    const npmArtifact = writeArtifactBundle(
      temporaryRoot,
      "custom-agent-loop-system-5.0.0.tgz",
      commit
    );
    writePortableArtifactBundle(
      temporaryRoot,
      "AgentLoopOrchestrator-5.0.0-win32-x64",
      commit
    );
    const valid = runScript("verify-release-bundle.js", [
      temporaryRoot,
      "--expected-commit",
      commit,
      "--expected-count",
      "2",
      "--expected-desktop-targets",
      "win32-x64",
    ]);
    assert.equal(valid.status, 0, valid.stderr);

    fs.appendFileSync(npmArtifact, "tamper", "utf8");
    const tampered = runScript("verify-release-bundle.js", [temporaryRoot]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /Checksum mismatch/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("provider promotion gate requires all 36 passing protected reports", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-provider-gate-"));
  const providers = ["opencode", "kilo", "codex", "claude"];
  const platforms = ["win32", "linux", "darwin"];
  const modes = ["write", "read-only", "tools-none"];
  const versions: Record<string, string> = {
    opencode: "1.18.14",
    kilo: "7.3.54",
    codex: "0.146.1",
    claude: "2.1.233",
  };
  try {
    for (const provider of providers) {
      for (const platform of platforms) {
        for (const mode of modes) {
          const expectedFailClosed = provider === "codex" && mode === "tools-none";
          const providerVersion = expectedFailClosed ? null : versions[provider];
          fs.writeFileSync(
            path.join(temporaryRoot, `${provider}-${platform}-${mode}.json`),
            `${JSON.stringify({
              schemaVersion: 2,
              provider,
              platform,
              architecture: "x64",
              mode,
              providerVersion,
              expectedCliVersion: versions[provider],
              resolvedBinary: expectedFailClosed ? null : `C:\\providers\\${provider}.exe`,
              capabilityKey: `${provider}:${providerVersion ?? "unknown"}:${platform}:x64:${mode}`,
              capabilityStatus: expectedFailClosed ? "unverified" : "verified",
              outcome: expectedFailClosed ? "blocked_unverified" : "executed_pass",
              executionVerified: !expectedFailClosed,
              authenticatedExecution: !expectedFailClosed,
              spawned: !expectedFailClosed,
              passed: true,
              expectedFailClosed,
              failures: [],
              startedAt: "2026-08-16T00:00:00.000Z",
              endedAt: "2026-08-16T00:00:01.000Z",
            })}\n`,
            "utf8"
          );
        }
      }
    }
    const valid = runScript("verify-provider-conformance-bundle.js", [temporaryRoot]);
    assert.equal(valid.status, 0, valid.stderr);
    fs.rmSync(path.join(temporaryRoot, "claude-darwin-tools-none.json"));
    const incomplete = runScript("verify-provider-conformance-bundle.js", [temporaryRoot]);
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /incomplete/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("release workflows pin Actions and promotion never rebuilds candidates", () => {
  const workflowDirectory = path.join(workspaceRoot, ".github", "workflows");
  const workflowSources = fs.readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => fs.readFileSync(path.join(workflowDirectory, name), "utf8"));
  for (const source of workflowSources) {
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      assert.match(match[1], /@[0-9a-f]{40}$/);
    }
    assert.doesNotMatch(source, /uses:\s*[^\s]+@v\d+/);
  }

  const ci = fs.readFileSync(path.join(workflowDirectory, "ci.yml"), "utf8");
  assert.match(ci, /npm-artifact-matrix:[\s\S]*node-version:\s*18/);
  assert.match(ci, /desktop-candidate:[\s\S]*portable desktop/);
  assert.doesNotMatch(ci, /extension-host-e2e|vsix-candidate/);
  assert.match(ci, /attest-build-provenance@[0-9a-f]{40}/);

  const promotion = fs.readFileSync(path.join(workflowDirectory, "promote.yml"), "utf8");
  assert.match(promotion, /download-artifact@[0-9a-f]{40}/);
  assert.match(promotion, /verify-release-bundle\.js/);
  assert.match(promotion, /verify-provider-conformance-bundle\.js/);
  assert.match(promotion, /gh attestation verify/);
  assert.match(promotion, /npm publish "\$artifact"/);
  assert.doesNotMatch(promotion, /npm (?:ci|install|run build|run package)/);
});

test("npm manifest allowlist excludes tests, experiments, and source maps", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as {
    files: string[];
    dependencies: Record<string, string>;
  };
  assert.ok(manifest.files.includes("!dist/core/**/*.test.js"));
  assert.ok(manifest.files.includes("dist/core/**/*.js"));
  assert.equal(manifest.dependencies["@langchain/langgraph"], undefined);
  assert.equal(manifest.files.some((entry) => entry.includes("experiments")), false);
  assert.equal(manifest.files.some((entry) => entry.endsWith(".js.map")), false);
});
