import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

function installedVsCodeExecutable(): string | undefined {
  const explicit = process.env.VSCODE_EXECUTABLE_PATH;
  if (explicit) return path.resolve(explicit);
  const candidates = process.platform === "win32"
    ? [
        process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe")
          : "",
        process.env.ProgramFiles
          ? path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe")
          : "",
      ]
    : process.platform === "darwin"
      ? ["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"]
      : ["/usr/bin/code", "/usr/share/code/code"];
  return candidates.find(Boolean);
}

async function main(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-extension-host-"));
  const workspacePath = path.join(testRoot, "workspace");
  const dataRoot = path.join(testRoot, "data");
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(dataRoot, { recursive: true }),
  ]);
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  try {
    await runTests({
      ...(installedVsCodeExecutable()
        ? { vscodeExecutablePath: installedVsCodeExecutable() }
        : { version: "1.133.0" }),
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, "extensionHostSuite.js"),
      extensionTestsEnv: {
        AGENT_LOOP_E2E_DATA_ROOT: dataRoot,
      },
      launchArgs: [
        workspacePath,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
