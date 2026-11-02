import { spawn, execFile } from "node:child_process";

export type OutputStream = "stdout" | "stderr";
export interface SupervisedChild {
  pid: number;
  write(data: string): void;
  kill(): void;
  onData(listener: (data: string, stream?: OutputStream) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  onError?(listener: (error: Error) => void): unknown;
}

/** Machine JSON must not pass through a Windows terminal's screen wrapping. */
export function spawnPipeChild(
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): SupervisedChild {
  const child = spawn(binary, args, {
    cwd,
    env,
    stdio: "pipe",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  // Node's decoder preserves UTF-8 characters split between OS pipe chunks.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return {
    pid: child.pid ?? -1,
    write(data) {
      child.stdin.write(data);
    },
    kill() {
      if (!child.pid) return;
      if (process.platform === "win32")
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          () => {},
        );
      else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill();
        }
      }
    },
    onData(listener) {
      child.stdout.on("data", (data) => listener(data, "stdout"));
      child.stderr.on("data", (data) => listener(data, "stderr"));
    },
    onExit(listener) {
      // close follows exit AND the draining of both output streams.
      child.once("close", (code) => listener({ exitCode: code ?? -1 }));
    },
    onError(listener) {
      child.once("error", listener);
    },
  };
}
