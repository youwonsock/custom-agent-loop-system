import {
  beginResume,
  interruptSession,
  stopSession,
} from "../core/session_transitions";
import {
  isNewerSession,
  sessionSummary,
  SessionSummary,
} from "../shared/session_updates";
import { fork, ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ExecutionSettings,
  SessionAction,
  SessionState,
  StudioEvent,
} from "../shared/domain";
import { StudioStore } from "../core/store";
import { graphDiagnostics, resolveBinding, safeId } from "../core/graph";
import { AppError, messageOf } from "../core/errors";
import {
  executionSettings,
  autonomousExecutionSettings,
} from "../core/settings";
import { CONTRACT_FILE, lockContract } from "../core/verification_contract";
import {
  createSessionBudget,
  sessionBudgetReason,
  pauseForBudget,
} from "../core/session_budget";
import { deriveRequirementLedger } from "../core/requirement_ledger";
import {
  atomicWriteJsonFile,
  checkProcessLiveness,
  readJsonFile,
  SessionLease,
  delay,
} from "../core/resilience";
import { getControlQueuePaths, readControlAck } from "../core/control_queue";
import { withShortFileLock } from "../core/file_lock";
import { terminateProcessTreeBounded } from "../core/process_lifecycle";

export interface StartRequest {
  requestId: string;
  graphId: string;
  expectedRevision: number;
  goal: string;
  targetProjectPath: string;
  accessMode?: "ask" | "full_access";
  settings?: Partial<ExecutionSettings>;
}
export class SessionCoordinator extends EventEmitter {
  private readonly published = new Map<string, SessionSummary>();
  private children = new Map<string, ChildProcess>();
  private closing = false;
  private monitor: NodeJS.Timeout | null = null;
  private monitoring = false;
  constructor(readonly store: StudioStore) {
    super();
  }
  emitStudio(event: StudioEvent): void {
    if (event.type === "session" && event.data) {
      const summary = sessionSummary(event.data as SessionState);
      const previous = this.published.get(summary.id);
      if (previous && !isNewerSession(summary, previous)) return;
      this.published.set(summary.id, summary);
    }
    this.emit("studio", event);
  }
  async start(input: StartRequest): Promise<SessionState> {
    if (
      !input ||
      !safeId(input.requestId) ||
      typeof input.goal !== "string" ||
      !input.goal.trim() ||
      input.goal.length > 200_000 ||
      typeof input.targetProjectPath !== "string"
    )
      throw new AppError(400, "목표와 대상 프로젝트, 요청 ID가 필요합니다.");
    return withShortFileLock(
      path.join(this.store.root, "start.lock"),
      async () => {
        const previous = (await this.store.sessions()).find(
          (s) => s.requestId === input.requestId,
        );
        if (previous) return previous;
        const graph = await this.store.graph(input.graphId);
        if (graph.revision !== input.expectedRevision)
          throw new AppError(
            409,
            "저장된 그래프 버전이 변경되었습니다. 다시 읽고 실행하세요.",
          );
        const diagnostics = graphDiagnostics(graph);
        if (diagnostics.length)
          throw new AppError(
            400,
            "그래프의 실행 문제를 먼저 해결하세요.",
            "invalid_graph",
            diagnostics,
          );
        const target = await fs.realpath(path.resolve(input.targetProjectPath));
        if (!(await fs.stat(target)).isDirectory())
          throw new AppError(400, "대상 프로젝트 폴더가 필요합니다.");
        const bindings = Object.fromEntries(
          graph.nodes.map((n) => [n.id, resolveBinding(graph, n)!]),
        );
        const ids = new Set(Object.values(bindings).map((b) => b.connectionId)),
          connections = (await this.store.connections()).filter((c) =>
            ids.has(c.id),
          );
        if (connections.length !== ids.size)
          throw new AppError(
            400,
            "그래프가 참조하는 실행 연결이 없습니다. 연결을 다시 지정하세요.",
          );
        const settings = graph.automation
            ? autonomousExecutionSettings(input.settings)
            : executionSettings(input.settings),
          now = new Date().toISOString();
        if (
          input.accessMode !== undefined &&
          !["ask", "full_access"].includes(input.accessMode)
        )
          throw new AppError(400, "접근 모드가 잘못되었습니다.");
        const state: SessionState = {
          stateVersion: 3,
          id: randomUUID(),
          requestId: input.requestId,
          goal: input.goal.trim(),
          targetProjectPath: target,
          graph: structuredClone(graph),
          connections: structuredClone(connections),
          bindings: structuredClone(bindings),
          settings,
          status: "RUNNING",
          statusReason: "실행을 준비하고 있습니다.",
          createdAt: now,
          updatedAt: now,
          currentNodeId: graph.entrypoints.start,
          activeVisitId: null,
          visits: [],
          completedIterations: 0,
          iterationLimit: settings.maxIterations,
          visitLimit: settings.maxIterations * graph.nodes.length * 2,
          accessMode: input.accessMode ?? "ask",
          additionalAllowedPaths: [],
          pendingAccess: null,
          pendingApproval: null,
          approvedPlanRef: null,
          automaticRecovery: null,
          processedRequests: [],
          interruptMessage: null,
          requirements: deriveRequirementLedger(input.goal),
          convergence: { stagnantCycles: 0, history: [] },
        };
        state.executionBudget = createSessionBudget(settings, Date.parse(now));
        if (graph.automation?.verificationContract) {
          state.verificationContract = { version: 1, status: "pending" };
          if (
            await fs.stat(path.join(target, CONTRACT_FILE)).then(
              () => true,
              (error) => {
                if (error.code === "ENOENT") return false;
                throw error;
              },
            )
          ) {
            try {
              state.verificationContract = await lockContract(
                state,
                "supplied",
              );
            } catch (error) {
              throw new AppError(
                400,
                `검증 계약을 시작 전에 확인하세요: ${messageOf(error)}`,
              );
            }
          }
        }
        await this.store.writeSession(state);
        this.spawn(state.id, "start");
        this.emitStudio({ type: "session", sessionId: state.id, data: state });
        return state;
      },
    );
  }
  private spawn(id: string, mode: string): void {
    if (this.closing || this.children.has(id)) return;
    const child = fork(
      path.join(__dirname, "worker.js"),
      [this.store.root, id, mode],
      { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env },
    );
    this.children.set(id, child);
    child.on("message", (message) => {
      if (message && typeof message === "object")
        this.emitStudio(message as StudioEvent);
    });
    const errorLog = (b: Buffer) =>
      this.emitStudio({
        type: "log",
        sessionId: id,
        data: { text: b.toString(), visitId: null, attemptId: null },
      });
    child.stderr?.on("data", errorLog);
    child.once("error", (error) => {
      this.children.delete(id);
      void this.store
        .mutateSession(id, (s) => {
          s.status = "FAILED";
          s.statusReason = messageOf(error);
        })
        .then((s) =>
          this.emitStudio({ type: "session", sessionId: id, data: s }),
        );
    });
    child.once("exit", () => {
      this.children.delete(id);
      void this.store
        .readSession(id)
        .then((s) =>
          this.emitStudio({ type: "session", sessionId: id, data: s }),
        );
    });
  }
  async resume(id: string, automatic = false): Promise<SessionState> {
    if (this.children.has(id))
      throw new AppError(
        409,
        "세션 워커가 아직 실행 중입니다. 잠시 후 다시 시도하세요.",
      );
    const state = await this.store.readSession(id);
    if (state.status === "SUCCESS")
      throw new AppError(
        409,
        "완료된 세션은 재개할 수 없습니다. 새 세션을 만드세요.",
      );
    if (state.pendingApproval || state.pendingAccess)
      throw new AppError(409, "현재 계획 또는 접근 요청을 먼저 승인하세요.");
    const lease = await readJsonFile<SessionLease>(
      path.join(this.store.sessionDir(id), "lease.json"),
    );
    if (lease && checkProcessLiveness(lease.ownerPid) !== "dead")
      throw new AppError(409, "다른 워커가 이 세션을 실행하고 있습니다.");
    if (lease && Date.parse(lease.expiresAt) > Date.now())
      throw new AppError(409, "이전 소유권 lease가 만료될 때까지 기다리세요.");
    if (
      state.visits.some((v) =>
        v.attempts.some(
          (a) =>
            a.failureKind === "orphaned_process" &&
            a.pid &&
            checkProcessLiveness(a.pid) !== "dead",
        ),
      )
    )
      throw new AppError(
        409,
        "종료를 확인하지 못한 자식 프로세스가 있어 재개할 수 없습니다.",
      );
    if (
      automatic &&
      state.status !== "RUNNING" &&
      (state.status !== "RECOVERING" ||
        !state.automaticRecovery ||
        Date.parse(state.automaticRecovery.resumeAt) > Date.now())
    )
      return state;
    const budgetReason = sessionBudgetReason(state);
    if (budgetReason) {
      const paused = await this.store.mutateSession(id, (s) =>
        pauseForBudget(s, budgetReason),
      );
      this.emitStudio({ type: "session", sessionId: id, data: paused });
      if (!automatic) throw new AppError(409, budgetReason);
      return paused;
    }
    await this.store.mutateSession(id, (s) => {
      beginResume(s);
    });
    this.spawn(id, automatic ? "automatic" : "manual");
    return this.store.readSession(id);
  }
  async action(id: string, action: SessionAction): Promise<SessionState> {
    if (!action || !safeId(action.requestId))
      throw new AppError(400, "요청 ID가 필요합니다.");
    const previous = await this.store.readSession(id);
    if (previous.processedRequests.includes(action.requestId)) return previous;
    if (action.type === "resume") return this.resume(id);
    if (action.type === "stop" || action.type === "interrupt") {
      const state = await this.store.readSession(id);
      if (state.status === "SUCCESS")
        throw new AppError(409, "완료된 세션입니다.");
      if (!["RUNNING", "RECOVERING"].includes(state.status)) {
        // A held worker no longer polls controls while releasing its lease.
        // Let it exit before deciding whether a new queued request is needed.
        const deadline = Date.now() + 2_000;
        while (this.children.has(id) && Date.now() < deadline) await delay(25);
        if (this.children.has(id))
          throw new AppError(
            409,
            "세션 워커가 종료되는 중입니다. 잠시 후 다시 시도하세요.",
          );
      }
      const lease = await readJsonFile<SessionLease>(
        path.join(this.store.sessionDir(id), "lease.json"),
      );
      const ownerAlive =
        lease && checkProcessLiveness(lease.ownerPid) !== "dead";
      if (!this.children.has(id) && !ownerAlive) {
        const updated = await this.store.mutateSession(id, (s) => {
          if (action.type === "stop") stopSession(s);
          else interruptSession(s, action.message);
        });
        this.emitStudio({ type: "session", sessionId: id, data: updated });
        if (action.type === "interrupt") return this.resume(id);
        return updated;
      }
      const paths = getControlQueuePaths(this.store.sessionDir(id));
      const existing = await readControlAck(paths, action.requestId);
      if (existing?.completedAt) return this.store.readSession(id);
      // Request ID is retained across HTTP retries, including STOP queues.
      await fs.mkdir(paths.requests, { recursive: true });
      const request = {
        requestId: action.requestId,
        type:
          action.type === "stop" ? ("STOP" as const) : ("INTERRUPT" as const),
        createdAt: new Date().toISOString(),
        message: action.message ?? null,
      };
      await atomicWriteJsonFile(
        path.join(paths.requests, `${request.requestId}.json`),
        request,
      );
      this.children.get(id)?.send({ type: "control" });
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const ack = await readControlAck(paths, action.requestId);
        if (ack?.completedAt) return this.store.readSession(id);
        await delay(50);
      }
      if (action.type === "stop") {
        const ownerPid = this.children.get(id)?.pid ?? lease?.ownerPid;
        if (
          ownerPid &&
          (await terminateProcessTreeBounded(
            ownerPid,
            state.settings.killTimeoutMs,
          )) !== "dead"
        ) {
          await this.store.mutateSession(id, (s) => {
            s.status = "BLOCKED";
            s.statusReason = "워커 종료를 확인할 수 없습니다.";
          });
        } else
          await this.store.mutateSession(id, (s) => {
            stopSession(s, "중지 요청 응답 한도를 넘겨 워커를 종료했습니다.");
          });
      }
      return this.store.readSession(id);
    }
    const updated = await this.store.action(id, action);
    this.emitStudio({ type: "session", sessionId: id, data: updated });
    if (["approve_plan", "approve_access"].includes(action.type)) {
      // The held worker may still be releasing its lease; wait for its exit.
      const deadline = Date.now() + 2_000;
      while (this.children.has(id) && Date.now() < deadline) await delay(25);
      return this.resume(id);
    }
    return updated;
  }
  async deleteSession(id: string): Promise<void> {
    const state = await this.store.readSession(id);
    if (
      this.children.has(id) ||
      ["RUNNING", "RECOVERING"].includes(state.status)
    )
      throw new AppError(409, "실행을 중지한 뒤 삭제하세요.");
    const dir = this.store.sessionDir(id),
      lease = await readJsonFile<SessionLease>(path.join(dir, "lease.json"));
    if (
      state.visits.some((v) =>
        v.attempts.some((a) => a.pid && checkProcessLiveness(a.pid) !== "dead"),
      )
    )
      throw new AppError(
        409,
        "자식 프로세스가 남아 있는 세션은 삭제할 수 없습니다.",
      );
    if (
      lease &&
      [lease.ownerPid, lease.childPid].some(
        (pid) => pid && checkProcessLiveness(pid) !== "dead",
      )
    )
      throw new AppError(
        409,
        "활성 프로세스가 있는 세션은 삭제할 수 없습니다.",
      );
    const tombstone = path.join(
      this.store.root,
      `deleted-${id}-${randomUUID()}`,
    );
    await fs.rename(dir, tombstone);
    await fs.rm(tombstone, { recursive: true, force: true });
  }
  startMonitor(): void {
    this.monitor = setInterval(() => {
      if (this.monitoring || this.closing) return;
      this.monitoring = true;
      void this.reconcile()
        .catch((error) => this.emit("monitorError", error))
        .finally(() => {
          this.monitoring = false;
        });
    }, 1_000);
  }
  private async reconcile(): Promise<void> {
    const summaries = await this.store.sessionSummaries();
    const ids = new Set(summaries.map((s) => s.id));
    for (const id of this.published.keys())
      if (!ids.has(id)) this.published.delete(id);
    for (const summary of summaries) {
      const previous = this.published.get(summary.id);
      if (
        previous &&
        !isNewerSession(summary, previous) &&
        !["RUNNING", "RECOVERING", "WAITING_USER"].includes(summary.status)
      )
        continue;
      const s = await this.store.readSession(summary.id);
      this.emitStudio({ type: "session", sessionId: s.id, data: s });
      if (this.children.has(s.id)) continue;
      const budgetReason = sessionBudgetReason(s);
      if (
        budgetReason &&
        ["RUNNING", "RECOVERING", "WAITING_USER"].includes(s.status)
      ) {
        const owner = await readJsonFile<SessionLease>(
          path.join(this.store.sessionDir(s.id), "lease.json"),
        );
        if (owner && checkProcessLiveness(owner.ownerPid) !== "dead") continue;
        const unresolvedChild = [
          owner?.childPid,
          ...s.visits.flatMap((v) => v.attempts.map((a) => a.pid)),
        ].some((pid) => pid && checkProcessLiveness(pid) !== "dead");
        const paused = await this.store.mutateSession(s.id, (state) => {
          if (
            !this.children.has(s.id) &&
            state.updatedAt === s.updatedAt &&
            ["RUNNING", "RECOVERING", "WAITING_USER"].includes(state.status)
          ) {
            pauseForBudget(state, budgetReason);
            if (unresolvedChild) {
              state.status = "BLOCKED";
              state.statusReason = `${budgetReason} 이전 자식 프로세스의 종료를 확인할 수 없어 차단했습니다.`;
            }
          }
        });
        this.emitStudio({ type: "session", sessionId: s.id, data: paused });
        continue;
      }
      if (
        s.status === "RECOVERING" &&
        s.automaticRecovery &&
        Date.parse(s.automaticRecovery.resumeAt) <= Date.now()
      ) {
        await this.resume(s.id, true).catch(() => {});
        continue;
      }
      if (s.status === "RUNNING") {
        const lease = await readJsonFile<SessionLease>(
          path.join(this.store.sessionDir(s.id), "lease.json"),
        );
        const missingOwner =
          !lease && Date.now() - Date.parse(s.updatedAt) > 5_000;
        if (
          missingOwner ||
          (lease &&
            checkProcessLiveness(lease.ownerPid) === "dead" &&
            Date.parse(lease.expiresAt) <= Date.now())
        ) {
          const active = s.visits.find((v) => v.id === s.activeVisitId);
          if (
            missingOwner ||
            active?.attempts.some((a) => a.activity !== "initial_transport")
          ) {
            const paused = await this.store.mutateSession(s.id, (state) => {
              // A manual resume may have started a new worker since the
              // monitor read this snapshot/lease. Never pause its new state
              // using the previous owner's stale evidence.
              if (
                this.children.has(s.id) ||
                state.updatedAt !== s.updatedAt ||
                state.status !== "RUNNING"
              )
                return;
              state.status = "PAUSED";
              state.statusReason =
                "이전 워커의 소유권을 확인할 수 없습니다. 모델 사용 가능성이 있어 수동 재개가 필요합니다.";
            });
            this.emitStudio({ type: "session", sessionId: s.id, data: paused });
          } else await this.resume(s.id, true).catch(() => {});
        }
      }
    }
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.monitor) clearInterval(this.monitor);
    const ids = new Set<string>();
    for (const state of await this.store.sessions())
      if (
        state.status === "RECOVERING" ||
        (state.status === "RUNNING" && this.children.has(state.id))
      )
        ids.add(state.id);
    await Promise.allSettled(
      [...ids].map((id) =>
        this.action(id, { requestId: randomUUID(), type: "stop" }),
      ),
    );
    const deadline = Date.now() + 2_000;
    while (this.children.size && Date.now() < deadline) await delay(20);
    this.children.clear();
  }
}
