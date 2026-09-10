#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readVerificationHelperIdentity } = require("./verification-helper-identity.js");

const root = path.resolve(__dirname, "..");
const desktopPackage = require(path.join(root, "desktop-app", "package.json"));
const supplied = process.argv[2] ? path.resolve(process.argv[2]) : null;
const candidates = supplied ? [supplied] : [
  path.join(root, "desktop-app", "out", "make", "squirrel.windows", "x64", "AgentLoopOrchestratorSetup.exe"),
  path.join(root, "desktop-app", "out", "make", "squirrel.windows", "x64", "agent_loop_orchestrator-" + desktopPackage.version + " Setup.exe"),
];
const source = candidates.find((candidate) => fs.existsSync(candidate));
if (!source) throw new Error(`Squirrel Setup.exe was not found. Checked:\n${candidates.join("\n")}`);
const verificationHelper = readVerificationHelperIdentity(path.join(root, "desktop-app", "core"));
const gitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
const sourceCommit = process.env.GITHUB_SHA ||
  (gitResult.status === 0 ? gitResult.stdout.trim() : "unknown");
if (verificationHelper.sourceCommit !== sourceCommit) {
  throw new Error(
    `Verification helper was built from ${verificationHelper.sourceCommit}, not candidate commit ${sourceCommit}.`
  );
}
const outputDirectory = path.join(root, "artifacts", "desktop");
fs.mkdirSync(outputDirectory, { recursive: true });
// A candidate directory is a single immutable release set. Remove stale
// installers and their sidecars from an earlier product version before
// staging the new candidate, so a local release verification cannot mix old
// and current-version bytes.
for (const entry of fs.readdirSync(outputDirectory, { withFileTypes: true })) {
  if (entry.isFile() && /^AgentLoopOrchestrator-.*-win32-x64-Setup\.exe(?:\.(?:sha256|manifest\.json|cdx\.json))?$/u.test(entry.name)) {
    fs.rmSync(path.join(outputDirectory, entry.name), { force: true });
  }
}
const output = path.join(outputDirectory, `AgentLoopOrchestrator-${desktopPackage.version}-win32-x64-Setup.exe`);
fs.copyFileSync(source, output);
const bytes = fs.readFileSync(output);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const manifest = {
  schemaVersion: 1,
  artifactType: "desktop-installer",
  artifactFile: path.basename(output),
  packageName: desktopPackage.name,
  packageVersion: desktopPackage.version,
  targetPlatform: "win32-x64",
  sha256,
  bytes: bytes.length,
  sourceCommit,
  signed: Boolean(process.env.AGENT_LOOP_WINDOWS_CERTIFICATE_FILE),
  verificationHelper,
};
fs.writeFileSync(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`, "utf8");
fs.writeFileSync(`${output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const sbom = {
  bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
  metadata: { component: { type: "application", name: desktopPackage.productName, version: desktopPackage.version, hashes: [{ alg: "SHA-256", content: sha256 }], properties: [
    { name: "agent-loop:verificationHelperTarget", value: verificationHelper.target },
    { name: "agent-loop:verificationHelperSha256", value: verificationHelper.sha256 },
    { name: "agent-loop:verificationHelperSourceCommit", value: verificationHelper.sourceCommit },
  ] } },
};
fs.writeFileSync(`${output}.cdx.json`, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
process.stdout.write(`Desktop installer staged: ${output} (${bytes.length} bytes)\n`);
