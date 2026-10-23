import { applyApproval } from "./session_transitions";
import { SessionSummary, sessionSummary } from "../shared/session_updates";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AgentGraphDocument,
  LocalConnection,
  ModelCatalog,
  SERVICE_TYPES,
  SessionAction,
  SessionState,
} from "../shared/domain";
import {
  atomicWriteJsonFile,
  readJsonFile,
  withShortFileLock,
} from "./resilience";
import { createGraph, safeId, validateGraphDocument } from "./graph";
import { AppError } from "./errors";

export class StudioStore {
  private readonly summaryCache = new Map<string, { signature: string; summary: SessionSummary }>();
  constructor(readonly root: string) {}
  async init(): Promise<void> {
    await fs.mkdir(path.join(this.root, "graphs"), { recursive: true });
    await fs.mkdir(path.join(this.root, "sessions"), { recursive: true });
    await withShortFileLock(
      path.join(this.root, "initialize.lock"),
      async () => {
        if (!(await readJsonFile(path.join(this.root, "workspace.json")))) {
          await atomicWriteJsonFile(path.join(this.root, "workspace.json"), {
            version: 1,
            id: randomUUID(),
          });
          await atomicWriteJsonFile(path.join(this.root, "connections.json"), {
            version: 1,
            connections: [],
          });
          const graph = createGraph("기본 상호검증 루프");
          graph.revision = 1;
          await atomicWriteJsonFile(this.graphPath(graph.id), graph);
        }
      },
    );
  }
  private id(value: string): string {
    if (!safeId(value)) throw new AppError(400, "올바른 ID가 필요합니다.");
    return value;
  }
  graphPath(id: string): string {
    return path.join(this.root, "graphs", `${this.id(id)}.json`);
  }
  sessionDir(id: string): string {
    return path.join(this.root, "sessions", this.id(id));
  }
  async graphs(): Promise<AgentGraphDocument[]> {
    const files = (await fs.readdir(path.join(this.root, "graphs"))).filter(
      (f) => f.endsWith(".json"),
    );
    const docs = await Promise.all(
      files.map(async (f) => {
        const data = await readJsonFile<unknown>(
          path.join(this.root, "graphs", f),
        );
        return validateGraphDocument(data);
      }),
    );
    return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async graph(id: string): Promise<AgentGraphDocument> {
    const raw = await readJsonFile(this.graphPath(id));
    if (!raw) throw new AppError(404, "그래프가 없습니다.");
    return validateGraphDocument(raw);
  }
  async createGraph(input: {
    name?: string;
    empty?: boolean;
    document?: unknown;
  }): Promise<AgentGraphDocument> {
    const doc = input.document
      ? validateGraphDocument(input.document)
      : createGraph(input.name, input.empty);
    doc.id = randomUUID();
    doc.revision = 1;
    doc.updatedAt = new Date().toISOString();
    await atomicWriteJsonFile(this.graphPath(doc.id), doc);
    return doc;
  }
  async saveGraph(
    id: string,
    input: unknown,
    expectedRevision: number,
  ): Promise<AgentGraphDocument> {
    const doc = validateGraphDocument(input);
    if (doc.id !== id)
      throw new AppError(400, "그래프 ID가 일치하지 않습니다.");
    return withShortFileLock(`${this.graphPath(id)}.lock`, async () => {
      const current = await this.graph(id);
      if (current.revision !== expectedRevision)
        throw new AppError(
          409,
          "다른 창에서 그래프를 변경했습니다. 초안을 새 그래프로 저장하거나 서버 버전을 다시 읽으세요.",
          "revision_conflict",
          { revision: current.revision },
        );
      doc.revision = current.revision + 1;
      doc.updatedAt = new Date().toISOString();
      await atomicWriteJsonFile(this.graphPath(id), doc);
      return doc;
    });
  }
  async deleteGraph(id: string, expectedRevision: number): Promise<void> {
    await withShortFileLock(`${this.graphPath(id)}.lock`, async () => {
      const doc = await this.graph(id);
      if (doc.revision !== expectedRevision)
        throw new AppError(409, "그래프 버전이 변경되었습니다.");
      await fs.rm(this.graphPath(id));
    });
  }
  async connections(): Promise<LocalConnection[]> {
    const data = await readJsonFile<{
      version: number;
      connections: LocalConnection[];
    }>(path.join(this.root, "connections.json"));
    if (!data || data.version !== 1 || !Array.isArray(data.connections))
      throw new AppError(500, "실행 연결 저장소가 손상되었습니다.");
    return data.connections;
  }
  async saveConnection(input: unknown): Promise<LocalConnection> {
    const c = input as LocalConnection;
    if (
      !c ||
      !safeId(c.id) ||
      !SERVICE_TYPES.includes(c.type) ||
      typeof c.binary !== "string" ||
      !c.binary.trim() ||
      c.binary.includes("\0") ||
      typeof c.label !== "string" ||
      !c.label.trim()
    )
      throw new AppError(400, "CLI 종류, 이름과 실행 파일을 입력하세요.");
    const clean = {
      id: c.id,
      label: c.label.trim(),
      type: c.type,
      binary: c.binary.trim(),
    };
    await withShortFileLock(
      path.join(this.root, "connections.lock"),
      async () => {
        const values = await this.connections();
        const index = values.findIndex((x) => x.id === c.id);
        if (index >= 0) values[index] = clean;
        else values.push(clean);
        await atomicWriteJsonFile(path.join(this.root, "connections.json"), {
          version: 1,
          connections: values,
        });
      },
    );
    return clean;
  }
  async deleteConnection(id: string): Promise<void> {
    this.id(id);
    await withShortFileLock(
      path.join(this.root, "connections.lock"),
      async () => {
        await atomicWriteJsonFile(path.join(this.root, "connections.json"), {
          version: 1,
          connections: (await this.connections()).filter((c) => c.id !== id),
        });
      },
    );
  }
  async cacheCatalog(catalog: ModelCatalog): Promise<void> {
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256")
      .update(
        `${catalog.connectionId}\0${catalog.binary}\0${catalog.targetProjectPath}`,
      )
      .digest("hex");
    await atomicWriteJsonFile(
      path.join(this.root, "catalogs", `${key}.json`),
      catalog,
    );
  }
  async catalogs(): Promise<ModelCatalog[]> {
    const dir = path.join(this.root, "catalogs");
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const values = await Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map((n) => readJsonFile<ModelCatalog>(path.join(dir, n))),
    );
    return values.filter((v): v is ModelCatalog => Boolean(v));
  }
  async sessions(): Promise<SessionState[]> {
    const ids = await fs.readdir(path.join(this.root, "sessions"));
    const states = await Promise.all(
      ids.filter(safeId).map((id) => this.readSession(id).catch(() => null)),
    );
    return states
      .filter((v): v is SessionState => Boolean(v))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Stat all records, but decode only changed snapshots; never retain historical output in memory. */
  async sessionSummaries(): Promise<SessionSummary[]> {
    const ids = (await fs.readdir(path.join(this.root, "sessions"))).filter(safeId);
    const idSet = new Set(ids);
    for (const id of this.summaryCache.keys()) if (!idSet.has(id)) this.summaryCache.delete(id);
    const summaries = await Promise.all(ids.map(async id => {
      try {
        const info = await fs.stat(path.join(this.sessionDir(id), "state.json"));
        const signature = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
        const cached = this.summaryCache.get(id);
        if (cached?.signature === signature) return cached.summary;
        const summary = sessionSummary(await this.readSession(id));
        this.summaryCache.set(id, { signature, summary });
        return summary;
      } catch { this.summaryCache.delete(id); return null; }
    }));
    return summaries.filter((s): s is SessionSummary => !!s).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async readSession(id: string): Promise<SessionState> {
    const s = await readJsonFile<SessionState>(
      path.join(this.sessionDir(id), "state.json"),
    );
    if (!s) throw new AppError(404, "세션이 없습니다.");
    if (s.stateVersion !== 3)
      throw new AppError(400, "새 세션 형식만 지원합니다.");
    return s;
  }
  async writeSession(state: SessionState): Promise<void> {
    await withShortFileLock(path.join(this.sessionDir(state.id), "state.lock"), async () => {
      const current = await readJsonFile<SessionState>(path.join(this.sessionDir(state.id), "state.json"));
      if (current && (current.revision ?? 0) !== (state.revision ?? 0))
        throw new AppError(409, "더 새로운 세션 상태가 저장되어 이전 상태를 덮어쓸 수 없습니다.", "stale_session");
      state.revision = (current?.revision ?? 0) + 1;
      state.updatedAt = new Date().toISOString();
      await atomicWriteJsonFile(path.join(this.sessionDir(state.id), "state.json"), state);
    });
  }
  async mutateSession(
    id: string,
    change: (state: SessionState) => void,
  ): Promise<SessionState> {
    return withShortFileLock(
      path.join(this.sessionDir(id), "state.lock"),
      async () => {
        const s = await this.readSession(id);
        change(s);
        s.revision = (s.revision ?? 0) + 1;
        s.updatedAt = new Date().toISOString();
        await atomicWriteJsonFile(
          path.join(this.sessionDir(id), "state.json"),
          s,
        );
        return s;
      },
    );
  }
  visitDir(sessionId: string, visitId: string): string {
    return path.join(this.sessionDir(sessionId), "visits", this.id(visitId));
  }
  async savePlans(
    sessionId: string,
    visitId: string,
    plans: Array<{ id: number; body: string }>,
  ): Promise<void> {
    const dir = this.visitDir(sessionId, visitId);
    await fs.mkdir(dir, { recursive: true });
    for (const p of plans)
      await fs.writeFile(path.join(dir, `plan-${p.id}.md`), p.body, "utf8");
  }
  async action(id: string, action: SessionAction): Promise<SessionState> {
    if (!safeId(action.requestId))
      throw new AppError(400, "요청 ID가 필요합니다.");
    const state = await this.mutateSession(id, (s) => {
      applyApproval(s, action);
    });
    const visit = state.visits.find((v) => v.id === action.visitId);
    if (visit) await this.savePlans(id, visit.id, visit.plans);
    return state;
  }
  async directories(
    value: string,
  ): Promise<{ path: string; parent: string; directories: string[] }> {
    const resolved = await fs.realpath(path.resolve(value));
    if (!(await fs.stat(resolved)).isDirectory())
      throw new AppError(400, "프로젝트 폴더가 필요합니다.");
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return {
      path: resolved,
      parent: path.dirname(resolved),
      directories: entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort(),
    };
  }
}
