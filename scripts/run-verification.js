#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

async function runChecks({
  suite,
  steps,
  cwd,
  outputDirectory,
  metadata = {},
}) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const summary = {
    schemaVersion: 1,
    suite,
    ...metadata,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    checks: steps.map((step) => ({
      name: step.name,
      command: step.command,
      status: "not_run",
      startedAt: null,
      endedAt: null,
      exitCode: null,
      signal: null,
      log: null,
      reason: step.skip ?? null,
    })),
  };
  const save = async () => {
    const file = path.join(outputDirectory, "summary.json");
    await fs.writeFile(file + ".tmp", JSON.stringify(summary, null, 2) + "\n");
    await fs.rename(file + ".tmp", file);
  };
  await save();
  let failure = 0;
  for (const [index, step] of steps.entries()) {
    const check = summary.checks[index];
    if (step.skip || failure) {
      check.reason = step.skip ?? "A preceding check failed.";
      await save();
      continue;
    }
    check.status = "running";
    check.startedAt = new Date().toISOString();
    check.log = `${String(index + 1).padStart(2, "0")}-${step.name}.log`;
    await save();
    const handle = await fs.open(path.join(outputDirectory, check.log), "w");
    let writes = Promise.resolve();
    let outputError;
    try {
      const result = await new Promise((resolve) => {
        const child = spawn(step.command[0], step.command.slice(1), {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let spawnError;
        const record = (chunk) => {
          process.stdout.write(chunk);
          writes = writes
            .then(() => handle.writeFile(chunk))
            .catch((error) => {
              outputError ??= error;
            });
        };
        child.stdout.on("data", record);
        child.stderr.on("data", record);
        child.once("error", (error) => {
          spawnError = error;
          record(Buffer.from(error.message + "\n"));
        });
        child.once("close", (code, signal) =>
          resolve({ code, signal, error: spawnError }),
        );
      });
      await writes;
      const error = result.error ?? outputError;
      check.exitCode =
        result.code === 0 && !error
          ? 0
          : result.code > 0
            ? result.code
            : result.signal === "SIGINT"
              ? 130
              : result.signal === "SIGTERM"
                ? 143
                : 1;
      check.signal = result.signal;
      check.status = check.exitCode === 0 ? "passed" : "failed";
      if (error) check.reason = error.message;
      failure = check.exitCode;
    } finally {
      await handle.close();
      check.endedAt = new Date().toISOString();
      await save();
    }
  }
  summary.exitCode = failure;
  summary.endedAt = new Date().toISOString();
  await save();
  process.stdout.write(
    `Verification summary: ${path.join(outputDirectory, "summary.json")}\n`,
  );
  return failure;
}
function capture(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}
async function main() {
  const suite = process.argv[2];
  if (!["platform", "browser", "vm"].includes(suite))
    throw new Error(
      "Usage: npm run verify:platform | npm run verify:browser | npm run verify:vm",
    );
  // A missing or stale VM runtime fails this suite instead of skipping its tests.
  if (suite === "vm") process.env.AGENT_GRAPH_REQUIRE_VM = "1";
  const cwd = path.resolve(__dirname, ".."),
    npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run verification through npm run.");
  const script = (name) => [process.execPath, npm, "run", name];
  const steps =
    suite !== "platform"
      ? ["build", suite === "vm" ? "test:vm" : "test:e2e"].map((name) => ({
          name: name.replaceAll(":", "-"),
          command: script(name),
        }))
      : [
          "format:check",
          "typecheck",
          "test:tooling",
          "test",
          "smoke",
          "build:launcher:mac",
          "test:launcher:mac",
          "pack:check",
          "pack:smoke",
        ].map((name) => ({
          name: name.replaceAll(":", "-"),
          command: script(name),
          ...(name.endsWith(":mac") && process.platform !== "darwin"
            ? { skip: "macOS only" }
            : {}),
        }));
  if (suite === "platform")
    steps.push({
      name: "audit",
      command: [
        process.execPath,
        npm,
        "audit",
        "--omit=dev",
        "--audit-level=high",
      ],
    });
  return runChecks({
    suite,
    steps,
    cwd,
    outputDirectory: path.join(
      cwd,
      "artifacts",
      "verification",
      `${suite}-${process.platform}-${process.arch}`,
    ),
    metadata: {
      commit: capture("git", ["rev-parse", "HEAD"], cwd),
      dirty: Boolean(capture("git", ["status", "--porcelain"], cwd)),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      npm: capture(process.execPath, [npm, "--version"], cwd),
      runUrl: process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
  });
}
module.exports = { runChecks };
if (require.main === module)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
