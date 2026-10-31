import * as path from "node:path";
import { CommandReceipt, SessionState, NodeVisit } from "../shared/domain";
import {
  canonicalCommand,
  checkCommandKey,
  literalShellWords,
  projectCommandKey,
  currentTestProof,
  verificationMkdir,
  verificationSetupParts,
} from "./verification_evidence";
import { sourceHashes } from "./verification_sources";
import { inspectionSegments, stripInspectionStderr } from "./inspection_syntax";
import { obj, Obj } from "./values";

export const TEST_POLICY = "[AGENT_GRAPH_TEST_POLICY]";
export const TEST_FAILED = "[AGENT_GRAPH_TEST_FAILED]";

/** Test sources are immutable; only registered checks and inspection/preparation are allowed. */
export function testCommandAllowed(
  command: string,
  cwd: string,
  registered: string[],
): boolean {
  let text = canonicalCommand(command).trim();
  const setup = verificationSetupParts(text, cwd);
  if (setup) {
    text = setup.body;
    if (registered.some((c) => text === c || text === checkCommandKey(c)))
      return true;
    if (verificationMkdir(text, cwd)) return true;
  }
  // These chains contain inspection only, never checks or writes. Their exit
  // statuses cannot become verification receipts (the receipt gate stays strict).
  const parts = inspectionSegments(text);
  if (!parts) return false;
  return parts.every((part) => {
    let segment = stripInspectionStderr(part.text);
    if (/^echo\s/.test(segment))
      segment = segment
        .replace(/\$\?/g, "STATUS")
        .replace(/\$LASTEXITCODE\b/g, "STATUS");
    if (/[\r\n`$<>]/.test(segment)) return false;
    const words = literalShellWords(segment);
    if (!words?.length) return false;
    const name = words[0]!.split(/[\\/]/).at(-1)!.toLowerCase();
    if (name === "node" || name === "npm")
      return words.length === 2 && words[1] === "--version";
    if (name === "echo") return true;
    if (name === "sed")
      return (
        words.length === 4 &&
        words[1] === "-n" &&
        /^\d+(?:,\d+)?p$/.test(words[2]!)
      );
    if (
      ![
        "cat",
        "type",
        "head",
        "tail",
        "pwd",
        "ls",
        "rg",
        "grep",
        "wc",
        "stat",
        "get-content",
        "get-childitem",
      ].includes(name)
    )
      return false;
    return !words
      .slice(1)
      .some((w) => /^--pre(?:=|$)|^--files-without-match=/.test(w));
  });
}

export function testPolicyEvent(event: Obj): string | null {
  const part = obj(event.part),
    state = obj(part.state);
  return event.type === "tool_use" &&
    state.status === "error" &&
    typeof state.error === "string" &&
    state.error.includes(TEST_POLICY)
    ? state.error.slice(0, 6000)
    : null;
}
export function failedRegisteredCheck(
  receipts: CommandReceipt[],
  cwd: string,
  registered: string[],
): CommandReceipt | undefined {
  return receipts.find(
    (c) =>
      c.exitCode !== 0 &&
      !c.environmentError &&
      registered.some(
        (r) => projectCommandKey(c.command, cwd) === projectCommandKey(r, cwd),
      ),
  );
}
export function sourceDifference(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (f) => before[f] !== after[f],
  );
}
export function validSourceHashes(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).length <= 10000 &&
    Object.entries(v).every(
      ([p, h]) =>
        p.length > 0 &&
        p.length < 2000 &&
        !p.startsWith("/") &&
        !/[\\\0]/.test(p) &&
        p.split("/").every((s) => s !== ".." && s !== "." && !!s) &&
        typeof h === "string" &&
        /^[a-f0-9]{64}$/.test(h),
    )
  );
}
export async function testSources(
  root: string,
): Promise<Record<string, string>> {
  return sourceHashes(root, path.join(root, "verification"));
}
export function currentVerificationSources(
  state: SessionState,
  before: NodeVisit,
): Record<string, string> | undefined {
  if (!currentTestProof(state, before).length) return undefined;
  return state.visits
    .slice(
      0,
      state.visits.findIndex((v) => v.id === before.id),
    )
    .reverse()
    .find(
      (v) =>
        state.graph.nodes.find((n) => n.id === v.nodeId)?.type === "test" &&
        v.verdict === "PASS" &&
        v.status === "succeeded",
    )?.verificationSourceHashes;
}
