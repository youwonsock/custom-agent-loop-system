import { execFile } from "node:child_process";
import { delay } from "./resilience";

const SAMPLE_MS = 500;
interface ProcessRow {
  pid: number;
  parent: number;
  started: string;
}
function processTable(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,lstart="],
      { timeout: 2000 },
      (error, stdout) => {
        if (error) return resolve([]);
        const rows: ProcessRow[] = [];
        for (const line of stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
          if (match)
            rows.push({
              pid: Number(match[1]),
              parent: Number(match[2]),
              started: match[3]!,
            });
        }
        resolve(rows);
      },
    );
  });
}
const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {
    // It already exited.
  }
};
/**
 * A CLI's background server is reparented when the CLI exits, so a process tree
 * kill no longer reaches it. Sampling the tree while the CLI runs is what still
 * identifies those survivors. The start time guards against a reused PID.
 */
export class DescendantWatch {
  private readonly seen = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;
  private sampling: Promise<void> = Promise.resolve();
  constructor(private readonly root: number) {}
  start(): void {
    if (process.platform === "win32") return;
    this.timer = setInterval(() => {
      this.sampling = this.sampling.then(async () => {
        await this.sample();
      });
    }, SAMPLE_MS);
    this.timer.unref();
  }
  private async sample(): Promise<ProcessRow[]> {
    const table = await processTable();
    const owned = new Set([this.root, ...this.seen.keys()]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of table)
        if (owned.has(row.parent) && !owned.has(row.pid)) {
          owned.add(row.pid);
          this.seen.set(row.pid, row.started);
          grew = true;
        }
    }
    return table;
  }
  /** Stops watching and ends what the CLI left running; returns their PIDs. */
  async reap(timeoutMs: number): Promise<number[]> {
    if (!this.timer) return [];
    clearInterval(this.timer);
    await this.sampling;
    const survivors = async () => {
      const table = await this.sample();
      return table
        .filter((row) => this.seen.get(row.pid) === row.started)
        .map((row) => row.pid);
    };
    const pids = await survivors();
    if (!pids.length) return [];
    for (const pid of pids) signal(pid, "SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(50);
      if (!(await survivors()).length) return pids;
    }
    for (const pid of await survivors()) signal(pid, "SIGKILL");
    return pids;
  }
}
