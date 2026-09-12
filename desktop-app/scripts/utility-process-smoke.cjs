const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, utilityProcess } = require("electron");

// Exercise the exact Electron utility-process exit contract used by the
// desktop controller. The core capability command must flush bounded stdout
// and exit without requiring an external Node runtime.
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-utility-smoke-"));
  const coreRoot = path.resolve(__dirname, "..", "core");
  const configRoot = path.join(root, "config");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const environment = { ...process.env, AGENT_LOOP_UTILITY_PROCESS: "1" };
  // The packaged core must start from Electron's embedded runtime even when
  // an external node.exe is not discoverable on PATH.
  environment.PATH = path.dirname(process.execPath);
  delete environment.NODE_OPTIONS;
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = utilityProcess.fork(
    path.join(coreRoot, "dist", "entrypoints", "loop-orchestrator.js"),
    ["capabilities", "--code-root", coreRoot, "--config-root", configRoot, "--data-root", dataRoot],
    { stdio: "pipe", env: environment, serviceName: "agent-loop-utility-smoke" }
  );
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer;
  const appendBounded = (current, chunk) => {
    const limit = 512 * 1024;
    const remaining = limit - Buffer.byteLength(current, "utf8");
    if (remaining <= 0) return current;
    const bytes = Buffer.from(chunk);
    return current + bytes.subarray(0, remaining).toString("utf8");
  };
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
      if (error) {
        reject(error);
        return;
      }
      let payload;
      try { payload = JSON.parse(stdout.trim()); } catch {
        reject(new Error(`Utility process emitted invalid JSON: ${stdout}`));
        return;
      }
      const required = ["compiled-workflow-bundle-v2", "read-only-projection-v2", "verification-proof-v1", "verification-reapproval-v1", "strict-current-contracts-v1", "packaged-core-layout-v2"];
      if (payload.protocolVersion !== 3 || payload.stateSchemaVersion !== 2 ||
          required.some((capability) => !payload.capabilities?.includes(capability))) {
        reject(new Error("Utility process capability handshake is incomplete."));
        return;
      }
      resolve();
    };
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => finish(new Error(`Utility process error: ${error.message}`)));
    child.once("exit", (code) => {
      if (code !== 0) finish(new Error(`Utility process exited with ${String(code)}: ${stderr}`));
      else finish(null);
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish(new Error(`Utility process timed out: ${stderr}`));
    }, 15_000);
  });
}

app.whenReady().then(() => main()).then(
  () => process.stdout.write("Electron utility-process core smoke passed.\n", () => app.exit(0)),
  (error) => { console.error(error instanceof Error ? error.message : String(error)); app.exit(1); }
);
