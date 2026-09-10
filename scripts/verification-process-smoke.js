#!/usr/bin/env node

// Run one real verification command through the packaged process runtime. The
// command intentionally leaves a child alive; timeout handling must terminate
// the complete process tree and report a clean boundary.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runtimeModule = process.argv[2];
const projectRoot = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-verification-smoke-"));
if (!runtimeModule) throw new Error("Usage: node verification-process-smoke.js <runtime-module> [project-root]");
const { VerificationProcessRuntime } = require(path.resolve(runtimeModule));

async function main() {
  const childPidPath = path.join(projectRoot, "verification-process-child.pid");
  const childScriptPath = path.join(projectRoot, "verification-process-tree.js");
  fs.writeFileSync(
    childScriptPath,
    [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[2], String(child.pid));",
      "process.stdout.write('VERIFICATION_RUNTIME_OK\\n');",
      "setTimeout(() => {}, 60000);",
    ].join("\n"),
    "utf8"
  );
  const runtime = new VerificationProcessRuntime();
  const result = await runtime.execute({
    runId: "packaged-smoke",
    verificationId: "packaged-smoke-verification",
    projectRoot,
    command: {
      id: "process-tree-timeout",
      label: "Process tree timeout smoke",
      executable: process.execPath,
      args: [childScriptPath, childPidPath],
      cwd: ".",
      timeoutMs: 500,
      requirementIds: [],
    },
  });
  if (!result.timedOut || !result.processTreeClean || !result.stdout.includes("VERIFICATION_RUNTIME_OK")) {
    throw new Error(`Verification runtime smoke failed: ${JSON.stringify({ timedOut: result.timedOut, processTreeClean: result.processTreeClean, stdout: result.stdout })}`);
  }
  const childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
  if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error("Verification child PID was not recorded.");
  let childAlive = true;
  try {
    process.kill(childPid, 0);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : null;
    childAlive = code !== "ESRCH" && !(error instanceof Error && /(?:does not exist|not found)/iu.test(error.message));
  }
  if (childAlive) throw new Error(`Verification descendant ${childPid} survived process-tree cleanup.`);
  fs.rmSync(childScriptPath, { force: true });
  fs.rmSync(childPidPath, { force: true });
  process.stdout.write("Verification process runtime timeout/tree cleanup smoke passed.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
