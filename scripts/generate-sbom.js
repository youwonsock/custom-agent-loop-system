#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this script through npm.");
const result = spawnSync(
  process.execPath,
  [npmCli, "sbom", "--omit=dev", "--sbom-format", "cyclonedx"],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || `npm sbom exited with ${result.status}`);
JSON.parse(result.stdout);
const outputDirectory = path.join(root, "artifacts");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, "agent-loop-npm-runtime-sbom.cdx.json");
fs.writeFileSync(outputPath, result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`, "utf8");
process.stdout.write(`SBOM written to ${outputPath}\n`);
