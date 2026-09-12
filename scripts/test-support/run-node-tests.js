#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const directoryOptionIndex = process.argv.indexOf("--directory");
const compiledDirectoryName = directoryOptionIndex >= 0
  ? process.argv[directoryOptionIndex + 1]
  : ".build/test-dist";

if (
  !compiledDirectoryName
  || path.isAbsolute(compiledDirectoryName)
  || compiledDirectoryName.split(/[\\/]+/u).includes("..")
) {
  throw new Error("--directory must name a relative compiled-output directory");
}

const compiledDirectory = path.join(process.cwd(), compiledDirectoryName);
const coverageDirectory = compiledDirectoryName.replaceAll("\\", "/");
function filesBelow(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesBelow(candidate));
    else if (entry.isFile()) result.push(candidate);
  }
  return result;
}

const testFiles = filesBelow(compiledDirectory)
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/"))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No compiled test files were found in ${compiledDirectory}`);
}

const nodeArgs = ["--test", "--test-concurrency=1"];
if (process.argv.includes("--coverage")) {
  const productionFiles = filesBelow(compiledDirectory)
    .filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"))
    .map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/"))
    .sort();
  console.log(`Coverage inventory: ${productionFiles.length} production JavaScript files`);
  for (const file of productionFiles) console.log(`  ${file}`);
  // Use c8's --all mode so a production module that was never imported is
  // reported as 0%, instead of disappearing from the denominator. Resolve
  // the local binary directly so CI and an installed package use the pinned
  // lockfile version without a network lookup.
  let c8Binary;
  try {
    c8Binary = require.resolve("c8/bin/c8.js");
  } catch (error) {
    throw new Error(`The pinned c8 dependency is required for coverage: ${error instanceof Error ? error.message : String(error)}`);
  }
  const c8Args = [
    c8Binary,
    "--all",
    "--include", `${coverageDirectory}/src/**/*.js`,
    "--exclude", `${coverageDirectory}/**/*.test.js`,
    "--exclude", `${coverageDirectory}/**/test/**`,
    "--reporter", "text-summary",
    "--check-coverage",
    "--lines", "80",
    "--branches", "60",
    "--functions", "70",
    "--",
    process.execPath,
    ...nodeArgs,
    ...testFiles,
  ];
  const result = spawnSync(process.execPath, c8Args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  process.exit();
}
nodeArgs.push(...testFiles);

const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
