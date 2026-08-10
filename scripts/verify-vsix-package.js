#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { spawn, spawnSync } = require("node:child_process");
const yauzl = require("yauzl");

const root = path.resolve(__dirname, "..");
const extensionRoot = path.join(root, "vscode-extension");
const extensionPackage = require(path.join(extensionRoot, "package.json"));
const corePackage = require(path.join(root, "package.json"));
const nativeTarget = `${process.platform}-${process.arch}`;
const expectedName = `agent-loop-vscode-${nativeTarget}-${extensionPackage.version}.vsix`;
const suppliedPath = process.argv[2];
const vsixPath = suppliedPath
  ? path.resolve(suppliedPath)
  : path.join(extensionRoot, expectedName);
const MAX_HELPER_OUTPUT_BYTES = 256 * 1024;
const HELPER_TIMEOUT_MS = 30_000;
const HELPER_TERMINATION_WAIT_MS = 5_000;
const TEMPORARY_ROOT_CLEANUP_TIMEOUT_MS = 15_000;

function fail(message) {
  throw new Error(`[verify-vsix] ${message}`);
}

function errorText(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function appendBoundedOutput(state, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_HELPER_OUTPUT_BYTES - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (buffer.length > remaining) {
    state.chunks.push(buffer.subarray(0, remaining));
    state.bytes += remaining;
    state.truncated = true;
    return;
  }
  state.chunks.push(buffer);
  state.bytes += buffer.length;
}

function renderBoundedOutput(state) {
  const output = Buffer.concat(state.chunks, state.bytes).toString("utf8");
  return state.truncated
    ? `${output}\n[verify-vsix] helper output truncated at ${MAX_HELPER_OUTPUT_BYTES} bytes`
    : output;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function raceWithTimeout(promise, milliseconds, timeoutResult) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutResult), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function runCleanupCommand(file, args, timeoutMs) {
  return new Promise((resolve) => {
    const stdoutState = { chunks: [], bytes: 0, truncated: false };
    const stderrState = { chunks: [], bytes: 0, truncated: false };
    let spawnError;
    let settled = false;
    const cleanup = spawn(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanup.stdout.on("data", (chunk) => appendBoundedOutput(stdoutState, chunk));
    cleanup.stderr.on("data", (chunk) => appendBoundedOutput(stderrState, chunk));
    cleanup.once("error", (error) => {
      spawnError = error;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup.kill("SIGKILL");
      cleanup.stdout.destroy();
      cleanup.stderr.destroy();
      cleanup.unref();
      resolve({
        code: null,
        signal: "SIGKILL",
        error: new Error(`cleanup command timed out after ${timeoutMs}ms`),
        stdout: renderBoundedOutput(stdoutState),
        stderr: renderBoundedOutput(stderrState),
      });
    }, timeoutMs);
    cleanup.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        error: spawnError,
        stdout: renderBoundedOutput(stdoutState),
        stderr: renderBoundedOutput(stderrState),
      });
    });
  });
}

async function terminateOwnedProcessTree(child) {
  if (!child.pid) return "helper PID was unavailable";
  if (child.exitCode !== null || child.signalCode !== null) {
    return "helper had already exited before tree termination";
  }

  if (process.platform === "win32") {
    const result = await runCleanupCommand(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      HELPER_TERMINATION_WAIT_MS
    );
    const detail = result.error
      ? errorText(result.error)
      : result.code === 0
        ? "taskkill completed"
        : `taskkill exited with ${result.code}${result.signal ? ` (${result.signal})` : ""}`;
    const output = `${result.stderr}\n${result.stdout}`.trim();
    return result.code !== 0 && output ? `${detail}: ${output}` : detail;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error && error.code !== "ESRCH") {
      return `SIGTERM failed: ${errorText(error)}`;
    }
  }
  await delay(250);
  try {
    process.kill(-child.pid, "SIGKILL");
    return "sent SIGTERM then SIGKILL to the helper process group";
  } catch (error) {
    if (error && error.code === "ESRCH") {
      return "helper process group exited after SIGTERM";
    }
    return `SIGKILL failed: ${errorText(error)}`;
  }
}

async function runBoundedHelper(label, file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? HELPER_TIMEOUT_MS;
  const stdoutState = { chunks: [], bytes: 0, truncated: false };
  const stderrState = { chunks: [], bytes: 0, truncated: false };
  let spawnError;
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => appendBoundedOutput(stdoutState, chunk));
  child.stderr.on("data", (chunk) => appendBoundedOutput(stderrState, chunk));
  child.once("error", (error) => {
    spawnError = error;
  });

  const completion = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const first = await raceWithTimeout(completion, timeoutMs, { timedOut: true });
  if (!first.timedOut) {
    if (spawnError) fail(`${label} failed to start: ${spawnError.message}`);
    return {
      ...first,
      pid: child.pid,
      stdout: renderBoundedOutput(stdoutState),
      stderr: renderBoundedOutput(stderrState),
    };
  }

  const cleanupDiagnostic = await terminateOwnedProcessTree(child);
  const afterTermination = await raceWithTimeout(completion, HELPER_TERMINATION_WAIT_MS, {
    terminationTimedOut: true,
  });
  if (afterTermination.terminationTimedOut) {
    child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  const stdout = renderBoundedOutput(stdoutState);
  const stderr = renderBoundedOutput(stderrState);
  const captured = `${stderr}\n${stdout}`.trim();
  const timeoutError = new Error(
    `[verify-vsix] ${label} timed out after ${timeoutMs}ms (pid ${child.pid}); ` +
      `owned-tree cleanup: ${cleanupDiagnostic}` +
      (captured ? `\n${captured}` : "")
  );
  timeoutError.helperPid = child.pid;
  throw timeoutError;
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`Missing ${label}: ${filePath}`);
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function lexicalSort(values) {
  return values.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function npmPackagePurl(name, version) {
  const encodedName = name.startsWith("@")
    ? name.split("/").map((part) => encodeURIComponent(part)).join("/")
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function bundledPackageDirectories(nodeModulesRoot) {
  if (!fs.existsSync(nodeModulesRoot)) return [];
  const directories = [];
  for (const entry of fs.readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(nodeModulesRoot, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (scoped.isDirectory()) directories.push(path.join(entryPath, scoped.name));
      }
    } else {
      directories.push(entryPath);
    }
  }
  return lexicalSort(directories);
}

function nativeBinaries(directory) {
  const found = [];
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...nativeBinaries(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".node")) found.push(entryPath);
  }
  return lexicalSort(found);
}

function forbiddenSidecars(directory) {
  const found = [];
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...forbiddenSidecars(entryPath));
    else if (
      entry.isFile() &&
      (entry.name.endsWith(".vsix.sha256") || entry.name.endsWith(".vsix.cdx.json"))
    ) {
      found.push(entryPath);
    }
  }
  return found;
}

function writeVsixSbom(extensionPath, manifest) {
  const nodeModulesRoot = path.join(extensionPath, "core", "node_modules");
  const components = bundledPackageDirectories(nodeModulesRoot).map((directory) => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const component = {
      type: "library",
      name: packageJson.name,
      version: packageJson.version,
      purl: npmPackagePurl(packageJson.name, packageJson.version),
    };
    if (typeof packageJson.license === "string" && packageJson.license) {
      component.licenses = [{ license: { id: packageJson.license } }];
    }
    return component;
  });
  for (const binary of nativeBinaries(nodeModulesRoot)) {
    components.push({
      type: "file",
      name: path.relative(extensionPath, binary).replace(/\\/g, "/"),
      hashes: [{ alg: "SHA-256", content: sha256File(binary) }],
    });
  }
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: extensionPackage.name,
        version: extensionPackage.version,
        hashes: [{ alg: "SHA-256", content: sha256File(vsixPath) }],
        properties: [
          { name: "agent-loop:targetPlatform", value: manifest.targetPlatform },
          { name: "agent-loop:coreVersion", value: manifest.coreVersion },
          { name: "agent-loop:artifactFile", value: path.basename(vsixPath) },
        ],
      },
    },
    components,
  };
  fs.writeFileSync(`${vsixPath}.cdx.json`, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
}

async function extractArchive(archivePath, destination) {
  const destinationRoot = path.resolve(destination);
  const destinationPrefix = `${destinationRoot}${path.sep}`;
  const zipfile = await yauzl.openPromise(archivePath, {
    strictFileNames: true,
    validateEntrySizes: true,
  });

  for await (const entry of zipfile.eachEntry()) {
    const entryPath = path.resolve(destinationRoot, ...entry.fileName.split("/"));
    if (entryPath !== destinationRoot && !entryPath.startsWith(destinationPrefix)) {
      fail(`VSIX entry escapes the extraction root: ${entry.fileName}`);
    }
    if (entry.fileName.endsWith("/")) {
      await fs.promises.mkdir(entryPath, { recursive: true });
      continue;
    }
    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
    const input = await zipfile.openReadStreamPromise(entry);
    await pipeline(input, fs.createWriteStream(entryPath, { flags: "wx" }));
  }
}

function verifyCoreEntrypoint(extensionPath, manifest) {
  const entrypoint = path.join(extensionPath, "core", manifest.entrypoint);
  assertFile(entrypoint, "bundled core entrypoint");
  const result = spawnSync(process.execPath, [entrypoint, "--help"], {
    cwd: extensionPath,
    env: { ...process.env, NODE_PATH: "" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) fail(`Bundled core failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`Bundled core --help exited with ${result.status}: ${result.stderr || result.stdout}`);
  }
  if (!/agent-loop/i.test(`${result.stdout}\n${result.stderr}`)) {
    fail("Bundled core --help did not emit the expected CLI identity.");
  }
}

async function verifyNativePty(extensionPath) {
  const packagePath = path.join(extensionPath, "core", "node_modules", "node-pty");
  assertFile(path.join(packagePath, "package.json"), "bundled node-pty package");
  // Load the native module in a short-lived child so Windows releases the DLL before cleanup.
  const result = await runBoundedHelper(
    "Bundled node-pty smoke",
    process.execPath,
    [path.join(__dirname, "pty-smoke-child.js"), packagePath, extensionPath],
    {
      cwd: extensionPath,
      env: { ...process.env, NODE_PATH: "" },
      timeoutMs: HELPER_TIMEOUT_MS,
    }
  );
  if (result.code !== 0) {
    fail(
      `Bundled node-pty smoke exited with ${result.code}` +
        `${result.signal ? ` (${result.signal})` : ""}: ${result.stderr || result.stdout}`
    );
  }
}

async function verifyBundledSupervisor(extensionPath) {
  const supervisorPath = path.join(extensionPath, "core", "dist", "process_supervisor.js");
  assertFile(supervisorPath, "bundled ProcessSupervisor");
  const fakeCliPath = path.join(extensionPath, "bundled-supervisor-fake-cli.js");
  fs.writeFileSync(
    fakeCliPath,
    [
      "const event = {",
      "  type: 'text',",
      "  id: 'vsix-supervisor-smoke',",
      "  part: { id: 'vsix-supervisor-smoke', text: 'AGENT_LOOP_SUPERVISOR_OK\\n[PHASE_DONE]' },",
      "};",
      "process.stdout.write(JSON.stringify(event) + '\\n');",
    ].join("\n"),
    "utf8"
  );
  const result = await runBoundedHelper(
    "Bundled ProcessSupervisor smoke",
    process.execPath,
    [
      path.join(__dirname, "bundled-supervisor-smoke-child.js"),
      supervisorPath,
      fakeCliPath,
      extensionPath,
    ],
    {
      cwd: extensionPath,
      env: { ...process.env, NODE_PATH: "" },
      timeoutMs: HELPER_TIMEOUT_MS,
    }
  );
  if (result.code !== 0) {
    fail(
      `Bundled ProcessSupervisor smoke exited with ${result.code}` +
        `${result.signal ? ` (${result.signal})` : ""}: ${result.stderr || result.stdout}`
    );
  }
}

async function removeTemporaryRoot(temporaryRoot) {
  const cleanupScript = [
    "const fs = require('node:fs/promises');",
    "fs.rm(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })",
    "  .then(() => process.exit(0))",
    "  .catch((error) => { process.stderr.write(String(error.stack || error)); process.exit(1); });",
  ].join("\n");
  const result = await runBoundedHelper(
    "Temporary VSIX extraction cleanup",
    process.execPath,
    ["-e", cleanupScript, temporaryRoot],
    { timeoutMs: TEMPORARY_ROOT_CLEANUP_TIMEOUT_MS }
  );
  if (result.code !== 0) {
    fail(
      `Temporary VSIX extraction cleanup exited with ${result.code}` +
        `${result.signal ? ` (${result.signal})` : ""}: ${result.stderr || result.stdout}`
    );
  }
}

function combinePrimaryAndCleanupErrors(primaryError, cleanupError) {
  const combined = new Error(
    `${errorText(primaryError)}\n[verify-vsix] Cleanup also failed:\n${errorText(cleanupError)}`
  );
  combined.cause = primaryError;
  return combined;
}

async function main() {
  assertFile(vsixPath, `VSIX (${expectedName})`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-vsix-"));
  let primaryError;
  let verified = false;
  try {
    process.stdout.write(`[verify-vsix] Unpacking ${path.basename(vsixPath)}\n`);
    await extractArchive(vsixPath, temporaryRoot);
    const extensionPath = path.join(temporaryRoot, "extension");
    const unpackedPackagePath = path.join(extensionPath, "package.json");
    const bundleManifestPath = path.join(extensionPath, "core", "bundle-manifest.json");
    assertFile(unpackedPackagePath, "extension package.json");
    assertFile(bundleManifestPath, "core bundle manifest");
    const packagedSidecars = forbiddenSidecars(extensionPath);
    if (packagedSidecars.length > 0) {
      fail(
        `VSIX contains generated checksum/SBOM sidecars: ${packagedSidecars
          .map((filePath) => path.relative(extensionPath, filePath).replace(/\\/g, "/"))
          .join(", ")}`
      );
    }
    const unpackedPackage = JSON.parse(fs.readFileSync(unpackedPackagePath, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(bundleManifestPath, "utf8"));
    if (unpackedPackage.version !== extensionPackage.version) {
      fail(`Extension version mismatch: ${unpackedPackage.version} != ${extensionPackage.version}`);
    }
    if (manifest.coreVersion !== corePackage.version) {
      fail(`Core version mismatch: ${manifest.coreVersion} != ${corePackage.version}`);
    }
    if (manifest.targetPlatform !== nativeTarget) {
      fail(`Native target mismatch: ${manifest.targetPlatform} != ${nativeTarget}`);
    }
    process.stdout.write("[verify-vsix] Starting bundled core entrypoint\n");
    verifyCoreEntrypoint(extensionPath, manifest);
    process.stdout.write("[verify-vsix] Starting bundled ProcessSupervisor lifecycle\n");
    await verifyBundledSupervisor(extensionPath);
    process.stdout.write("[verify-vsix] Starting bundled native PTY\n");
    await verifyNativePty(extensionPath);
    writeVsixSbom(extensionPath, manifest);
    verified = true;
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await removeTemporaryRoot(temporaryRoot);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw combinePrimaryAndCleanupErrors(primaryError, cleanupError);
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (verified) {
    process.stdout.write(
      `VSIX verified from unpacked artifact: ${path.basename(vsixPath)} (${nativeTarget})\n`
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exit(1);
  });
}

module.exports = { runBoundedHelper };
