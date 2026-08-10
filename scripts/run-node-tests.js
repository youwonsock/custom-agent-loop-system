#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const distDirectory = path.join(process.cwd(), "dist");
const testFiles = fs
  .readdirSync(distDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join("dist", entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No compiled test files were found in ${distDirectory}`);
}

const nodeArgs = ["--test", "--test-concurrency=1"];
if (process.argv.includes("--coverage")) {
  nodeArgs.push(
    "--experimental-test-coverage",
    "--test-coverage-include=dist/*.js",
    "--test-coverage-exclude=dist/*.test.js",
    "--test-coverage-lines=80",
    "--test-coverage-branches=60",
    "--test-coverage-functions=70"
  );
}
nodeArgs.push(...testFiles);

const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
