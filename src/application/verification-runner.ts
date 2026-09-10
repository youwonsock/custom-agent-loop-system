import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ArtifactStorePort } from "./ports/artifact-store";
import type { VerificationRuntimePort } from "./ports/verification-runtime-port";
import type { WorkspaceIntegrityPort } from "./ports/workspace-integrity-port";
import type { WorkspaceWatch } from "./ports/workspace-integrity-port";
import type { RunControlCommand } from "./ports/control-command";
import type {
  ArtifactReference,
} from "../domain/task-result";
import {
  VerificationApprovalCandidate,
  VerificationCommandRecord,
  VerificationContract,
  VerificationCommandSpec,
  VerificationProof,
  VerificationContractDraft,
  hashVerificationCandidate,
  validateVerificationContractDraft,
} from "../domain/verification";
import { canonicalJson, type JsonValue } from "../domain/json";

export interface VerificationRunContext {
  runId: string;
  verificationId: string;
  projectRoot: string;
  additionalRoots: string[];
  implementationActivationId: string | null;
  testActivationId: string | null;
  existingRecords?: ReadonlyArray<VerificationCommandRecord>;
  /** Previously consumed milliseconds for this contract (survives restart). */
  elapsedMs?: number;
  /** Persist a command checkpoint before the next command is started. */
  onRecord?: (record: VerificationCommandRecord, logArtifact?: ArtifactReference) => Promise<void>;
  /** Poll the durable control queue while a command is running. */
  pollControl?: () => Promise<RunControlCommand | null>;
}

export interface VerificationRunnerResult {
  proof: VerificationProof;
  records: VerificationCommandRecord[];
  control: RunControlCommand | null;
  /** Core-generated, durable summary of the complete verification attempt. */
  resultArtifact?: ArtifactReference;
}

export const DEFAULT_VERIFICATION_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_VERIFICATION_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
// Fingerprints are represented as digests in the persisted proof contract.
// When preflight cannot produce one, retain a valid sentinel so the failure
// can still be committed and recovered as an execution error; the proof's
// `executionError`/`watcherReliable` flags keep it permanently ineligible for
// success.
const UNKNOWN_FINGERPRINT = "0".repeat(64);

export function hashVerificationContract(contract: Readonly<{
  commands: unknown;
  totalTimeoutMs: number;
  protectedPaths: string[];
  testRoots: string[];
  allowedNewTestRoots: string[];
  generatedOutputPaths: string[];
}>): string {
  return createHash("sha256")
    .update(canonicalJson({
      commands: contract.commands as JsonValue,
      totalTimeoutMs: contract.totalTimeoutMs,
      protectedPaths: [...contract.protectedPaths],
      testRoots: [...contract.testRoots],
      allowedNewTestRoots: [...contract.allowedNewTestRoots],
      generatedOutputPaths: [...contract.generatedOutputPaths],
    }))
    .digest("hex");
}

export function createVerificationContract(
  commands: VerificationContract["commands"],
  baselineFingerprint: string,
  approvedRequestId = "system-initial",
  baseline?: Readonly<{ paths?: string[]; fileHashes?: Record<string, string>; fileModes?: Record<string, number> }>,
  draftOverrides?: Partial<VerificationContractDraft>
): VerificationContract {
  const normalizedCommands = [...commands].map((command) => ({
    ...command,
    timeoutMs: Number.isSafeInteger(command.timeoutMs) && command.timeoutMs > 0
      ? command.timeoutMs
      : DEFAULT_VERIFICATION_COMMAND_TIMEOUT_MS,
    args: [...command.args],
    requirementIds: [...command.requirementIds],
  }));
  const contractDraft = {
    commands: normalizedCommands,
    totalTimeoutMs: Number.isSafeInteger(draftOverrides?.totalTimeoutMs) && (draftOverrides?.totalTimeoutMs ?? 0) > 0
      ? Number(draftOverrides!.totalTimeoutMs)
      : DEFAULT_VERIFICATION_TOTAL_TIMEOUT_MS,
    protectedPaths: [...(draftOverrides?.protectedPaths ?? [])],
    testRoots: [...(draftOverrides?.testRoots ?? [])],
    allowedNewTestRoots: [...(draftOverrides?.allowedNewTestRoots ?? [])],
    generatedOutputPaths: [...(draftOverrides?.generatedOutputPaths ?? [])],
  };
  validateVerificationContractDraft(contractDraft);
  return {
    ...contractDraft,
    revision: 1,
    contractHash: hashVerificationContract(contractDraft),
    approvedRequestId,
    approvedAt: new Date().toISOString(),
    baselineArtifactId: "",
    baselineFingerprint,
    ...(baseline?.paths ? { baselinePaths: [...baseline.paths] } : {}),
    ...(baseline?.fileHashes ? { baselineFileHashes: { ...baseline.fileHashes } } : {}),
    ...(baseline?.fileModes ? { baselineFileModes: { ...baseline.fileModes } } : {}),
  };
}

export class VerificationRunner {
  constructor(
    private readonly runtime: VerificationRuntimePort,
    private readonly integrity: WorkspaceIntegrityPort,
    private readonly artifacts: ArtifactStorePort
  ) {}

  /**
   * Build the first contract from a workflow node and capture its immutable
   * baseline.  The baseline itself is stored as an artifact by the caller;
   * keeping this method on the runner makes it impossible for a model result
   * to invent the initial fingerprint.
  */
  async prepareContract(
    commands: ReadonlyArray<VerificationCommandSpec>,
    projectRoot: string,
    additionalRoots: ReadonlyArray<string>,
    approvedRequestId = "system-initial",
    draft?: Partial<VerificationContractDraft>
  ): Promise<VerificationContract & { baselineArtifact?: ArtifactReference }> {
    // Generated outputs are outside the immutable verification baseline from
    // the moment the contract is created; otherwise the first run would
    // compare a different exclusion policy and fail closed every time.
    const fingerprint = await this.integrity.fingerprint(
      projectRoot,
      additionalRoots,
      draft?.generatedOutputPaths ?? []
    );
    const baseline = await this.artifacts.put(
      JSON.stringify(fingerprint),
      "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1"
    );
    const contract = createVerificationContract(
      [...commands],
      fingerprint.digest,
      approvedRequestId,
      fingerprint,
      draft
    );
    return {
      ...contract,
      baselineArtifactId: baseline.artifactId,
      baselineArtifact: baseline,
    };
  }

  async currentFingerprint(
    contract: Readonly<VerificationContract>,
    projectRoot: string,
    additionalRoots: ReadonlyArray<string>
  ): Promise<{
    digest: string;
    files: number;
    paths: string[];
    fileHashes?: Record<string, string>;
    fileModes?: Record<string, number>;
  }> {
    return this.integrity.fingerprint(
      projectRoot,
      additionalRoots,
      contract.generatedOutputPaths
    );
  }

  buildApprovalCandidate(
    contract: Readonly<VerificationContract>,
    fingerprint: Readonly<{ digest: string; paths: string[]; fileHashes?: Record<string, string>; fileModes?: Record<string, number> }>,
    proposedDraft?: Readonly<Partial<VerificationContractDraft>>
  ): VerificationApprovalCandidate {
    const baselinePaths = new Set(contract.baselinePaths ?? []);
    const currentPaths = new Set(fingerprint.paths);
    const addedPaths = [...currentPaths].filter((item) => !baselinePaths.has(item)).sort();
    const deletedPaths = [...baselinePaths].filter((item) => !currentPaths.has(item)).sort();
    const modifiedPaths = [...currentPaths].filter((item) => {
      if (!baselinePaths.has(item)) return false;
      const before = contract.baselineFileHashes?.[item];
      const after = fingerprint.fileHashes?.[item];
      const beforeMode = contract.baselineFileModes?.[item];
      const afterMode = fingerprint.fileModes?.[item];
      return (before !== undefined && after !== undefined && before !== after) ||
        (beforeMode !== undefined && afterMode !== undefined && beforeMode !== afterMode);
    }).sort();
    const effectiveChangedPaths = [...new Set([...addedPaths, ...modifiedPaths, ...deletedPaths])].sort();
    const candidateBody = {
      baseRevision: contract.revision,
      commands: (proposedDraft?.commands ?? contract.commands).map((command) => ({
        ...command,
        args: [...command.args],
        requirementIds: [...command.requirementIds],
      })),
      changedPaths: effectiveChangedPaths,
      addedPaths,
      modifiedPaths,
      deletedPaths,
      diffArtifactId: null,
      baselineFingerprint: fingerprint.digest,
      baselinePaths: [...fingerprint.paths],
      ...(fingerprint.fileHashes ? { baselineFileHashes: { ...fingerprint.fileHashes } } : {}),
      totalTimeoutMs: proposedDraft?.totalTimeoutMs ?? contract.totalTimeoutMs,
      protectedPaths: [...(proposedDraft?.protectedPaths ?? contract.protectedPaths)],
      testRoots: [...(proposedDraft?.testRoots ?? contract.testRoots)],
      allowedNewTestRoots: [...(proposedDraft?.allowedNewTestRoots ?? contract.allowedNewTestRoots)],
      generatedOutputPaths: [...(proposedDraft?.generatedOutputPaths ?? contract.generatedOutputPaths)],
      ...(fingerprint.fileModes ? { baselineFileModes: { ...fingerprint.fileModes } } : {}),
    };
    return {
      ...candidateBody,
      candidateHash: hashVerificationCandidate(candidateBody),
    };
  }

  async run(
    contract: Readonly<VerificationContract>,
    context: Readonly<VerificationRunContext>
  ): Promise<VerificationRunnerResult> {
    let watcher: WorkspaceWatch | null = null;
    let before: Awaited<ReturnType<WorkspaceIntegrityPort["fingerprint"]>> | null = null;
    let after: Awaited<ReturnType<WorkspaceIntegrityPort["fingerprint"]>> | null = null;
    const records: VerificationCommandRecord[] = [];
    const prior = new Map(
      (context.existingRecords ?? [])
        .filter((record) => record.verificationId === context.verificationId)
        .map((record) => [record.commandId, record] as const)
    );
    const elapsedBefore = Number.isFinite(context.elapsedMs) && (context.elapsedMs ?? 0) >= 0
      ? Math.floor(context.elapsedMs ?? 0)
      : 0;
    const startedAt = Date.now();
    let canContinue = true;
    let executionError = false;
    let failureReason: string | undefined;
    let observedControl: RunControlCommand | null = null;
    let activeController: AbortController | null = null;
    // A checkpoint callback is the durable boundary between the runner and
    // the aggregate. If that callback fails, returning a synthetic proof
    // would let the caller advance using records that were never committed.
    // Remember the error and rethrow it after process/watch cleanup so normal
    // runtime failures can still produce bounded evidence while persistence
    // failures remain recoverable/blocked.
    let checkpointError: unknown = null;
    let polling = false;
    const pollTimer = context.pollControl
      ? setInterval(() => {
          if (polling || observedControl) return;
          polling = true;
          void context.pollControl!().then((control) => {
            if (control && !observedControl) {
              observedControl = control;
              activeController?.abort();
            }
          }).catch((error) => {
            executionError = true;
            failureReason = `Verification control polling failed: ${error instanceof Error ? error.message : String(error)}`;
            canContinue = false;
            activeController?.abort();
          }).finally(() => { polling = false; });
        }, 100) : null;
    const elapsed = (): number => elapsedBefore + Math.max(0, Date.now() - startedAt);
    const persistRecord = async (
      record: VerificationCommandRecord,
      logArtifact?: ArtifactReference
    ): Promise<void> => {
      try {
        await context.onRecord?.(record, logArtifact);
      } catch (error) {
        checkpointError ??= error;
        throw error;
      }
    };
    const recordNotRun = async (record: VerificationCommandRecord, message: string): Promise<void> => {
      record.status = "not_run";
      record.summary = message.slice(0, 8_000);
      record.elapsedMs = 0;
      await persistRecord({ ...record, args: [...record.args] });
    };
    try {
      watcher = this.integrity.watch(
        context.projectRoot,
        context.additionalRoots,
        contract.generatedOutputPaths
      );
      before = await this.integrity.fingerprint(
        context.projectRoot,
        context.additionalRoots,
        contract.generatedOutputPaths
      );
      // The contract baseline was captured when the plan was approved. A
      // change between that approval checkpoint and this runner boundary is
      // already outside the approved scope, so do not execute even the first
      // command. The loop below records every command as `not_run`, leaving a
      // durable, bounded failure that requires re-approval instead of running
      // approved checks against an unapproved workspace.
      if (before.digest !== contract.baselineFingerprint) {
        executionError = true;
        canContinue = false;
        failureReason = "Workspace fingerprint no longer matches the approved verification baseline.";
      }
      for (const command of contract.commands) {
        if (!observedControl && context.pollControl) {
          const control = await context.pollControl();
          if (control) {
            observedControl = control;
            canContinue = false;
          }
        }
        const previous = prior.get(command.id);
        if (previous?.status === "running") {
          executionError = true;
          failureReason = `Verification command ${command.id} has an unknown prior outcome.`;
          canContinue = false;
          // Preserve the durable running checkpoint verbatim.  Replacing it
          // with a fresh reservation would make an interrupted mutation look
          // replayable and could permit the same command to run twice.
          records.push({ ...previous, args: [...previous.args] });
          continue;
        }
        if (previous?.status === "completed") {
          const completed = { ...previous, args: [...previous.args] };
          records.push(completed);
          // A normal non-zero exit is a completed verification observation;
          // continue to the next command so the proof reports every failure.
          if (
            completed.signal !== null ||
            completed.timedOut ||
            completed.processTreeClean !== true
          ) canContinue = false;
          // A persisted completion without a confirmed process tree is an
          // ambiguous mutation boundary.  Treat it like an execution error
          // during recovery so the remaining commands are not replayed and
          // the proof cannot be mistaken for a normal verification failure.
          if (completed.processTreeClean !== true) {
            executionError = true;
            failureReason ??= `Verification command ${command.id} has an unconfirmed process cleanup result.`;
          }
          continue;
        }
        if (previous?.status === "not_run") {
          // A not_run checkpoint is an explicit boundary decision.  Retain
          // it once and keep all following commands not_run as well; never
          // manufacture a second record for the same command on recovery.
          records.push({ ...previous, args: [...previous.args] });
          canContinue = false;
          continue;
        }
        const record: VerificationCommandRecord = {
          verificationId: context.verificationId,
          commandId: command.id,
          status: "reserved",
          executable: command.executable,
          args: [...command.args],
          cwd: path.resolve(context.projectRoot, command.cwd),
          approvedExecutable: command.executable,
          approvedArgs: [...command.args],
          approvedCwd: command.cwd,
          startedAt: null,
          completedAt: null,
          exitCode: null,
          signal: null,
          timedOut: false,
          processTreeClean: null,
          logArtifactId: null,
          summary: "",
        };
        records.push(record);
        await persistRecord({ ...record, args: [...record.args] });
        const remaining = contract.totalTimeoutMs - elapsed();
        if (!canContinue || observedControl || remaining <= 0) {
          await recordNotRun(
            record,
            observedControl
              ? `Verification command was not run after ${observedControl.type.toUpperCase()} was observed.`
              : remaining <= 0
                ? "Verification total timeout was exhausted before this command started."
                : "Verification command was not run because an earlier command stopped the run."
          );
          canContinue = false;
          continue;
        }
        record.status = "running";
        record.startedAt = new Date().toISOString();
        await persistRecord({ ...record, args: [...record.args] });
        activeController = new AbortController();
        const commandStartedMs = Date.now();
        try {
          const effectiveCommand = remaining < command.timeoutMs
            ? { ...command, timeoutMs: Math.max(1, remaining) }
            : command;
          const runtime = this.runtime;
          const result = await runtime.execute({
            runId: context.runId,
            verificationId: context.verificationId,
            command: effectiveCommand,
            projectRoot: context.projectRoot,
            signal: activeController.signal,
          });
          record.status = "completed";
          if (result.resolvedExecutable) record.executable = result.resolvedExecutable;
          if (result.resolvedArgs) record.args = [...result.resolvedArgs];
          if (result.resolvedCwd) record.cwd = result.resolvedCwd;
          record.completedAt = result.completedAt;
          record.exitCode = result.exitCode;
          record.signal = result.signal;
          record.timedOut = result.timedOut;
          record.processTreeClean = result.processTreeClean;
          record.summary = (result.stderr || result.stdout || "").slice(-8_000);
          record.elapsedMs = Math.max(0, Date.parse(result.completedAt) - Date.parse(record.startedAt));
          if (!Number.isFinite(record.elapsedMs)) record.elapsedMs = Math.max(0, Date.now() - commandStartedMs);
          record.outputTruncated = result.outputTruncated === true;
          const log = await this.artifacts.put(
            JSON.stringify({ commandId: command.id, stdout: result.stdout, stderr: result.stderr }),
            "application/vnd.custom-agent-loop.verification-log+json;version=1"
          );
          record.logArtifactId = log.artifactId;
          await persistRecord({ ...record, args: [...record.args] }, log);
          if (result.signal !== null || result.timedOut || !result.processTreeClean) {
            canContinue = false;
            if (!result.processTreeClean) {
              executionError = true;
              failureReason = "The verification process tree could not be confirmed clean.";
            } else if (result.timedOut) {
              failureReason ??= `Verification command ${command.id} timed out.`;
            }
          }
          if (elapsed() >= contract.totalTimeoutMs) canContinue = false;
        } catch (error) {
          record.status = "completed";
          record.completedAt = new Date().toISOString();
          record.processTreeClean = false;
          record.summary = error instanceof Error ? error.message : String(error);
          record.elapsedMs = Math.max(0, Date.now() - commandStartedMs);
          record.outputTruncated = false;
          canContinue = false;
          executionError = true;
          failureReason = record.summary;
          // Preserve an auditable failure diagnostic even when the runtime
          // could not return a normal stdout/stderr result.  If artifact
          // persistence itself fails, the missing reference remains a
          // fail-closed signal and the proof cannot pass.
          let errorLog: ArtifactReference | undefined;
          try {
            errorLog = await this.artifacts.put(
              JSON.stringify({ commandId: command.id, error: record.summary }),
              "application/vnd.custom-agent-loop.verification-log+json;version=1"
            );
            record.logArtifactId = errorLog.artifactId;
          } catch {
            record.logArtifactId = null;
          }
          await persistRecord({ ...record, args: [...record.args] }, errorLog);
        } finally {
          activeController = null;
        }
      }
      after = await this.integrity.fingerprint(
        context.projectRoot,
        context.additionalRoots,
        contract.generatedOutputPaths
      );
    } catch (error) {
      if (checkpointError !== null) throw error;
      executionError = true;
      failureReason ??= error instanceof Error ? error.message : String(error);
      canContinue = false;
      // Complete the command list with explicit not_run records so recovery
      // can distinguish a cleanly observed failure from an unknown mutation.
      for (const command of contract.commands) {
        if (records.some((record) => record.commandId === command.id)) continue;
        const record: VerificationCommandRecord = {
          verificationId: context.verificationId,
          commandId: command.id,
          status: "not_run",
          executable: command.executable,
          args: [...command.args],
          cwd: path.resolve(context.projectRoot, command.cwd),
          approvedExecutable: command.executable,
          approvedArgs: [...command.args],
          approvedCwd: command.cwd,
          startedAt: null,
          completedAt: null,
          exitCode: null,
          signal: null,
          timedOut: false,
          processTreeClean: false,
          logArtifactId: null,
          summary: "Verification command was not run because the verification runner failed.",
          elapsedMs: 0,
          outputTruncated: false,
        };
        records.push(record);
        await persistRecord({ ...record, args: [...record.args] });
      }
    } finally {
      if (pollTimer) clearInterval(pollTimer);
      watcher?.close();
    }
    if (checkpointError !== null) throw checkpointError;
    const beforeDigest = before?.digest ?? UNKNOWN_FINGERPRINT;
    const afterDigest = after?.digest ?? UNKNOWN_FINGERPRINT;
    const watcherReliable = Boolean(watcher?.reliable && !watcher?.dirty() && before && after);
    if (!watcherReliable) executionError = true;
    const totalTimeoutExceeded = elapsed() > contract.totalTimeoutMs;
    if (totalTimeoutExceeded) {
      failureReason ??= "Verification total timeout was exceeded.";
    }
    const passed =
      !executionError &&
      !observedControl &&
      !totalTimeoutExceeded &&
      watcherReliable &&
      beforeDigest === contract.baselineFingerprint &&
      beforeDigest === afterDigest &&
      records.length === contract.commands.length &&
      records.every((record) =>
        record.status === "completed" &&
        record.exitCode === 0 &&
        record.signal === null &&
        !record.timedOut &&
        record.processTreeClean === true
      );
    if (observedControl) {
      failureReason ??= `Verification was ${observedControl.type.toUpperCase()}ed by the operator.`;
    }
    if (!watcherReliable) failureReason ??= "Workspace change monitoring was not reliable.";
    if (before && after && beforeDigest !== afterDigest) {
      failureReason ??= "Workspace fingerprint changed during verification.";
    }
    if (before && beforeDigest !== contract.baselineFingerprint) {
      failureReason ??= "Workspace fingerprint no longer matches the approved verification baseline.";
    }
    if (!passed && !failureReason) {
      const failedIds = records
        .filter((record) => record.status !== "completed" || record.exitCode !== 0)
        .map((record) => record.commandId);
      failureReason = failedIds.length > 0
        ? `Verification command(s) failed: ${failedIds.join(", ")}.`
        : "Verification did not satisfy the core success conditions.";
    }
    const proof: VerificationProof = {
      proofId: `${context.verificationId}_${createHash("sha256").update(`${beforeDigest}:${afterDigest}:${Date.now()}`).digest("hex").slice(0, 16)}`,
      verificationId: context.verificationId,
      contractRevision: contract.revision,
      contractHash: contract.contractHash,
      baselineFingerprint: contract.baselineFingerprint,
      beforeFingerprint: beforeDigest,
      afterFingerprint: afterDigest,
      implementationActivationId: context.implementationActivationId,
      testActivationId: context.testActivationId,
      commands: records,
      passed,
      verifiedAt: new Date().toISOString(),
      watcherReliable,
      // Keep the observed duration intact.  Capping this value would hide a
      // runtime that ignored the total timeout and make the proof appear to
      // have completed within the approved budget.
      elapsedMs: Math.max(0, elapsed()),
      executionError,
      ...(failureReason ? { failureReason: failureReason.slice(0, 8_000) } : {}),
    };
    // The result artifact is written by the core after all command records and
    // fingerprints are known.  It deliberately excludes its own artifact id
    // so the content hash remains stable and cannot be supplied by a model.
    const resultArtifact = await this.artifacts.put(
      JSON.stringify({ schemaVersion: 1, kind: "verification_result.v1", proof }),
      "application/vnd.custom-agent-loop.verification-result+json;version=1"
    );
    proof.resultArtifactId = resultArtifact.artifactId;
    return { proof, records, control: observedControl, resultArtifact };
  }
}
