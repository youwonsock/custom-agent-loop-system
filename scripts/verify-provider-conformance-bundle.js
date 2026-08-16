#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const bundleRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!bundleRoot || !fs.existsSync(bundleRoot) || !fs.statSync(bundleRoot).isDirectory()) {
  throw new Error("Usage: verify-provider-conformance-bundle <downloaded-report-directory>");
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(entryPath);
  }
  return files;
}

const providers = ["opencode", "kilo", "codex", "claude"];
const platforms = ["win32", "linux", "darwin"];
const modes = ["write", "read-only"];
const expected = new Set(
  providers.flatMap((provider) =>
    platforms.flatMap((platform) => modes.map((mode) => `${provider}:${platform}:${mode}`))
  )
);
const observed = new Set();
const reports = walk(bundleRoot);
for (const filePath of reports) {
  const report = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const key = `${report.provider}:${report.platform}:${report.mode}`;
  if (!expected.has(key)) throw new Error(`Unexpected provider conformance report ${key}.`);
  if (observed.has(key)) throw new Error(`Duplicate provider conformance report ${key}.`);
  observed.add(key);
  if (
    report.schemaVersion !== 1 ||
    report.passed !== true ||
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    typeof report.providerVersion !== "string" ||
    report.providerVersion.length === 0
  ) {
    throw new Error(`Provider conformance report ${key} did not pass cleanly.`);
  }
  if (report.expectedFailClosed !== false) {
    throw new Error(`Provider conformance report ${key} has the wrong fail-closed classification.`);
  }
  if (report.authenticatedExecution !== true || report.spawned !== true) {
    throw new Error(`Provider conformance report ${key} lacks an authenticated provider execution.`);
  }
}

const missing = [...expected].filter((key) => !observed.has(key));
if (missing.length > 0) {
  throw new Error(`Provider conformance bundle is incomplete:\n${missing.join("\n")}`);
}
if (reports.length !== expected.size) {
  throw new Error(`Expected ${expected.size} reports, found ${reports.length}.`);
}
process.stdout.write(`Provider conformance bundle verified: ${reports.length} reports.\n`);
