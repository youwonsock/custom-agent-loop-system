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
const modes = ["write", "read-only", "tools-none"];
const expectedVersions = {
  opencode: "1.18.14",
  kilo: "7.3.54",
  codex: "0.146.1",
  claude: "2.1.233",
};
const supportedArchitectures = new Set(["x64", "arm64"]);
const fullExpected = new Set(
  providers.flatMap((provider) =>
    platforms.flatMap((platform) => modes.map((mode) => `${provider}:${platform}:${mode}`))
  )
);
const reports = walk(bundleRoot);
// v7 promotion is intentionally strict: a candidate is not releasable when
// any of the provider/OS/tools-none cells is absent.  Accepting the old
// 24-report shape would let an artifact skip the tool-free safety contract.
const expected = fullExpected;
const observed = new Set();
for (const filePath of reports) {
  const report = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const key = `${report.provider}:${report.platform}:${report.mode}`;
  if (!expected.has(key)) throw new Error(`Unexpected provider conformance report ${key}.`);
  if (observed.has(key)) throw new Error(`Duplicate provider conformance report ${key}.`);
  observed.add(key);
  const expectedBlocked = report.provider === "codex" && report.mode === "tools-none";
  const expectedVersion = expectedVersions[report.provider];
  const capabilityKey = `${report.provider}:${expectedBlocked ? "unknown" : expectedVersion}:${report.platform}:${report.architecture}:${report.mode}`;
  if (
    report.schemaVersion !== 2 ||
    report.passed !== true ||
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    report.expectedCliVersion !== expectedVersion ||
    !supportedArchitectures.has(report.architecture) ||
    report.capabilityKey !== capabilityKey
  ) {
    throw new Error(`Provider conformance report ${key} did not pass cleanly.`);
  }
  if (expectedBlocked) {
    if (
      report.expectedFailClosed !== true ||
      report.capabilityStatus !== "unverified" ||
      report.outcome !== "blocked_unverified" ||
      report.executionVerified !== false ||
      report.authenticatedExecution !== false ||
      report.spawned !== false ||
      report.providerVersion !== null
    ) {
      throw new Error(`Fail-closed tool-free report ${key} has an invalid blocked classification.`);
    }
  } else {
    if (
      report.expectedFailClosed !== false ||
      report.capabilityStatus !== "verified" ||
      report.outcome !== "executed_pass" ||
      report.executionVerified !== true ||
      report.providerVersion !== expectedVersion
    ) {
      throw new Error(`Provider conformance report ${key} has the wrong fail-closed classification.`);
    }
    if (report.authenticatedExecution !== true || report.spawned !== true) {
      throw new Error(`Provider conformance report ${key} lacks an authenticated provider execution.`);
    }
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
