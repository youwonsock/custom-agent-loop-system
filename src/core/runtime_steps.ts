import {
  AgentNode,
  AttemptRecord,
  ExecutionBinding,
  LocalConnection,
  NodeVisit,
} from "../shared/domain";
import { Completion } from "./completion";
import { buildInvocation } from "./invocation";
import { SupervisorResult } from "./process_supervisor";
import { RunPolicy } from "./run_policy";
import { prepareVerificationCaptures } from "./verification_capture";

export type Invocation = Awaited<ReturnType<typeof buildInvocation>>;
export type InvocationOptions = Parameters<typeof buildInvocation>[3];
/** Fixed for one execute() call: the node, its CLI binding and this cycle's limits. */
export interface Stage {
  node: AgentNode;
  visit: NodeVisit;
  binding: ExecutionBinding;
  connection: LocalConnection;
  policy: RunPolicy;
  /** Source hashes taken before an automated test role runs. */
  sourceInputs: Record<string, string> | null;
  deadline: number;
  normalLimit: number;
  completionLimit: number;
}
/** One supervised CLI attempt and what its guard callbacks and gates found. */
export interface AttemptRun {
  attempt: AttemptRecord;
  result: SupervisorResult;
  policyReason: string | null;
  sourceChanges: string[];
  captures: Awaited<ReturnType<typeof prepareVerificationCaptures>>;
  /** Frozen-test source hashes re-read after the CLI exited. */
  guardedInputs?: Record<string, string>;
  /** Set once the completion was parsed. */
  completion?: Completion;
}
/** The session already stopped at this visit; nothing is left to judge. */
export interface Stopped {
  step: "stopped";
}
/** The stage reached a result the visit should record. */
export interface Completed {
  step: "completed";
  completion: Completion;
}
/** Nothing decided yet; the next step of the attempt looks. */
export interface Undecided {
  step: "undecided";
}
export const STOPPED: Stopped = { step: "stopped" };
export const UNDECIDED: Undecided = { step: "undecided" };
export const completed = (completion: Completion): Completed => ({
  step: "completed",
  completion,
});
export const cycleAttempts = (visit: NodeVisit) =>
  visit.attempts.filter(
    (a) => Date.parse(a.startedAt) >= Date.parse(visit.cycleStartedAt),
  );
export const contextMessage = ({ node, connection }: Stage, message: string) =>
  `[${node.name} · ${connection.label}] ${message}`;
/** A test stage that fails before any CLI call because its checks cannot run. */
export const failedPreparation = (
  reason: string,
  explanation: string,
): Completion => ({
  valid: true,
  reason,
  failureKind: null,
  output: `${explanation}\nVERDICT: FAIL\n[PHASE_DONE]`,
  verdict: "FAIL",
  plans: [],
  researchBlocked: false,
  environmentBlocked: null,
});
