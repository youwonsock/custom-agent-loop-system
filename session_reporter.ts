import * as path from "node:path";
import * as fse from "fs-extra";
import { AgentRunResult } from "./agent_runtime";
import { atomicAppendLine, atomicReadJson, atomicWriteJson } from "./json_file_store";
import { LoopState, ModelMapping } from "./loop_state";
import { FailureKind } from "./resilience";

export interface AttemptEventSummary {
  lastEventType: string | null;
  lastToolName: string | null;
  lastToolStatus: string | null;
  lastToolCommand: string | null;
  lastStepFinishReason: string | null;
  lastStepFinishTotalTokens: number | null;
  maxObservedTotalTokens: number | null;
}

export interface LoopHistoryEntry extends AttemptEventSummary {
  loopNumber: number;
  phase: string;
  agentRole: string;
  model: string;
  exitCode: number;
  startedAt: string;
  endedAt: string;
  output: string;
  result: "success" | "failure" | "timeout";
  signature: string | null;
  interruptMessage: string | null;
  attemptId?: string | null;
  attemptNumber?: number | null;
  failureKind?: FailureKind | null;
  rawLogPath?: string | null;
  rawLogBytes?: number | null;
  assistantTextBytes?: number | null;
  eventCount?: number | null;
}

export interface FinalSummary {
  sessionId: string;
  goal: string;
  achievedAt: string;
  totalLoops: number;
  finalModelMapping: ModelMapping;
  progressNotes: string;
  approvedByMaster: boolean;
}

export interface SessionReporterPaths {
  loopHistoryDirName: string;
  attemptLogsDirName: string;
  progressNotesFileName: string;
  finalSummaryFileName: string;
}

export interface SessionReporterOptions {
  sessionDir: string;
  state: LoopState;
  paths: SessionReporterPaths;
  summarizeAttemptEvents(result: AgentRunResult): AttemptEventSummary;
  maxRetainedHistoryFiles?: number;
  maxRetainedAttemptLogs?: number;
  maxHistoryOutputBytes?: number;
}

export class FileSessionReporter {
  private readonly maxRetainedHistoryFiles: number;
  private readonly maxRetainedAttemptLogs: number;
  private readonly maxHistoryOutputBytes: number;

  constructor(private readonly options: SessionReporterOptions) {
    this.maxRetainedHistoryFiles = options.maxRetainedHistoryFiles ?? 250;
    this.maxRetainedAttemptLogs = options.maxRetainedAttemptLogs ?? 50;
    this.maxHistoryOutputBytes = options.maxHistoryOutputBytes ?? 512 * 1024;
  }

  async archiveLoop(
    loopNumber: number,
    phase: string,
    role: string,
    result: AgentRunResult,
    startedAt: Date,
    endedAt: Date
  ): Promise<void> {
    const { state } = this.options;
    const rawLogPath = result.rawLogPath ?? null;
    const rawLogBytes = rawLogPath
      ? await fse.stat(rawLogPath).then((stat) => stat.size).catch(() => null)
      : null;
    const pipelineRole = state.pipeline.roles.find((candidate) => candidate.id === role);
    const providerId =
      pipelineRole?.provider ??
      state.providerMapping?.[role] ??
      state.providerMapping?.[pipelineRole?.modelRole ?? role] ??
      state.cliProfile;
    const model =
      pipelineRole?.model ??
      state.modelMapping[pipelineRole?.modelRole ?? role] ??
      "unknown";
    const entry: LoopHistoryEntry = {
      loopNumber,
      phase,
      agentRole: role,
      model: `${providerId}:${model}`,
      exitCode: result.exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      output: this.boundedHistoryOutput(result.output),
      result: result.timedOut ? "timeout" : result.exitCode === 0 ? "success" : "failure",
      signature: null,
      interruptMessage: state.interruptMessage ?? null,
      attemptId: state.activeAttempt?.attemptId ?? null,
      attemptNumber: state.activeAttempt?.attemptNumber ?? null,
      failureKind: result.failureKind ?? null,
      rawLogPath,
      rawLogBytes,
      assistantTextBytes: Buffer.byteLength(result.assistantText ?? "", "utf8"),
      eventCount: result.events.length,
      ...this.options.summarizeAttemptEvents(result),
    };
    const attemptSuffix = state.activeAttempt
      ? `_attempt_${state.activeAttempt.attemptNumber}_${state.activeAttempt.attemptId}`
      : "";
    const fileName =
      `loop_${loopNumber}_${phase.toLowerCase()}_${role}${attemptSuffix}.json`;
    await atomicWriteJson(
      path.join(this.options.sessionDir, this.options.paths.loopHistoryDirName, fileName),
      entry
    );
    await Promise.all([
      this.pruneRetainedFiles(
        path.join(this.options.sessionDir, this.options.paths.loopHistoryDirName),
        ".json",
        this.maxRetainedHistoryFiles
      ),
      this.pruneRetainedFiles(
        path.join(this.options.sessionDir, this.options.paths.attemptLogsDirName),
        ".log",
        this.maxRetainedAttemptLogs
      ),
    ]);
  }

  appendProgressNote(note: string): Promise<void> {
    return atomicAppendLine(
      path.join(this.options.sessionDir, this.options.paths.progressNotesFileName),
      note
    );
  }

  async readProgressNotes(): Promise<string> {
    try {
      return await fse.readFile(
        path.join(this.options.sessionDir, this.options.paths.progressNotesFileName),
        "utf8"
      );
    } catch {
      return "";
    }
  }

  async emitFinalSummary(): Promise<void> {
    const { state } = this.options;
    const summary: FinalSummary = {
      sessionId: state.sessionId,
      goal: state.goal,
      achievedAt: new Date().toISOString(),
      totalLoops: state.loopCount,
      finalModelMapping: state.modelMapping,
      progressNotes: await this.readProgressNotes(),
      approvedByMaster: state.masterApproved,
    };
    await atomicWriteJson(
      path.join(this.options.sessionDir, this.options.paths.finalSummaryFileName),
      summary
    );
  }

  readHistoryEntry(filePath: string): Promise<LoopHistoryEntry | null> {
    return atomicReadJson<LoopHistoryEntry>(filePath);
  }

  private boundedHistoryOutput(value: string): string {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length <= this.maxHistoryOutputBytes) return value;
    const marker = "\n[AGENT_LOOP_HISTORY_OUTPUT_TRUNCATED]\n";
    const markerBytes = Buffer.byteLength(marker, "utf8");
    const headBytes = Math.floor((this.maxHistoryOutputBytes - markerBytes) / 4);
    const tailBytes = this.maxHistoryOutputBytes - markerBytes - headBytes;
    const head = bytes.subarray(0, headBytes).toString("utf8").replace(/\uFFFD$/, "");
    const tail = bytes
      .subarray(bytes.length - tailBytes)
      .toString("utf8")
      .replace(/^\uFFFD/, "");
    return `${head}${marker}${tail}`;
  }

  private async pruneRetainedFiles(
    directory: string,
    suffix: string,
    maximumFiles: number
  ): Promise<void> {
    const names = (await fse.readdir(directory).catch(() => [] as string[])).filter((name) =>
      name.endsWith(suffix)
    );
    if (names.length <= maximumFiles) return;
    const candidates = await Promise.all(
      names.map(async (name) => {
        const filePath = path.join(directory, name);
        const stat = await fse.stat(filePath).catch(() => null);
        return stat ? { filePath, modifiedAt: stat.mtimeMs } : null;
      })
    );
    const removable = candidates
      .filter(
        (candidate): candidate is { filePath: string; modifiedAt: number } =>
          candidate !== null
      )
      .sort((left, right) => left.modifiedAt - right.modifiedAt)
      .slice(0, Math.max(0, names.length - maximumFiles));
    await Promise.all(
      removable.map(({ filePath }) => fse.remove(filePath).catch(() => undefined))
    );
  }
}

