#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const {
  summarizePortableDirectory,
} = require("./portable-artifact.js");

const root = path.resolve(__dirname, "..");
const desktopVersion = require(path.join(root, "desktop-app", "package.json")).version;
const artifact = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "artifacts", "desktop", `AgentLoopOrchestrator-${desktopVersion}-win32-x64`);
if (!fs.existsSync(artifact) || !fs.statSync(artifact).isDirectory()) {
  throw new Error(`Missing desktop portable artifact directory: ${artifact}`);
}

const summary = summarizePortableDirectory(artifact);
const checksum = fs.readFileSync(`${artifact}.sha256`, "utf8").trim();
if (checksum !== `${summary.sha256}  ${path.basename(artifact)}/`) {
  throw new Error("Desktop portable artifact checksum mismatch.");
}
const manifest = JSON.parse(fs.readFileSync(`${artifact}.manifest.json`, "utf8"));
const expectedPackage = require(path.join(root, "desktop-app", "package.json"));
if (
  manifest.schemaVersion !== 1 ||
  manifest.artifactType !== "desktop-portable" ||
  manifest.artifactFile !== path.basename(artifact) ||
  manifest.entryExecutable !== "agent-loop-orchestrator.exe" ||
  manifest.packageName !== expectedPackage.name ||
  manifest.packageVersion !== expectedPackage.version ||
  manifest.targetPlatform !== "win32-x64" ||
  manifest.sha256 !== summary.sha256 ||
  manifest.bytes !== summary.bytes ||
  manifest.fileCount !== summary.fileCount
) throw new Error("Desktop portable artifact manifest mismatch.");
if (!fs.existsSync(path.join(artifact, manifest.entryExecutable))) {
  throw new Error("Desktop portable artifact entry executable is missing.");
}
const portableUnexpectedMaps = [];
function inspectPortable(directory) {
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, child.name);
    if (child.isDirectory()) inspectPortable(target);
    else if (/\.map$/iu.test(child.name)) portableUnexpectedMaps.push(target);
  }
}
inspectPortable(artifact);
if (portableUnexpectedMaps.length > 0) {
  throw new Error(`Portable desktop artifact contains source maps: ${portableUnexpectedMaps.slice(0, 10).join(", ")}`);
}

const appAsar = path.join(artifact, "resources", "app.asar");
if (!fs.existsSync(appAsar)) throw new Error("Portable desktop artifact is missing resources/app.asar.");
const asarEntries = new Set(asar.listPackage(appAsar).map((entry) => String(entry).replace(/\\/gu, "/").replace(/^\//u, "")));
const requiredAsarEntries = [
  "package.json",
  ".webpack/main/index.js",
  ".webpack/renderer/main_window/index.html",
  ".webpack/renderer/main_window/index.js",
  ".webpack/renderer/main_window/preload.js",
  "core/dist/src/interfaces/cli/main.js",
  "core/native/bin/win32-x64/verification-host.exe",
];
for (const entry of requiredAsarEntries) {
  if (!asarEntries.has(entry)) throw new Error(`Portable app.asar is missing required entry: ${entry}`);
}
const packagedPackage = JSON.parse(asar.extractFile(appAsar, "package.json").toString("utf8"));
if (packagedPackage.main !== ".webpack/main") throw new Error(`Packaged Electron main must be .webpack/main, got ${JSON.stringify(packagedPackage.main)}.`);
for (const entry of [
  "resources/renderer/main_window/index.html",
  "resources/renderer/main_window/index.js",
  "resources/renderer/main_window/preload.js",
]) {
  if (!fs.existsSync(path.join(artifact, entry))) throw new Error(`Portable desktop artifact is missing runtime renderer entry: ${entry}`);
}
const forbiddenAsarPatterns = [
  /^(?:src|tests|\.e2e|test-results|scripts)(?:\/|$)/u,
  /(?:^|\/)(?:webpack|forge|playwright|tsconfig|package-lock)\.[^/]+$/iu,
  /\.map$/u,
  /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/iu,
  /^node_modules\/(?:@electron-forge|@playwright|typescript|webpack|webpack-cli|ts-loader|@types|electron-rebuild)(?:\/|$)/u,
  /^node_modules\/node-pty\/prebuilds\/(?!win32-x64\/)/u,
  /(?:^|\/)(?:maintenance-service|legacy-control-import)\.js$/u,
];
const forbiddenAsarEntries = [...asarEntries].filter((entry) => forbiddenAsarPatterns.some((pattern) => pattern.test(entry)));
if (forbiddenAsarEntries.length > 0) throw new Error(`Portable app.asar contains forbidden development or legacy entries: ${forbiddenAsarEntries.slice(0, 20).join(", ")}`);
const allowedRuntimePackages = new Set(["fs-extra", "graceful-fs", "jsonfile", "universalify", "node-pty"]);
for (const entry of asarEntries) {
  const match = entry.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/u);
  if (match && !allowedRuntimePackages.has(match[1])) throw new Error(`Portable app.asar contains an unapproved runtime dependency: ${entry}`);
}
for (const entry of asarEntries) {
  if (/^node_modules\/node-pty\/prebuilds\/win32-x64\/.*\.pdb$/iu.test(entry)) throw new Error(`Portable app.asar contains an unnecessary node-pty symbol file: ${entry}`);
}
if (
  !manifest.verificationHelper ||
  manifest.verificationHelper.target !== "win32-x64" ||
  !/^[a-f0-9]{64}$/u.test(manifest.verificationHelper.sha256 || "")
) throw new Error("Desktop portable artifact is missing a valid verification helper identity.");
const sbom = JSON.parse(fs.readFileSync(`${artifact}.cdx.json`, "utf8"));
const hashes = sbom.metadata?.component?.hashes;
if (
  sbom.bomFormat !== "CycloneDX" ||
  !Array.isArray(hashes) ||
  !hashes.some((hash) => hash && hash.alg === "SHA-256" && hash.content === summary.sha256)
) throw new Error("Desktop portable artifact SBOM does not bind the artifact.");
const properties = sbom.metadata?.component?.properties || [];
const helperTarget = properties.find((property) => property?.name === "agent-loop:verificationHelperTarget")?.value;
const helperSha256 = properties.find((property) => property?.name === "agent-loop:verificationHelperSha256")?.value;
if (helperTarget !== manifest.verificationHelper.target || helperSha256 !== manifest.verificationHelper.sha256) {
  throw new Error("Desktop portable artifact SBOM does not bind the verification helper identity.");
}
process.stdout.write(`Desktop portable artifact verified: ${path.basename(artifact)} (win32-x64).\n`);
