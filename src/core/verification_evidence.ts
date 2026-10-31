import * as path from "node:path";
import { CommandReceipt, NodeVisit, SessionState } from "../shared/domain";
import { browserVerificationCommand } from "./browser_command";
import { nodeTestVerificationCommand } from "./node_test_command";
import { fileMutation } from "./event_evidence";
import {
  evaluateRequirementCoverage,
  parseRequirementEvidence,
  RequirementItem,
} from "./requirement_ledger";
import { obj, Obj } from "./values";

// Decode one literal argv layer; never evaluate substitutions or shell operators.
export function literalShellWords(input: string): string[] | null {
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === "\\" && quote !== "'") {
      const next = input[i + 1];
      if (next === undefined) return null;
      if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(next)) {
        word += c;
        started = true;
        continue;
      }
      word += next;
      i++;
      started = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
      started = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    if (/[;&|<>`$]/.test(c)) return null;
    word += c;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

export function canonicalCommand(command: string): string {
  command = command.trim();
  const words = literalShellWords(command);
  if (
    words?.length === 3 &&
    /^(?:ba|z|da|k)?sh$/.test(words[0]!.split(/[\\/]/).at(-1)!) &&
    /^-[a-z]*c$/.test(words[1]!)
  )
    return words[2]!.trim();
  return command;
}

export function checkCommandKey(command: string): string {
  // Output capture does not alter the check's exit status; never strip pipes,
  // command chaining, substitutions or a failure-masking suffix.
  return canonicalCommand(command.trim().replace(/^`([^`]+)`$/, "$1"))
    .replace(
      /\s+>\s*(?:'[^']*'|"[^"$`]*"|(?:\\[^\r\n]|[^\s;&|$`\\])+)(?:\s+2>&1)?\s*$/,
      "",
    )
    .trim();
}

export function ownedVerificationCapture(
  command: string,
  cwd: string,
): boolean {
  const match = command.match(
    /\s+>\s*((?:'[^']*'|"[^"$`]*"|(?:\\[^\r\n]|[^\s;&|$`\\])+))(?:\s+2>&1)?\s*$/,
  );
  const words = match ? literalShellWords(match[1]!) : null;
  if (words?.length !== 1) return false;
  const api = /^[A-Za-z]:[\\/]/.test(cwd) ? path.win32 : path.posix;
  return (
    /^[a-zA-Z0-9_.-]+$/.test(api.basename(words[0]!)) &&
    verificationDirectory(api.dirname(words[0]!), cwd)
  );
}

/** Literal preparation may create only output directories owned by this check. */
export function verificationDirectory(name: string, cwd?: string): boolean {
  if (/[\r\n\0]/.test(name) || name.split(/[\\/]/).includes("..")) return false;
  const api = cwd && /^[A-Za-z]:[\\/]/.test(cwd) ? path.win32 : path.posix;
  const relative = cwd
    ? api.relative(api.resolve(cwd, "verification"), api.resolve(cwd, name))
    : name.replace(/^verification\/?/, "");
  if (!cwd && !/^verification(?:\/|$)/.test(name)) return false;
  return (
    relative === "" ||
    /^[a-zA-Z0-9_-]+(?:[\\/][a-zA-Z0-9_-]+)*[\\/]?$/.test(relative)
  );
}
export function verificationMkdir(command: string, cwd?: string): boolean {
  if (/[\r\n]/.test(command)) return false;
  const words = literalShellWords(command);
  return (
    !!words &&
    words.length >= 3 &&
    words[0] === "mkdir" &&
    words[1] === "-p" &&
    words.slice(2).every((name) => verificationDirectory(name, cwd))
  );
}
export function verificationSetupParts(
  command: string,
  cwd?: string,
): { preparation: string[]; body: string } | null {
  const segments = command.split(/\s*&&\s*/);
  if (segments.length > 4) return null;
  const preparation: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    const words = literalShellWords(segment);
    const api = cwd && /^[A-Za-z]:[\\/]/.test(cwd) ? path.win32 : path.posix;
    if (
      cwd &&
      words?.length === 2 &&
      words[0] === "cd" &&
      !/[\r\n]/.test(segment) &&
      api.relative(api.resolve(cwd), api.resolve(cwd, words[1]!)) === ""
    )
      continue;
    if (!verificationMkdir(segment, cwd)) return null;
    preparation.push(segment);
  }
  return { preparation, body: segments.at(-1)!.trim() };
}

/** Ignore owned output setup and cd to the already-owned project only. */
export function projectCommandKey(command: string, cwd?: string): string {
  const key = checkCommandKey(command);
  return verificationSetupParts(key, cwd)?.body ?? key;
}

export function isBrowserVerificationCommand(
  command: string,
  cwd?: string,
): boolean {
  const native = canonicalCommand(command);
  return (
    !/[`$]/.test(native) &&
    projectCommandKey(native, cwd) === browserVerificationCommand()
  );
}

// Fail closed for report-only commands (cat/echo), pipelines and masked exits.
// This proves execution, not the adequacy or honesty of model-authored tests.
export function isVerificationCommand(command: string, cwd?: string): boolean {
  const c = canonicalCommand(command);
  if (isBrowserVerificationCommand(c, cwd)) return true;
  if (
    !/[`$]/.test(c) &&
    projectCommandKey(c, cwd) === nodeTestVerificationCommand()
  )
    return true;
  // Do not accept a backgrounded test whose shell exits before the test does.
  if (c.replace(/2>&1/g, "").replace(/&&/g, "").includes("&")) return false;
  if (/[\n;|`]/.test(c) || /\$\(/.test(c)) return false;
  let parts = verificationSetupParts(c, cwd);
  // Historical callers without a known project may recognize a literal cd;
  // runtime receipts always supply cwd and still reject a different project.
  if (!parts && !cwd) {
    const segments = c.split(/\s*&&\s*/),
      words = literalShellWords(segments[0]!);
    if (segments.length === 2 && words?.length === 2 && words[0] === "cd")
      parts = { preparation: [], body: segments[1]! };
  }
  if (!parts) return false;
  return /^(?:(?:[A-Za-z_][\w]*=[^\s]+)\s+)*(?:(?:\S*[\\/])?)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|verify)(?:[:\s]|$)|node\s+(?:--test(?:[=\s]|$)|["']?(?:[^\s]*[\\/])?(?:test|verify|check)[^\s]*\.[cm]?js\b)|(?:npx\s+)?(?:vitest|jest|playwright\s+test)\b|(?:python[\d.]*\s+-m\s+)?pytest\b|(?:cargo|go|dotnet)\s+test\b)/i.test(
    parts.body,
  );
}

/** Receipts come only from native completed tool events, after redaction. */
export class CommandTracker {
  constructor(
    private readonly cwd?: string,
    private readonly sourcesGuarded = false,
  ) {}
  readonly receipts: CommandReceipt[] = [];
  private readonly pending = new Map<string, string>();
  private record(
    id: unknown,
    command: unknown,
    exit: unknown,
    output: unknown,
    failed = false,
  ): void {
    if (
      typeof command !== "string" ||
      command.length > 4096 ||
      !isVerificationCommand(command, this.cwd)
    )
      return;
    const code =
      typeof exit === "number" &&
      Number.isInteger(exit) &&
      !(failed && exit === 0)
        ? exit
        : null;
    const text = typeof output === "string" ? output : "";
    const blocked =
      (code !== 0 || failed) &&
      /(?:listen\s+(?:EPERM|EACCES)|(?:EPERM|EACCES)[^\n]{0,80}(?:listen|bind)|sandbox[^\n]{0,80}(?:denied|not permitted)|network[^\n]{0,60}(?:unreachable|disabled)|ENETUNREACH|EAI_AGAIN|permission denied)/i.exec(
        text,
      );
    const receipt: CommandReceipt = {
      id: String(id ?? "unknown"),
      command: canonicalCommand(command),
      exitCode: code,
      environmentError: blocked ? blocked[0].slice(0, 300) : null,
    };
    const old = this.receipts.findIndex(
      (r) =>
        projectCommandKey(r.command, this.cwd) ===
        projectCommandKey(receipt.command, this.cwd),
    );
    if (old >= 0) this.receipts.splice(old, 1);
    this.receipts.push(receipt);
    if (this.receipts.length > 64) this.receipts.shift();
  }
  observe(event: Obj): void {
    if (!this.sourcesGuarded && fileMutation(event)) this.receipts.length = 0;
    const item = obj(event.item),
      part = obj(event.part),
      state = obj(part.state);
    if (event.type === "item.completed" && item.type === "command_execution")
      this.record(
        item.id,
        item.command,
        item.exit_code,
        item.aggregated_output,
        item.status === "failed",
      );
    if (
      event.type === "tool_use" &&
      /^(?:bash|shell)$/i.test(String(part.tool)) &&
      ["completed", "error"].includes(String(state.status))
    )
      this.record(
        part.callID ?? part.id,
        obj(state.input).command,
        obj(state.metadata).exit,
        state.output ?? state.error,
        state.status === "error",
      );
    const content = obj(event.message).content;
    if (Array.isArray(content))
      for (const entry of content) {
        const b = obj(entry);
        if (
          event.type === "assistant" &&
          b.type === "tool_use" &&
          b.name === "Bash" &&
          typeof b.id === "string" &&
          typeof obj(b.input).command === "string"
        ) {
          this.pending.set(b.id, obj(b.input).command as string);
          if (this.pending.size > 64)
            this.pending.delete(this.pending.keys().next().value!);
        }
        if (
          event.type === "user" &&
          b.type === "tool_result" &&
          typeof b.tool_use_id === "string"
        ) {
          const command = this.pending.get(b.tool_use_id);
          this.pending.delete(b.tool_use_id);
          // Claude's native tool_result reports failure via is_error, not exit_code.
          this.record(
            b.tool_use_id,
            command,
            b.is_error === false ? 0 : null,
            b.content,
            b.is_error === true,
          );
        }
      }
  }
}

export function mergeProjectReceipts(
  cwd: string | undefined,
  ...groups: (CommandReceipt[] | undefined)[]
): CommandReceipt[] {
  const latest = new Map<string, CommandReceipt>();
  for (const r of groups.flatMap((g) => g ?? []))
    latest.set(projectCommandKey(r.command, cwd), r);
  return [...latest.values()].slice(-64);
}

export function acceptedVisit(visit: NodeVisit, cwd?: string): boolean {
  const attempt = visit.attempts?.at(-1);
  return (
    visit.status === "succeeded" &&
    !!visit.completedAt &&
    attempt?.completionAccepted === true &&
    !attempt.verificationInvalidation &&
    attempt.status === "succeeded" &&
    !attempt.failureKind &&
    !!attempt.endedAt &&
    !attempt.pid &&
    !failedVerificationCommand(visitCommands(visit, cwd)) &&
    visit.output.trim().split("\n").at(-1)?.trim() === "[PHASE_DONE]"
  );
}

/** A receipt proves a check only with exit 0 and no environment failure. */
export const commandSucceeded = (c: CommandReceipt): boolean =>
  c.exitCode === 0 && !c.environmentError;

/** Shared negative evidence policy for test, review, approval and terminal gates. */
export function failedVerificationCommand(
  commands: CommandReceipt[],
): CommandReceipt | undefined {
  return commands.find((c) => !commandSucceeded(c));
}

export function visitCommands(
  visit: NodeVisit,
  cwd?: string,
): CommandReceipt[] {
  let commands: CommandReceipt[] = [];
  for (const attempt of visit.attempts ?? []) {
    if (attempt.verificationInvalidation) {
      commands = [];
      continue;
    }
    if (attempt.fileMutation) commands = [];
    commands = mergeProjectReceipts(cwd, commands, attempt.commands);
  }
  return commands;
}

export function verifiedTestCommands(
  visit: NodeVisit,
  requirements: RequirementItem[],
  cwd?: string,
): CommandReceipt[] {
  if (
    !requirements.length ||
    !acceptedVisit(visit, cwd) ||
    visit.verdict !== "PASS" ||
    !evaluateRequirementCoverage(visit.output, requirements).allSatisfied
  )
    return [];
  // Reconstruct from observed attempt receipts, never from prose or a saved verdict.
  const commands = visitCommands(visit, cwd);
  if (
    !commands.length ||
    failedVerificationCommand(commands) ||
    commands.some((c) => !isVerificationCommand(c.command, cwd))
  )
    return [];
  const records = new Map(
    parseRequirementEvidence(visit.output).map((r) => [r.requirementId, r]),
  );
  if (
    requirements.some((r) => {
      const command = records.get(r.id)?.checkCommand;
      return (
        !command ||
        !commands.some(
          (c) => checkCommandKey(c.command) === checkCommandKey(command),
        )
      );
    })
  )
    return [];
  return commands;
}

/** Only a current, accepted test visit can authorize review/final approval.
 * New work, failed visits, interrupts and observed mutations invalidate it.
 * Old snapshots lacking acceptance metadata remain readable, but fail closed.
 */
export function currentTestProof(
  state: SessionState,
  before: NodeVisit,
): CommandReceipt[] {
  let proof: CommandReceipt[] = [];
  for (const visit of state.visits) {
    if (visit.attempts?.some((a) => a.fileMutation)) proof = [];
    if (visit.id === before.id) break;
    const type = state.graph.nodes.find((n) => n.id === visit.nodeId)?.type;
    if (type !== "review" && type !== "approval") proof = [];
    if (type === "test") {
      proof = verifiedTestCommands(
        visit,
        state.requirements.items,
        state.targetProjectPath,
      );
      if (
        state.graph.automation?.browserVerification &&
        !proof.some((c) =>
          isBrowserVerificationCommand(c.command, state.targetProjectPath),
        )
      )
        proof = [];
    }
    if (
      (type === "review" || type === "approval") &&
      (!acceptedVisit(visit, state.targetProjectPath) ||
        visit.verdict !== "APPROVED" ||
        !evaluateRequirementCoverage(visit.output, state.requirements.items)
          .allSatisfied)
    )
      proof = [];
  }
  return proof;
}
export function currentNodeTestProof(state: SessionState, before: NodeVisit) {
  if (!currentTestProof(state, before).length) return undefined;
  const index = state.visits.findIndex((v) => v.id === before.id);
  return state.visits
    .slice(0, index)
    .reverse()
    .find(
      (v) =>
        state.graph.nodes.find((n) => n.id === v.nodeId)?.type === "test" &&
        acceptedVisit(v, state.targetProjectPath) &&
        v.verdict === "PASS",
    )?.nodeTestProof;
}
