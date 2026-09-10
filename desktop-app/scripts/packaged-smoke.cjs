#!/usr/bin/env node

// Install, launch, and uninstall the exact Squirrel candidate. Squirrel uses
// the Windows user profile selected by the runner (it does not honor a
// process-local APPDATA override), so refuse to run over an existing install
// and clean only the install root created by this smoke.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

if (process.platform !== "win32") {
  throw new Error("Packaged Squirrel smoke is only supported on Windows.");
}

const setup = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!setup || !fs.existsSync(setup) || !setup.toLowerCase().endsWith(".exe")) {
  throw new Error("Usage: node scripts/packaged-smoke.cjs <Setup.exe>");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function walk(directory, predicate, depth = 0) {
  if (depth > 12 || !fs.existsSync(directory)) return null;
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

function runInstaller(file, args, env, allowNonZero = false) {
  const result = spawnSync(file, args, {
    env,
    cwd: path.dirname(file),
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowNonZero) {
    throw new Error(`${path.basename(file)} ${args.join(" ")} exited with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function installCandidate(file, env, installRoot) {
  let spawnError = null;
  let installer;
  try {
    installer = spawn(file, ["/S"], {
      cwd: path.dirname(file),
      env,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Squirrel Setup.exe could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  installer.once("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 120_000;
  let executable = null;
  while (Date.now() < deadline && !executable) {
    executable = walk(installRoot, (candidate) => /agent-loop-orchestrator\.exe$/iu.test(candidate));
    if (!executable) {
      if (spawnError) throw new Error(`Squirrel Setup.exe could not start: ${spawnError.message}`);
      if (installer.exitCode !== null && installer.exitCode !== 0) {
        throw new Error(`Squirrel Setup.exe exited with ${installer.exitCode} before installing the candidate.`);
      }
      await wait(250);
    }
  }
  if (!executable) throw new Error("Squirrel Setup.exe did not produce the packaged executable.");
  // Squirrel may still hold the newly copied executable while its lifecycle
  // callback runs. Give it a short window to release the file before forcing
  // cleanup of a wrapper that failed to exit.
  for (let attempt = 0; attempt < 60 && installer.exitCode === null; attempt += 1) {
    await wait(250);
  }
  if (installer.exitCode === null && installer.pid) {
    spawnSync("taskkill", ["/pid", String(installer.pid), "/t", "/f"], { env, windowsHide: true, stdio: "ignore" });
  }
  return executable;
}

async function launchAndVerify(executable, env) {
  let child = null;
  let startError = null;
  for (let attempt = 0; attempt < 60 && !child; attempt += 1) {
    try {
      child = spawn(executable, [], {
        cwd: path.dirname(executable),
        env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      startError = error;
      if (!(error && typeof error === "object" && "code" in error && error.code === "EBUSY")) throw error;
      await wait(500);
    }
  }
  if (!child) throw new Error(`Packaged application could not start: ${startError instanceof Error ? startError.message : String(startError)}`);
  let spawnError = null;
  child.once("error", (error) => { spawnError = error; });
  await wait(6_000);
  if (spawnError) throw new Error(`Packaged application could not start: ${spawnError.message}`);
  if (child.exitCode !== null && child.exitCode !== 0) {
    throw new Error(`Packaged application exited before smoke verification (code ${child.exitCode}).`);
  }
  if (child.exitCode === null && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { env, windowsHide: true, stdio: "ignore" });
  }
  await wait(1_000);
}

async function verifyPackagedVerificationHelper(installRoot, env) {
  const helper = walk(installRoot, (candidate) =>
    /[\\/]verification-host\.exe$/iu.test(candidate)
  );
  if (!helper) throw new Error("Packaged verification-host.exe was not found in the installed app.");
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-packaged-helper-tree-"));
  const grandchildPidPath = path.join(treeRoot, "grandchild.pid");
  const treeScript = path.join(treeRoot, "tree.js");
  fs.writeFileSync(
    treeScript,
    [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[2], String(grandchild.pid));",
      "setTimeout(() => {}, 60000);",
    ].join("\n"),
    "utf8"
  );
  const child = spawn(helper, [process.execPath, treeScript, grandchildPidPath], {
    cwd: treeRoot,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnError = null;
  child.once("error", (error) => { spawnError = error; });
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
    if (spawnError) throw new Error(`Packaged verification helper could not start: ${spawnError.message}`);
    if (grandchildPid === null) throw new Error("Packaged verification helper did not start its grandchild fixture.");
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status !== 0) throw new Error(`Packaged verification helper could not be terminated (taskkill ${result.status}).`);
    await wait(1_000);
    if (child.exitCode === null) throw new Error("Packaged verification helper did not terminate its process tree.");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = spawnSync("tasklist", ["/fi", `PID eq ${grandchildPid}`, "/fo", "csv", "/nh"], {
        env,
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const alive = new RegExp(`"[^"]+","?\\s*${grandchildPid}"`, "u").test(probe.stdout ?? "");
      if (!alive) return;
      await wait(100);
    }
    throw new Error(`Packaged verification helper left grandchild ${grandchildPid} alive.`);
  } finally {
    if (child.exitCode === null && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        env,
        windowsHide: true,
        stdio: "ignore",
      });
    }
    fs.rmSync(treeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function main() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is required for Squirrel smoke.");
  const installRoot = path.join(localAppData, "agent_loop_orchestrator");
  if (fs.existsSync(installRoot)) {
    throw new Error(`Refusing to overwrite an existing Squirrel installation: ${installRoot}`);
  }
  const processIdsBefore = new Set(
    (spawnSync("tasklist", ["/fi", "IMAGENAME eq agent-loop-orchestrator.exe", "/fo", "csv", "/nh"], {
      env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.match(/"[^"]+","?(\d+)"/u)?.[1])
      .filter((pid) => pid !== undefined)
  );
  let executable = null;
  try {
    executable = await installCandidate(setup, env, installRoot);
    await launchAndVerify(executable, env);
    await verifyPackagedVerificationHelper(installRoot, env);
    const updater = path.join(installRoot, "Update.exe");
    if (!fs.existsSync(updater)) throw new Error("Squirrel Update.exe was not found for uninstall.");
    const uninstall = runInstaller(updater, ["--uninstall"], env, true);
    for (let attempt = 0; attempt < 30 && fs.existsSync(executable); attempt += 1) await wait(500);
    if (uninstall.status !== 0 && fs.existsSync(executable)) {
      throw new Error(`Squirrel uninstall exited with ${uninstall.status} and left the packaged executable behind.`);
    }
    if (fs.existsSync(executable)) throw new Error("Squirrel uninstall left the packaged executable behind.");
    process.stdout.write("Packaged Setup.exe install, launch, and uninstall smoke passed.\n");
  } finally {
    const processIdsAfter = (spawnSync("tasklist", ["/fi", "IMAGENAME eq agent-loop-orchestrator.exe", "/fo", "csv", "/nh"], {
      env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).stdout ?? "");
    for (const line of processIdsAfter.split(/\r?\n/u)) {
      const pid = line.match(/"[^"]+","?(\d+)"/u)?.[1];
      if (pid && !processIdsBefore.has(pid)) {
        spawnSync("taskkill", ["/pid", pid, "/t", "/f"], { env, windowsHide: true, stdio: "ignore" });
      }
    }
    // Squirrel may leave a partial root if installation is interrupted. This
    // root was absent before the test and is safe to remove after process
    // cleanup; a pre-existing installation is rejected above.
    if (fs.existsSync(installRoot)) fs.rmSync(installRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack || error.message) : String(error));
  process.exitCode = 1;
});
