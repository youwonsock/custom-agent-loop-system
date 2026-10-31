import * as fs from "node:fs/promises";
import { constants, Stats } from "node:fs";
import * as path from "node:path";
import { CommandReceipt } from "../shared/domain";
import {
  canonicalCommand,
  literalShellWords,
  ownedVerificationCapture,
  projectCommandKey,
} from "./verification_evidence";
import { diagnosticMessage } from "./cli_diagnostics";
import { sha } from "./values";
import { isWithin } from "./access_paths";

const MAX_BYTES = 2 * 1024 * 1024;
type Snapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};
export interface CaptureBaseline {
  command: string;
  file: string;
  root: string;
  preparedAt: number;
  before?: Snapshot;
}
const snapshot = (s: Stats): Snapshot => ({
  dev: s.dev,
  ino: s.ino,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
  size: s.size,
});
function captureFile(command: string, root: string): string | null {
  const text = canonicalCommand(command);
  if (!ownedVerificationCapture(text, root)) return null;
  const match = text.match(
    /\s+>\s*((?:'[^']*'|"[^"$`]*"|(?:\\[^\r\n]|[^\s;&|$`\\])+))(?:\s+2>&1)?\s*$/,
  );
  const words = match ? literalShellWords(match[1]!) : null;
  if (words?.length !== 1) return null;
  const file = path.resolve(root, words[0]!),
    relative = path.relative(path.join(root, "verification"), file);
  return relative && isWithin(path.join(root, "verification"), file)
    ? file
    : null;
}
async function safeStat(root: string, file: string): Promise<Stats> {
  const relative = path.relative(root, file);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw Error("capture symlink");
  }
  const real = await fs.realpath(file);
  if (real !== file) throw Error("capture alias");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)
    throw Error("capture must be a bounded, singly linked regular file");
  return stat;
}
export async function prepareVerificationCaptures(
  cwd: string,
  registered: string[],
): Promise<CaptureBaseline[]> {
  const root = await fs.realpath(cwd),
    preparedAt = Date.now(),
    result: CaptureBaseline[] = [];
  for (const command of registered) {
    const file = captureFile(command, root);
    if (!file) continue;
    let before: Snapshot | undefined;
    try {
      before = snapshot(await safeStat(root, file));
    } catch {}
    result.push({ command, file, root, preparedAt, before });
  }
  return result;
}
/** Captured output can explain a real failed exit; it can never create a pass. */
export async function addCapturedEnvironmentDiagnostics(
  commands: CommandReceipt[],
  baselines: CaptureBaseline[],
  archiveDirectory?: string,
): Promise<void> {
  for (const receipt of commands) {
    if (
      receipt.exitCode === null ||
      receipt.exitCode === 0 ||
      receipt.environmentError
    )
      continue;
    const b = baselines.find(
      (b) =>
        projectCommandKey(receipt.command, b.root) ===
          projectCommandKey(b.command, b.root) &&
        captureFile(receipt.command, b.root) === b.file,
    );
    if (!b) continue;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const current = await safeStat(b.root, b.file),
        now = snapshot(current);
      if (
        current.ctimeMs < b.preparedAt - 1000 ||
        JSON.stringify(now) === JSON.stringify(b.before)
      )
        continue;
      handle = await fs.open(
        b.file,
        constants.O_RDONLY |
          (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
      );
      const opened = await handle.stat();
      if (JSON.stringify(snapshot(opened)) !== JSON.stringify(now)) continue;
      const canonical = await safeStat(b.root, b.file);
      if (canonical.dev !== opened.dev || canonical.ino !== opened.ino)
        continue;
      const buffer = Buffer.alloc(opened.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const r = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (!r.bytesRead) break;
        bytes += r.bytesRead;
      }
      if (
        bytes !== opened.size ||
        JSON.stringify(snapshot(await handle.stat())) !== JSON.stringify(now)
      )
        continue;
      const data = buffer.subarray(0, bytes),
        text = data.toString("utf8"),
        digest = sha(data),
        relative = path.relative(b.root, b.file).split(path.sep).join("/");
      if (archiveDirectory) {
        try {
          await fs.mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
          const name = `${sha(receipt.id).slice(0, 16)}-${digest}.log`;
          await fs.writeFile(path.join(archiveDirectory, name), data, {
            mode: 0o600,
          });
          await fs.appendFile(
            path.join(archiveDirectory, "index.jsonl"),
            JSON.stringify({
              receiptId: receipt.id,
              command: receipt.command,
              exitCode: receipt.exitCode,
              source: relative,
              sha256: digest,
              bytes,
              file: name,
            }) + "\n",
            { mode: 0o600 },
          );
        } catch (error) {
          receipt.environmentError = diagnosticMessage(
            `Verification capture storage unavailable: ${(error as NodeJS.ErrnoException).code ?? "I/O error"}; actual exit ${receipt.exitCode} is preserved.`,
          );
          continue;
        }
      }
      const match =
        /(?:^|\n)[ \t]*(?:#\s*)?(?:Error:\s*)?((?:listen|connect|bind)\s+(?:EPERM|EACCES)\b[^\n]*|(?:EPERM|EACCES)[^\n]{0,80}(?:listen|bind)\b[^\n]*|sandbox[^\n]{0,80}(?:denied|not permitted)\b[^\n]*|network[^\n]{0,60}(?:unreachable|disabled)\b[^\n]*|(?:ENETUNREACH|EAI_AGAIN)\b[^\n]*|permission denied\b[^\n]*)/i.exec(
          text,
        );
      if (match)
        receipt.environmentError = diagnosticMessage(
          `${match[1]!.slice(0, 300)} [capture ${relative}; sha256 ${digest}; ${bytes} bytes]`,
        );
    } catch {
      /* Unverified/stale output is not diagnostic evidence. Keep the real exit. */
    } finally {
      await handle?.close();
    }
  }
}
