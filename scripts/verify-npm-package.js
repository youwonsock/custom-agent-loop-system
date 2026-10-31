#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error(
    "npm_execpath is unavailable; run this check through npm run pack:check.",
  );
const result = spawnSync(
  process.execPath,
  [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(result.stderr || `npm pack exited with ${result.status}`);
const report = JSON.parse(result.stdout);
const files = new Set(report[0].files.map((entry) => entry.path));
for (const required of [
  "dist/src/server/cli.js",
  "dist/src/server/worker.js",
  "dist/src/core/process_supervisor.js",
  "dist/src/core/kilo_protocol.js",
  "dist/src/core/kilo_protocol_plugin.js",
  "dist/src/core/kilo_recovery.js",
  "dist/src/core/node_test_command.js",
  "dist/src/core/node_test_policy.js",
  "dist/src/core/node_test_worker.js",
  "dist/src/core/node_test_verification.js",
  "dist/src/core/inspection_evidence.js",
  "dist/src/core/test_source_guard.js",
  "dist/src/core/stage_budget.js",
  "dist/src/core/process_command_policy.js",
  "dist/src/core/native_scope.js",
  "dist/src/core/inspection_syntax.js",
  "dist/src/core/program_io.js",
  "dist/src/core/program_io_runner.js",
  "dist/src/core/program_io_bootstrap.js",
  "dist/src/core/program_io_vm.js",
  "dist/program_io_dependencies.json",
  "dist/program_io_package_lock.json",
  "dist/src/core/program_io_setup.js",
  "dist/web/index.html",
  "dist/runtime_defaults.json",
  "scripts/fix-pty-permissions.js",
]) {
  if (!files.has(required))
    throw new Error(`npm package is missing required file: ${required}`);
}
const forbidden = [...files].filter(
  (file) =>
    file.endsWith(".ts") ||
    file.endsWith(".test.js") ||
    file.startsWith("test/") ||
    // Untracked local folders that may exist beside a source checkout.
    file.startsWith("experiments/") ||
    file.startsWith("desktop-app/") ||
    file.startsWith(".build/") ||
    file.startsWith(".goal/") ||
    file.startsWith(".kilo/") ||
    file.startsWith("src/") ||
    file.startsWith("web/") ||
    file.startsWith("artifacts/") ||
    file.startsWith("test-results/") ||
    // Release records name maintainers' machines; only user docs ship.
    file === "docs/VERIFICATION.md" ||
    file.startsWith("docs/verification/") ||
    file === "docs/IMPLEMENTATION_PLAN.md" ||
    file === "docs/STATUS.md",
);
if (forbidden.length > 0) {
  throw new Error(
    `npm package leaks development/runtime files:\n${forbidden.join("\n")}`,
  );
}
process.stdout.write(
  `npm package contents verified: ${files.size} files, ${report[0].unpackedSize} unpacked bytes.\n`,
);
