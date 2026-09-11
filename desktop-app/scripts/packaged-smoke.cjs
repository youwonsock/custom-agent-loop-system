#!/usr/bin/env node

// Smoke-test the exact portable directory produced by electron-forge package.
// The test starts the executable directly from the project artifact and then
// verifies that the packaged process helper owns and cleans up a child tree.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

if (process.platform !== "win32") throw new Error("Packaged desktop smoke is only supported on Windows.");
const artifact = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!artifact || !fs.existsSync(artifact) || !fs.statSync(artifact).isDirectory()) {
  throw new Error("Usage: node scripts/packaged-smoke.cjs <portable-directory>");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function walk(directory, predicate, depth = 0) {
  if (depth > 16 || !fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && predicate(candidate)) return candidate;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const found = walk(candidate, predicate, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function launchAndVerify(executable) {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-portable-smoke-"));
  const configRoot = path.join(smokeRoot, "config");
  const dataRoot = path.join(smokeRoot, "data");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const nonce = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.replace(/[^0-9a-f]/giu, "").slice(0, 32).padEnd(16, "0");
  const marker = path.join(os.tmpdir(), `agent-loop-orchestrator-ready-${nonce}.json`);
  fs.rmSync(marker, { force: true });
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  environment.AGENT_LOOP_PACKAGED_SMOKE_NONCE = nonce;
  environment.AGENT_LOOP_APP_DATA_ROOT = configRoot;
  environment.AGENT_LOOP_LOCAL_DATA_ROOT = dataRoot;
  let child = null;
  try {
    child = spawn(executable, [], {
      cwd: path.dirname(executable),
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    const deadline = Date.now() + 30_000;
    let markerValue = null;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`Packaged application could not start: ${spawnError.message}`);
      if (fs.existsSync(marker)) {
        markerValue = JSON.parse(fs.readFileSync(marker, "utf8"));
        break;
      }
      if (child.exitCode !== null) throw new Error(`Packaged application exited before GUI readiness (code ${child.exitCode}).`);
      await wait(100);
    }
    if (!markerValue) throw new Error("Packaged application did not report GUI readiness within 30 seconds.");
    if (markerValue.nonce !== nonce || markerValue.pid !== child.pid || markerValue.startupReady !== true) {
      throw new Error("Packaged application readiness marker is invalid or startup did not reach the current contract.");
    }
  } finally {
    if (child?.exitCode === null && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { env: environment, windowsHide: true, stdio: "ignore" });
      await wait(1_000);
    }
    fs.rmSync(marker, { force: true });
    fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function verifyProcessHelper(helper) {
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-portable-helper-tree-"));
  const grandchildPidPath = path.join(treeRoot, "grandchild.pid");
  const treeScript = path.join(treeRoot, "tree.js");
  fs.writeFileSync(treeScript, [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.argv[2], String(grandchild.pid));",
    "setTimeout(() => {}, 60000);",
  ].join("\n"), "utf8");
  const environment = { ...process.env };
  const child = spawn(helper, [process.execPath, treeScript, grandchildPidPath], {
    cwd: treeRoot,
    env: environment,
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    let grandchildPid = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(grandchildPidPath)) {
        const parsed = Number.parseInt(fs.readFileSync(grandchildPidPath, "utf8"), 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          grandchildPid = parsed;
          break;
        }
      }
      await wait(100);
    }
    if (grandchildPid === null) throw new Error("Packaged verification helper did not start its grandchild fixture.");
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      env: environment,
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status !== 0) throw new Error(`Packaged verification helper could not be terminated (taskkill ${result.status}).`);
    await wait(1_000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = spawnSync("tasklist", ["/fi", `PID eq ${grandchildPid}`, "/fo", "csv", "/nh"], {
        env: environment,
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const alive = new RegExp(`"[^\"]+","?\\s*${grandchildPid}"`, "u").test(probe.stdout ?? "");
      if (!alive) return;
      await wait(100);
    }
    throw new Error(`Packaged verification helper left grandchild ${grandchildPid} alive.`);
  } finally {
    if (child.exitCode === null && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { env: environment, windowsHide: true, stdio: "ignore" });
    }
    fs.rmSync(treeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function main() {
  const executable = path.join(artifact, "agent-loop-orchestrator.exe");
  if (!fs.existsSync(executable)) throw new Error("Portable desktop executable is missing.");
  const helper = walk(artifact, (candidate) => /[\\/]verification-host\.exe$/iu.test(candidate));
  if (!helper) throw new Error("Packaged verification-host.exe was not found in the portable app.");
  await launchAndVerify(executable);
  await verifyProcessHelper(helper);
  process.stdout.write("Portable desktop launch and process-helper smoke passed.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack || error.message) : String(error));
  process.exitCode = 1;
});
