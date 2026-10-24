import { CommandReceipt, NodeVisit, SessionState } from "../shared/domain";
import { browserVerificationCommand } from "./browser_command";
import { fileMutation } from "./event_evidence";
import {
  evaluateRequirementCoverage,
  parseRequirementEvidence,
  RequirementItem,
} from "./requirement_ledger";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};

// Decode one literal argv layer; never evaluate substitutions or shell operators.
function literalShellWords(input: string): string[] | null {
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
    .replace(/\s+>\s*(?:'[^']*'|"[^"$`]*"|[^\s;&|$`]+)(?:\s+2>&1)?\s*$/, "")
    .trim();
}

export function isBrowserVerificationCommand(command: string): boolean {
  const native = canonicalCommand(command);
  return (
    !/[`$]/.test(native) &&
    checkCommandKey(native) === browserVerificationCommand()
  );
}

// Fail closed for report-only commands (cat/echo), pipelines and masked exits.
// This proves execution, not the adequacy or honesty of model-authored tests.
export function isVerificationCommand(command: string): boolean {
  const c = canonicalCommand(command);
  if (isBrowserVerificationCommand(c)) return true;
  // Do not accept a backgrounded test whose shell exits before the test does.
  if (c.replace(/2>&1/g, "").replace(/&&/g, "").includes("&")) return false;
  if (/[\n;|`]/.test(c) || /\$\(/.test(c)) return false;
  const segments = c.split(/\s*&&\s*/);
  if (
    segments.length > 2 ||
    (segments.length === 2 && !/^cd\s+/.test(segments[0]!))
  )
    return false;
  return /^(?:(?:[A-Za-z_][\w]*=[^\s]+)\s+)*(?:(?:\S*[\\/])?)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|verify)(?:[:\s]|$)|node\s+(?:--test(?:[=\s]|$)|["']?(?:[^\s]*[\\/])?(?:test|verify|check)[^\s]*\.[cm]?js\b)|(?:npx\s+)?(?:vitest|jest|playwright\s+test)\b|(?:python[\d.]*\s+-m\s+)?pytest\b|(?:cargo|go|dotnet)\s+test\b)/i.test(
    segments.at(-1)!,
  );
}

/** Receipts come only from native completed tool events, after redaction. */
export class CommandTracker {
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
      !isVerificationCommand(command)
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
    const old = this.receipts.findIndex((r) => checkCommandKey(r.command) === checkCommandKey(receipt.command));
    if (old >= 0) this.receipts.splice(old, 1);
    this.receipts.push(receipt);
    if (this.receipts.length > 64) this.receipts.shift();
  }
  observe(event: Obj): void {
    if (fileMutation(event)) this.receipts.length = 0;
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

export function mergeReceipts(
  ...groups: (CommandReceipt[] | undefined)[]
): CommandReceipt[] {
  const latest = new Map<string, CommandReceipt>();
  for (const r of groups.flatMap((g) => g ?? [])) latest.set(checkCommandKey(r.command), r);
  return [...latest.values()].slice(-64);
}

export function acceptedVisit(visit: NodeVisit): boolean {
  const attempt = visit.attempts?.at(-1);
  return (
    visit.status === "succeeded" &&
    !!visit.completedAt &&
    attempt?.completionAccepted === true &&
    attempt.status === "succeeded" &&
    !attempt.failureKind &&
    !!attempt.endedAt &&
    !attempt.pid &&
    !failedVerificationCommand(visitCommands(visit)) &&
    visit.output.trim().split("\n").at(-1)?.trim() === "[PHASE_DONE]"
  );
}

/** Shared negative evidence policy for test, review, approval and terminal gates. */
export function failedVerificationCommand(
  commands: CommandReceipt[],
): CommandReceipt | undefined {
  return commands.find((c) => c.exitCode !== 0 || !!c.environmentError);
}

export function visitCommands(visit: NodeVisit): CommandReceipt[] {
  let commands: CommandReceipt[] = [];
  for (const attempt of visit.attempts ?? []) {
    if (attempt.fileMutation) commands = [];
    commands = mergeReceipts(commands, attempt.commands);
  }
  return commands;
}

export function verifiedTestCommands(
  visit: NodeVisit,
  requirements: RequirementItem[],
): CommandReceipt[] {
  if (
    !requirements.length ||
    !acceptedVisit(visit) ||
    visit.verdict !== "PASS" ||
    !evaluateRequirementCoverage(visit.output, requirements).allSatisfied
  )
    return [];
  // Reconstruct from observed attempt receipts, never from prose or a saved verdict.
  const commands = visitCommands(visit);
  if (
    !commands.length ||
    failedVerificationCommand(commands) ||
    commands.some((c) => !isVerificationCommand(c.command))
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
      proof = verifiedTestCommands(visit, state.requirements.items);
      if (
        state.graph.automation?.browserVerification &&
        !proof.some((c) => isBrowserVerificationCommand(c.command))
      )
        proof = [];
    }
    if (
      (type === "review" || type === "approval") &&
      (!acceptedVisit(visit) ||
        visit.verdict !== "APPROVED" ||
        !evaluateRequirementCoverage(visit.output, state.requirements.items)
          .allSatisfied)
    )
      proof = [];
  }
  return proof;
}
