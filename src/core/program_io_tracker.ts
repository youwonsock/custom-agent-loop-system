import * as fs from "node:fs";
import * as path from "node:path";
import { preExecutionDenied } from "./event_evidence";
import type { ProgramIoAudit, SessionState } from "../shared/domain";
import { VmPolicy, vmCommandName, cleanupPolicyVms } from "./program_io_vm";
import { obj, Obj } from "./values";
import { sha } from "./values";

import {
  PLATFORM_STOP_FILE,
  ProgramIoPolicy,
  ioVerify,
  unwrapProgramCommand,
  programProofAuthorization,
} from "./program_io";

const BROKER_SETTLE_MS = 15000;

export class ProgramIoTracker {
  private readonly calls = new Map<string, { id: string; command: string }>();
  private unwrapped = 0;
  private stoppedAt: number | null = null;
  constructor(
    readonly policy: ProgramIoPolicy,
    private readonly settleMs = BROKER_SETTLE_MS,
  ) {}
  /** The supervisor's own record, right before it ends a live CLI. Never from output. */
  markPlatformStop(): void {
    if (!this.policy.vm) return;
    try {
      const at = Date.now();
      fs.writeFileSync(
        path.join(this.policy.directory, PLATFORM_STOP_FILE),
        new Date(at).toISOString(),
        { mode: 0o600 },
      );
      this.stoppedAt = at;
    } catch {
      /* Without the record every start-only receipt stays invalid. */
    }
  }
  normalize(event: Obj): Obj {
    const part = obj(event.part),
      state = obj(part.state),
      args = obj(state.input);
    if (
      event.type !== "tool_use" ||
      part.tool !== "bash" ||
      typeof args.command !== "string"
    )
      return event;
    const metadata = obj(state.metadata),
      proof = obj(metadata.agentGraphProgramIo);
    const direct = unwrapProgramCommand(args.command, this.policy);
    const recorded = programProofAuthorization(proof, this.policy);
    // Some CLI versions persist the original input before tool.execute.before.
    // The after hook supplies the same signed authorization, bound to that input.
    const command =
        direct ?? (recorded?.nativeCommand === args.command ? recorded : null),
      terminal = [
        "completed",
        "success",
        "error",
        "failed",
        "denied",
        "rejected",
      ].includes(String(state.status));
    if (terminal) {
      if (
        preExecutionDenied(state.error, state.metadata) ||
        ["denied", "rejected"].includes(String(state.status))
      )
        return command
          ? {
              ...event,
              part: {
                ...part,
                state: {
                  ...state,
                  input: { ...args, command: command.command },
                },
              },
            }
          : event;
      if (command) this.calls.set(command.id, command);
      else if (
        !preExecutionDenied(state.error, state.metadata) &&
        !["denied", "rejected"].includes(String(state.status))
      )
        this.unwrapped++;
    }
    return command
      ? {
          ...event,
          part: {
            ...part,
            state: { ...state, input: { ...args, command: command.command } },
          },
        }
      : event;
  }
  private readReceipts(): { starts: Map<string, Obj>; ends: Map<string, Obj> } {
    const starts = new Map<string, Obj>(),
      ends = new Map<string, Obj>(),
      file = path.join(this.policy.directory, "receipts.jsonl");
    if (!fs.existsSync(file)) return { starts, ends };
    if (fs.statSync(file).size > 8 * 1024 * 1024)
      throw Error("receipt size limit");
    for (const line of fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)) {
      const record = JSON.parse(line),
        data = obj(record.data);
      if (
        !ioVerify(data, record.signature, this.policy) ||
        data.policyId !== this.policy.id ||
        data.profileDigest !== this.policy.profileDigest ||
        typeof data.id !== "string"
      )
        throw Error("invalid signed broker receipt");
      const map =
        data.type === "start" ? starts : data.type === "end" ? ends : null;
      if (!map || map.has(data.id))
        throw Error("duplicate/unknown broker receipt");
      map.set(data.id, data);
    }
    return { starts, ends };
  }
  /**
   * After a platform stop nothing may still be able to start or run a VM: every
   * broker has let go of the lock, every VM client has exited, and the last VM
   * listing is empty. Returns the VMs removed here. Throws if that never holds.
   */
  private settleAfterStop(vm: VmPolicy): Set<string> {
    const removed = new Set<string>(),
      lock = path.join(this.policy.directory, "command.lock"),
      deadline = Date.now() + this.settleMs,
      alive = (pid: unknown) => {
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
        try {
          process.kill(pid as number, 0);
          return true;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
      },
      clean = () => {
        for (const name of cleanupPolicyVms(vm, this.policy.id))
          removed.add(name);
      };
    for (;;) {
      clean();
      // A dead owner cannot release the lock or read the stop file any more.
      let locked = fs.existsSync(lock);
      if (locked)
        try {
          const owner = JSON.parse(
            fs.readFileSync(path.join(lock, "owner.json"), "utf8"),
          );
          if (!alive(owner.pid)) {
            fs.rmSync(lock, { recursive: true });
            locked = false;
          }
        } catch {
          /* Mid-write or just released; the next pass decides. */
        }
      if (!locked) {
        // An end receipt means the broker saw that client close.
        const { starts, ends } = this.readReceipts();
        if (![...starts].some(([id, a]) => !ends.has(id) && alive(a.pid))) {
          clean();
          return removed;
        }
      }
      if (Date.now() >= deadline) throw Error("broker did not settle");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  /** Signed, started before the stop, and never seen by the CLI: ended by that stop. */
  private interruptedByStop(
    vm: VmPolicy,
    stoppedAt: number,
    starts: Map<string, Obj>,
    ends: Map<string, Obj>,
  ): Set<string> {
    const interrupted = new Set<string>();
    for (const [id, a] of starts) {
      const b = ends.get(id);
      if (
        !this.calls.has(id) &&
        Date.parse(String(a.at)) <= stoppedAt &&
        a.backend === this.policy.backend &&
        a.imageDigest === vm.imageDigest &&
        a.network === "none" &&
        a.containerName === vmCommandName(this.policy.id, id) &&
        (!b ||
          (b.command === a.command &&
            b.processGroupStopped === true &&
            b.containerRemoved === true))
      )
        interrupted.add(id);
    }
    return interrupted;
  }
  /** `cliEnded`: the supervisor confirmed the CLI is gone, not merely signalled. */
  finish(cliEnded = false): ProgramIoAudit {
    const audit: ProgramIoAudit = {
      version: 1,
      backend: this.policy.backend,
      policyId: this.policy.id,
      profileDigest: this.policy.profileDigest,
      cwd: this.policy.cwd,
      preflightPassed: this.policy.preflightPassed,
      nativeCommands: this.calls.size,
      completedCommands: 0,
      unwrappedCommands: this.unwrapped,
      unresolvedCommands: 0,
      invalidReceipts: 0,
      runtimeReadRoots: this.policy.runtimeReadRoots,
      commands: [],
    };
    try {
      const { vm } = this.policy,
        stoppedAt = cliEnded ? this.stoppedAt : null,
        settled = vm && stoppedAt !== null ? this.settleAfterStop(vm) : null;
      // A crashed broker cannot sign completion. Clean its VM, but retain failure.
      if (!settled && vm && cleanupPolicyVms(vm, this.policy.id).length)
        audit.invalidReceipts++;
      const { starts, ends } = this.readReceipts(),
        interrupted =
          vm && stoppedAt !== null
            ? this.interruptedByStop(vm, stoppedAt, starts, ends)
            : new Set<string>();
      if (interrupted.size) audit.interruptedCommands = interrupted.size;
      // A VM with no signed start of its own is not this stop's doing.
      const known = new Set(
        [...interrupted].map((id) => vmCommandName(this.policy.id, id)),
      );
      if (settled && [...settled].some((name) => !known.has(name)))
        audit.invalidReceipts++;
      for (const call of this.calls.values()) {
        const a = starts.get(call.id),
          b = ends.get(call.id);
        if (
          !a ||
          !b ||
          a.command !== call.command ||
          b.command !== call.command ||
          !Number.isInteger(b.exitCode) ||
          b.backend !== this.policy.backend ||
          b.processGroupStopped !== true ||
          (this.policy.vm && b.containerRemoved !== true)
        ) {
          audit.unresolvedCommands++;
          continue;
        }
        audit.completedCommands++;
        audit.commands.push({
          id: call.id,
          command: call.command,
          exitCode: b.exitCode as number,
          pid: a.pid as number,
          processGroupStopped: true,
          ...(this.policy.vm
            ? { containerRemoved: true, containerName: String(a.containerName) }
            : {}),
        });
      }
      if (
        [...starts.keys(), ...ends.keys()].some(
          (id) => !this.calls.has(id) && !interrupted.has(id),
        )
      )
        audit.invalidReceipts++;
      if (
        sha(fs.readFileSync(path.join(this.policy.directory, "profile.sb"))) !==
        this.policy.profileDigest
      )
        audit.invalidReceipts++;
    } catch {
      audit.invalidReceipts++;
    }
    return audit;
  }
}
export function programIoEvidenceProblem(state: SessionState): string | null {
  if (!state.graph.automation?.programIoGuard) return null;
  for (const visit of state.visits)
    for (const attempt of visit.attempts) {
      const binding = state.bindings[visit.nodeId],
        kilo =
          state.connections.find((c) => c.id === binding?.connectionId)
            ?.type === "kilo",
        a = attempt.programIoAudit;
      if (!kilo && !a) continue;
      let root = state.targetProjectPath;
      try {
        root = fs.realpathSync(root);
      } catch {}
      if (
        !a ||
        a.version !== 1 ||
        a.backend !== "apple-container-vm" ||
        a.cwd !== root ||
        !a.preflightPassed ||
        typeof a.policyId !== "string" ||
        !a.policyId ||
        !/^[a-f0-9]{64}$/.test(a.profileDigest) ||
        !Array.isArray(a.runtimeReadRoots) ||
        !Array.isArray(a.commands) ||
        a.commands.length !== a.completedCommands ||
        a.commands.some(
          (c) =>
            !c.processGroupStopped ||
            !c.containerRemoved ||
            !Number.isInteger(c.exitCode) ||
            !Number.isSafeInteger(c.pid) ||
            c.pid <= 0,
        ) ||
        ![
          a.nativeCommands,
          a.completedCommands,
          a.unwrappedCommands,
          a.unresolvedCommands,
          a.invalidReceipts,
        ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        a.nativeCommands !== a.completedCommands ||
        a.unwrappedCommands ||
        a.unresolvedCommands ||
        a.invalidReceipts ||
        (a.interruptedCommands !== undefined &&
          (!Number.isSafeInteger(a.interruptedCommands) ||
            a.interruptedCommands <= 0 ||
            attempt.completionAccepted === true))
      )
        return "프로그램 I/O 커널 격리 증거가 누락됐거나 우회·미완료 실행이 있습니다.";
    }
  return null;
}
