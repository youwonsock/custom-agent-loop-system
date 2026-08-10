#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const directoryOptionIndex = process.argv.indexOf("--directory");
const compiledDirectoryName = directoryOptionIndex >= 0
  ? process.argv[directoryOptionIndex + 1]
  : "dist";

if (
  !compiledDirectoryName
  || path.isAbsolute(compiledDirectoryName)
  || compiledDirectoryName.split(/[\\/]+/u).includes("..")
) {
  throw new Error("--directory must name a relative compiled-output directory");
}

const compiledDirectory = path.join(process.cwd(), compiledDirectoryName);
const coverageDirectory = compiledDirectoryName.replaceAll("\\", "/");
const testFiles = fs
  .readdirSync(compiledDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(compiledDirectoryName, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No compiled test files were found in ${compiledDirectory}`);
}

const nodeArgs = ["--test", "--test-concurrency=1"];
if (process.argv.includes("--coverage")) {
  nodeArgs.push(
    "--experimental-test-coverage",
    `--test-coverage-include=${coverageDirectory}/*.js`,
    `--test-coverage-exclude=${coverageDirectory}/*.test.js`,
    "--test-coverage-lines=80",
    "--test-coverage-branches=60",
    "--test-coverage-functions=70"
  );
}
nodeArgs.push(...testFiles);

const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
