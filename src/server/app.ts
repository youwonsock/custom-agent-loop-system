import { sessionSummary } from "../shared/session_updates";
import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StudioStore } from "../core/store";
import { discoverClis, queryModels } from "../core/catalog";
import { AppError, messageOf } from "../core/errors";
import { graphDiagnostics } from "../core/graph";
import { LocalConnection, SessionAction, StudioEvent } from "../shared/domain";
import { SessionCoordinator, StartRequest } from "./coordinator";
import { vmRuntimeAvailable } from "../core/program_io_vm";
import { IsolationSupport } from "../shared/isolation";
export interface ServerOptions {
  root: string;
  origin?: string;
  devOrigin?: string;
  defaultTarget?: string;
  monitor?: boolean;
}
export async function createServer(options: ServerOptions): Promise<{
  app: FastifyInstance;
  store: StudioStore;
  coordinator: SessionCoordinator;
  setOrigin: (origin: string) => void;
}> {
  const store = new StudioStore(path.resolve(options.root));
  await store.init();
  const coordinator = new SessionCoordinator(store),
    sessions = new Set<string>(),
    queries = new Set<AbortController>(),
    streams = new Set<import("node:http").ServerResponse>();
  let origin = options.origin ?? "http://127.0.0.1:4317";
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024, logger: false });
  await app.register(cookie);
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    if (host !== new URL(origin).host)
      throw new AppError(403, "허용되지 않은 Host입니다.");
    const given = request.headers.origin;
    if (given && given !== origin && given !== options.devOrigin)
      throw new AppError(403, "허용되지 않은 Origin입니다.");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    if (!request.url.startsWith("/api/")) return;
    if (request.url.split("?")[0] === "/api/bootstrap") {
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw new AppError(403, "같은 앱에서 요청하세요.");
      if (!request.cookies.studio || !sessions.has(request.cookies.studio)) {
        const token = randomBytes(32).toString("base64url");
        sessions.add(token);
        reply.setCookie("studio", token, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
        });
      }
      return;
    }
    if (!request.cookies.studio || !sessions.has(request.cookies.studio))
      throw new AppError(401, "앱을 다시 열어 연결하세요.");
    if (!["GET", "HEAD"].includes(request.method) && !given)
      throw new AppError(403, "변경 요청에는 앱 Origin이 필요합니다.");
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as AppError;
    reply.status(e.statusCode ?? 500).send({
      error: messageOf(error),
      code: e.code ?? "server_error",
      ...(e.details ? { details: e.details } : {}),
    });
  });
  app.get<{ Querystring: { summary?: string } }>(
    "/api/bootstrap",
    async (request) => ({
      version: "4.0.0",
      root: store.root,
      defaultTarget: options.defaultTarget ?? process.cwd(),
      isolation: {
        platform: process.platform,
        programIoVm:
          process.platform === "darwin" &&
          process.arch === "arm64" &&
          vmRuntimeAvailable(),
      } satisfies IsolationSupport,
      graphs: await store.graphs(),
      connections: await store.connections(),
      catalogs: await store.catalogs(),
      sessions:
        request.query.summary === "1"
          ? await store.sessionSummaries()
          : await store.sessions(),
    }),
  );
  app.get("/api/graphs", () => store.graphs());
  app.post("/api/graphs", async (request) => {
    const g = await store.createGraph(
      request.body as {
        name?: string;
        template?: "autonomous";
        empty?: boolean;
        document?: unknown;
      },
    );
    coordinator.emitStudio({ type: "graphs" });
    return g;
  });
  app.post("/api/graphs/import", async (request) => {
    const g = await store.createGraph({ document: request.body });
    coordinator.emitStudio({ type: "graphs" });
    return g;
  });
  app.get<{ Params: { id: string } }>("/api/graphs/:id", (request) =>
    store.graph(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/graphs/:id/export",
    async (request, reply) =>
      reply
        .header(
          "Content-Disposition",
          `attachment; filename="graph-${request.params.id}.json"`,
        )
        .send(await store.graph(request.params.id)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/graphs/:id/diagnostics",
    async (request) => graphDiagnostics(await store.graph(request.params.id)),
  );
  app.put<{
    Params: { id: string };
    Body: { document: unknown; expectedRevision: number };
  }>("/api/graphs/:id", async (request) => {
    const g = await store.saveGraph(
      request.params.id,
      request.body.document,
      request.body.expectedRevision,
    );
    coordinator.emitStudio({ type: "graphs" });
    return g;
  });
  app.delete<{ Params: { id: string }; Body: { expectedRevision: number } }>(
    "/api/graphs/:id",
    async (request) => {
      await store.deleteGraph(request.params.id, request.body.expectedRevision);
      coordinator.emitStudio({ type: "graphs" });
      return { ok: true };
    },
  );
  app.get("/api/connections", () => store.connections());
  app.post("/api/connections", async (request) => {
    const c = await store.saveConnection(request.body);
    coordinator.emitStudio({ type: "connections" });
    return c;
  });
  app.post("/api/connections/discover", () => discoverClis());
  app.delete<{ Params: { id: string } }>(
    "/api/connections/:id",
    async (request) => {
      await store.deleteConnection(request.params.id);
      coordinator.emitStudio({ type: "connections" });
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: { targetProjectPath: string } }>(
    "/api/connections/:id/models/query",
    async (request, reply) => {
      if (typeof request.body?.targetProjectPath !== "string")
        throw new AppError(400, "대상 프로젝트 경로를 지정하세요.");
      const c = (await store.connections()).find(
        (c) => c.id === request.params.id,
      );
      if (!c) throw new AppError(404, "실행 연결이 없습니다.");
      const controller = new AbortController();
      queries.add(controller);
      const close = () => {
        if (!reply.raw.writableEnded)
          controller.abort(new Error("조회 연결이 닫혔습니다."));
      };
      reply.raw.on("close", close);
      try {
        const catalog = await queryModels(
          c as LocalConnection,
          request.body.targetProjectPath,
          { signal: controller.signal },
        );
        await store.cacheCatalog(catalog);
        return catalog;
      } finally {
        queries.delete(controller);
        reply.raw.off("close", close);
      }
    },
  );
  app.get("/api/catalogs", () => store.catalogs());
  app.get<{ Querystring: { path?: string } }>("/api/directories", (request) =>
    store.directories(
      request.query.path ?? options.defaultTarget ?? process.cwd(),
    ),
  );
  app.get<{ Querystring: { summary?: string } }>("/api/sessions", (request) =>
    request.query.summary === "1" ? store.sessionSummaries() : store.sessions(),
  );
  app.post<{ Body: StartRequest }>("/api/sessions", async (request, reply) =>
    reply.code(202).send(await coordinator.start(request.body)),
  );
  app.get<{ Params: { id: string } }>("/api/sessions/:id", (request) =>
    store.readSession(request.params.id),
  );
  app.post<{ Params: { id: string }; Body: SessionAction }>(
    "/api/sessions/:id/actions",
    (request) => coordinator.action(request.params.id, request.body),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request) => {
      await coordinator.deleteSession(request.params.id);
      return { ok: true };
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { visitId?: string; attemptId?: string; offset?: string };
  }>("/api/sessions/:id/logs", async (request) => {
    const state = await store.readSession(request.params.id),
      visit =
        state.visits.find((v) => v.id === request.query.visitId) ??
        state.visits.at(-1),
      attempt =
        visit?.attempts.find((a) => a.id === request.query.attemptId) ??
        visit?.attempts.at(-1);
    if (!attempt || !visit) return { text: "", offset: 0 };
    const offset = Math.max(0, Number(request.query.offset ?? 0));
    if (!Number.isSafeInteger(offset))
      throw new AppError(400, "로그 위치가 잘못되었습니다.");
    const file = path.join(
      store.visitDir(state.id, visit.id),
      `${attempt.id}.log`,
    );
    const handle = await fs.open(file, "r").catch(() => null);
    if (!handle) return { text: "", offset: 0 };
    try {
      const buffer = Buffer.alloc(128 * 1024);
      const result = await handle.read(buffer, 0, buffer.length, offset);
      return {
        text: buffer.subarray(0, result.bytesRead).toString("utf8"),
        offset: offset + result.bytesRead,
        visitId: visit.id,
        attemptId: attempt.id,
      };
    } finally {
      await handle.close();
    }
  });
  app.get<{ Querystring: { summary?: string } }>(
    "/api/events",
    async (request, reply) => {
      reply.hijack();
      streams.add(reply.raw);
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      reply.raw.write("event: ready\ndata: {}\n\n");
      const listener = (event: StudioEvent) => {
        if (
          reply.raw.destroyed ||
          (request.query.summary === "1" && event.type === "log")
        )
          return;
        const outgoing =
          request.query.summary === "1" &&
          event.type === "session" &&
          event.data
            ? {
                ...event,
                data: sessionSummary(
                  event.data as import("../shared/domain").SessionState,
                ),
              }
            : event;
        reply.raw.write(`data: ${JSON.stringify(outgoing)}\n\n`);
        if (reply.raw.writableLength > 4 * 1024 * 1024) reply.raw.destroy(); // reconnect fetches the latest snapshot; bound slow-client buffering
      };
      coordinator.on("studio", listener);
      const timer = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
      }, 15_000);
      reply.raw.on("close", () => {
        clearInterval(timer);
        coordinator.off("studio", listener);
        streams.delete(reply.raw);
      });
    },
  );
  const webRoot = path.resolve(__dirname, "../../web");
  if (await fs.stat(path.join(webRoot, "index.html")).catch(() => null)) {
    await app.register(staticFiles, { root: webRoot, index: "index.html" });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "API가 없습니다." })
        : reply.sendFile("index.html"),
    );
  } else app.get("/", () => ({ message: "웹 앱을 빌드하세요: npm run build" }));
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
    for (const q of queries) q.abort();
    await coordinator.close();
  });
  if (options.monitor !== false) coordinator.startMonitor();
  return {
    app,
    store,
    coordinator,
    setOrigin: (value) => {
      origin = value;
    },
  };
}
