import { execFile } from "node:child_process";
import { ProcessLiveness, checkProcessLiveness, delay } from "./resilience";

async function execFileBounded(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true },
      () => resolve(),
    );
    child.on("error", () => resolve());
  });
}

export async function terminateProcessTreeBounded(
  pid: number,
  timeoutMs: number,
): Promise<ProcessLiveness> {
  if (pid <= 0) return "dead";
  if (process.platform === "win32") {
    await execFileBounded(
      "taskkill",
      ["/T", "/F", "/PID", String(pid)],
      timeoutMs,
    );
  } else {
    await execFileBounded(
      "pkill",
      ["-TERM", "-P", String(pid)],
      Math.max(500, timeoutMs / 2),
    );
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It may already have exited.
    }
    await delay(Math.min(500, timeoutMs));
    if (checkProcessLiveness(pid) === "alive") {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It may already have exited.
      }
    }
  }
  return checkProcessLiveness(pid);
}

