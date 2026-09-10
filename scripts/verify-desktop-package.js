#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const supplied = process.argv[2] ? path.resolve(process.argv[2]) : null;
const artifact = supplied || path.join(root, "artifacts", "desktop", `AgentLoopOrchestrator-${require(path.join(root, "desktop-app", "package.json")).version}-win32-x64-Setup.exe`);
if (!fs.existsSync(artifact)) throw new Error(`Missing desktop installer: ${artifact}`);
const digest = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
const checksum = fs.readFileSync(`${artifact}.sha256`, "utf8").trim();
if (checksum !== `${digest}  ${path.basename(artifact)}`) throw new Error("Desktop installer checksum mismatch.");
const manifest = JSON.parse(fs.readFileSync(`${artifact}.manifest.json`, "utf8"));
const expectedPackage = require(path.join(root, "desktop-app", "package.json"));
if (
  manifest.schemaVersion !== 1 ||
  manifest.artifactType !== "desktop-installer" ||
  manifest.artifactFile !== path.basename(artifact) ||
  manifest.packageName !== expectedPackage.name ||
  manifest.packageVersion !== expectedPackage.version ||
  manifest.targetPlatform !== "win32-x64" ||
  manifest.sha256 !== digest ||
  manifest.bytes !== fs.statSync(artifact).size
) throw new Error("Desktop installer manifest mismatch.");
if (
  !manifest.verificationHelper ||
  manifest.verificationHelper.target !== "win32-x64" ||
  !/^[a-f0-9]{64}$/u.test(manifest.verificationHelper.sha256 || "")
) throw new Error("Desktop installer is missing a valid verification helper identity.");
const sbom = JSON.parse(fs.readFileSync(`${artifact}.cdx.json`, "utf8"));
const hashes = sbom.metadata?.component?.hashes;
if (
  sbom.bomFormat !== "CycloneDX" ||
  !Array.isArray(hashes) ||
  !hashes.some((hash) => hash && hash.alg === "SHA-256" && hash.content === digest)
) throw new Error("Desktop installer SBOM does not bind the artifact.");
const properties = sbom.metadata?.component?.properties || [];
const helperTarget = properties.find((property) => property?.name === "agent-loop:verificationHelperTarget")?.value;
const helperSha256 = properties.find((property) => property?.name === "agent-loop:verificationHelperSha256")?.value;
if (helperTarget !== manifest.verificationHelper.target || helperSha256 !== manifest.verificationHelper.sha256) {
  throw new Error("Desktop installer SBOM does not bind the verification helper identity.");
}
process.stdout.write(`Desktop installer verified: ${path.basename(artifact)} (win32-x64).\n`);
