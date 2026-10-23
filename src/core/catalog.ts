import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  LocalConnection,
  ModelCatalog,
  ModelInfo,
  ServiceType,
} from "../shared/domain";
import { cliDiagnostic, CliDiagnosticError } from "./cli_diagnostics";
import { checkProcessLiveness, delay } from "./resilience";
import { terminateProcessTreeBounded } from "./process_lifecycle";
import { modelPricing } from "./model_pricing";

export interface Executable {
  file: string;
  prefix: string[];
}
export async function resolveExecutable(binary: string): Promise<Executable> {
  const directories = (process.env.PATH ?? "").split(path.delimiter);
  const extensions =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".js"] : [""];
  const candidates =
    path.isAbsolute(binary) || binary.includes(path.sep)
      ? [path.resolve(binary)]
      : directories.flatMap((dir) =>
          extensions.map((ext) => path.join(dir, binary + ext)),
        );
  for (let candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat?.isFile()) continue;
    candidate = await fs.realpath(candidate);
    if (/\.[cm]?js$/i.test(candidate))
      return { file: process.execPath, prefix: [candidate] };
    if (/\.(cmd|bat)$/i.test(candidate)) {
      const source = await fs.readFile(candidate, "utf8");
      const script =
        source.match(/%dp0%[\\/]([^"\r\n]+\.[cm]?js)/i)?.[1] ??
        source.match(/%~dp0[\\/]([^"\r\n]+\.[cm]?js)/i)?.[1];
      if (script) {
        const native = path.resolve(path.dirname(candidate), script);
        if (await fs.stat(native).catch(() => null))
          return { file: process.execPath, prefix: [native] };
      }
      throw new Error(
        "이 Windows 실행 래퍼를 직접 실행할 수 없습니다. 실제 CLI 실행 파일 또는 JavaScript 진입점을 지정하세요.",
      );
    }
    if (process.platform !== "win32") await fs.access(candidate, 1);
    return { file: candidate, prefix: [] };
  }
  throw new Error(
    "CLI 실행 파일을 찾을 수 없습니다. 설치한 실행 파일의 경로를 확인하세요.",
  );
}
export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 2_000,
): Promise<void> {
  // A dead PID can precede the close event and release of Windows cwd handles.
  let closed =
    child.stdout.closed && child.stderr.closed &&
    (child.exitCode !== null || child.signalCode !== null);
  let onClose: () => void = () => {};
  const close = new Promise<void>((resolve) => {
    onClose = () => {
      closed = true;
      resolve();
    };
    child.once("close", onClose);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    child.stdin.destroy();
    if (child.pid && checkProcessLiveness(child.pid) !== "dead") {
      child.kill("SIGTERM");
      const deadline = Date.now() + 300;
      while (checkProcessLiveness(child.pid) === "alive" && Date.now() < deadline)
        await delay(20);
      if (checkProcessLiveness(child.pid) !== "dead")
        await terminateProcessTreeBounded(child.pid, timeoutMs);
      if (checkProcessLiveness(child.pid) !== "dead")
        throw new Error("조회 프로세스 종료를 확인할 수 없습니다.");
    }
    if (!closed) {
      await Promise.race([
        close,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("조회 프로세스 연결 종료를 확인할 수 없습니다.")),
            timeoutMs,
          );
        }),
      ]);
    }
  } finally {
    clearTimeout(timer);
    child.removeListener("close", onClose);
  }
}
export interface CatalogOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onPid?: (pid: number | null) => void;
  claudeQuery?: (
    binary: string,
    cwd: string,
    signal: AbortSignal,
  ) => Promise<ModelInfo[]>;
}
function classify(error: unknown): ModelCatalog["status"] {
  const diagnostic =
    error instanceof CliDiagnosticError
      ? error.diagnostic
      : cliDiagnostic(error);
  if (diagnostic.kind === "auth") return "auth_required";
  if (/not found|찾을 수|ENOENT|EACCES|executable/i.test(diagnostic.message))
    return "missing_binary";
  if (
    /unsupported|method not found|지원|version|protocol/i.test(
      diagnostic.message,
    )
  )
    return "unsupported";
  return "query_failed";
}
export function normalizeModels(
  input: unknown,
  providerId?: string,
): ModelInfo[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((raw: unknown): ModelInfo[] => {
    if (!raw || typeof raw !== "object") return [];
    const m = raw as Record<string, unknown>;
    if (m.hidden === true || m.disabled === true) return [];
    const value = [m.model, m.value, m.id].find(
      (v) => typeof v === "string" && v.trim(),
    );
    if (typeof value !== "string") return [];
    const id = providerId ? `${providerId}/${value}` : value;
    const efforts = Array.isArray(m.supportedReasoningEfforts)
      ? m.supportedReasoningEfforts.map((v) =>
          typeof v === "object" && v
            ? (v as Record<string, unknown>).reasoningEffort
            : v,
        )
      : Array.isArray(m.supportedEffortLevels)
        ? m.supportedEffortLevels
        : [];
    const variants = Array.isArray(m.variants)
      ? m.variants
      : m.variants && typeof m.variants === "object"
        ? Object.entries(m.variants)
            .filter(
              ([, value]) =>
                !(
                  value &&
                  typeof value === "object" &&
                  (value as Record<string, unknown>).disabled === true
                ),
            )
            .map(([name]) => name)
        : [];
    return [
      {
        id,
        label: String(m.displayName ?? m.name ?? value).slice(0, 300),
        pricing: modelPricing(m),
        variants: [
          ...new Set(
            [...efforts, ...variants].filter(
              (v): v is string => typeof v === "string" && v.length < 50,
            ),
          ),
        ],
        ...(typeof m.resolvedModel === "string"
          ? { resolvedModelId: m.resolvedModel }
          : {}),
      },
    ];
  });
}
async function codexModels(
  executable: Executable,
  cwd: string,
  signal: AbortSignal,
  onPid?: CatalogOptions["onPid"],
): Promise<ModelInfo[]> {
  if (signal.aborted) throw signal.reason;
  const child = spawn(executable.file, [...executable.prefix, "app-server"], {
    cwd,
    env: process.env,
    stdio: "pipe",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  onPid?.(child.pid ?? null);
  let buffer = "",
    stderr = "",
    id = 2;
  const pending = new Set<number>(),
    cursors = new Set<string>(),
    models: ModelInfo[] = [];
  try {
    return await new Promise<ModelInfo[]>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("조회 취소"));
      signal.addEventListener("abort", abort, { once: true });
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", abort);
        error
          ? reject(error)
          : resolve([...new Map(models.map((m) => [m.id, m])).values()]);
      };
      const send = (value: unknown) => {
        if (!child.stdin.writable)
          return finish(new Error("모델 조회 프로토콜 연결이 닫혔습니다."));
        child.stdin.write(JSON.stringify(value) + "\n");
      };
      const page = (cursor?: string) => {
        const requestId = id++;
        pending.add(requestId);
        send({
          id: requestId,
          method: "model/list",
          params: {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          },
        });
      };
      child.on("error", (error) => finish(error));
      child.on("exit", () =>
        finish(
          new Error(
            `CLI 모델 조회가 완료되기 전에 종료되었습니다. ${stderr.slice(-500)}`,
          ),
        ),
      );
      child.stderr.on("data", (b: Buffer) => {
        stderr = (stderr + b.toString()).slice(-2_000);
      });
      child.stdout.on("data", (b: Buffer) => {
        buffer += b.toString();
        if (buffer.length > 2_000_000)
          return finish(new Error("모델 조회 응답 한도를 초과했습니다."));
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === 1) {
            if (msg.error) return finish(new CliDiagnosticError(msg.error));
            send({ method: "initialized", params: {} });
            page();
          } else if (typeof msg.id === "number" && pending.delete(msg.id)) {
            if (msg.error) return finish(new CliDiagnosticError(msg.error));
            const result = msg.result as Record<string, unknown> | undefined;
            if (!result || !Array.isArray(result.data))
              return finish(new Error("지원되지 않는 model/list 응답입니다."));
            models.push(...normalizeModels(result.data));
            if (typeof result.nextCursor === "string" && result.nextCursor) {
              if (cursors.has(result.nextCursor) || cursors.size >= 50)
                return finish(
                  new Error("모델 조회 페이지 순환이 감지되었습니다."),
                );
              cursors.add(result.nextCursor);
              page(result.nextCursor);
            } else finish();
          }
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "agent_graph_studio", version: "4.0.0" },
          capabilities: {},
        },
      });
    });
  } finally {
    await stopChild(child);
    onPid?.(null);
  }
}
async function serverModels(
  type: ServiceType,
  executable: Executable,
  cwd: string,
  signal: AbortSignal,
  onPid?: CatalogOptions["onPid"],
): Promise<ModelInfo[]> {
  if (signal.aborted) throw signal.reason;
  const child = spawn(
    executable.file,
    [...executable.prefix, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd,
      env: process.env,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  onPid?.(child.pid ?? null);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const abort = () => reject(signal.reason ?? new Error("조회 취소"));
      signal.addEventListener("abort", abort, { once: true });
      const finish = (url?: string, error?: Error) => {
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(url!);
      };
      const data = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
        const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
        if (match) finish(match[0]);
      };
      child.stdout.on("data", data);
      child.stderr.on("data", data);
      child.on("error", (error) => finish(undefined, error));
      child.on("exit", () =>
        finish(undefined, new Error(`${type} 서버 모델 조회 초기화 실패`)),
      );
    });
    const headers: Record<string, string> = {};
    const password =
      process.env[
        type === "kilo" ? "KILO_SERVER_PASSWORD" : "OPENCODE_SERVER_PASSWORD"
      ];
    if (password)
      headers.Authorization = `Basic ${Buffer.from(`${process.env[type === "kilo" ? "KILO_SERVER_USERNAME" : "OPENCODE_SERVER_USERNAME"] ?? type}:${password}`).toString("base64")}`;
    const response = await fetch(
      `${url}/provider?directory=${encodeURIComponent(cwd)}`,
      { signal, headers },
    );
    if (!response.ok)
      throw new CliDiagnosticError({
        statusCode: response.status,
        message: `공급자 모델 조회 HTTP ${response.status}`,
      });
    const data = (await response.json()) as {
      all?: Array<{
        id: string;
        models: Record<string, Record<string, unknown>>;
      }>;
      connected?: string[];
      failed?: string[];
    };
    if (!Array.isArray(data.all) || !Array.isArray(data.connected))
      throw new Error("지원되지 않는 공급자 모델 API 응답입니다.");
    const connected = new Set(
      data.connected.filter((id) => !data.failed?.includes(id)),
    );
    return data.all
      .filter((p) => connected.has(p.id))
      .flatMap((p) =>
        normalizeModels(
          Object.entries(p.models ?? {}).map(([id, m]) => ({ ...m, id })),
          p.id,
        ),
      );
  } finally {
    await stopChild(child);
    onPid?.(null);
  }
}
async function claudeModels(
  binary: string,
  cwd: string,
  signal: AbortSignal,
  onPid?: CatalogOptions["onPid"],
): Promise<ModelInfo[]> {
  if (signal.aborted) throw signal.reason;
  const executable = await resolveExecutable(binary);
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  async function* idle(): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });
  }
  let child: ChildProcessWithoutNullStreams | null = null;
  const query = sdk.query({
    prompt: idle(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: binary,
      settingSources: ["user", "project", "local"],
      persistSession: false,
      abortController: controller,
      spawnClaudeCodeProcess: (options) => {
        const args =
          executable.prefix.length && options.args[0] !== executable.prefix[0]
            ? [...executable.prefix, ...options.args]
            : options.args;
        const spawned = spawn(
          executable.prefix.length ? executable.file : options.command,
          args,
          {
            cwd: options.cwd,
            env: options.env,
            stdio: "pipe",
            windowsHide: true,
            detached: process.platform !== "win32",
          },
        );
        child = spawned;
        onPid?.(spawned.pid ?? null);
        return spawned;
      },
    },
  });
  try {
    return normalizeModels(await query.supportedModels());
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort();
    query.close();
    if (child) await stopChild(child);
    onPid?.(null);
  }
}
export async function queryModels(
  connection: LocalConnection,
  target: string,
  options: CatalogOptions = {},
): Promise<ModelCatalog> {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      options.signal?.reason ?? new Error("모델 조회를 취소했습니다."),
    );
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("모델 조회 시간 한도에 도달했습니다.")),
    options.timeoutMs ?? 30_000,
  );
  let cwd = path.resolve(target);
  try {
    cwd = await fs.realpath(cwd);
    if (!(await fs.stat(cwd)).isDirectory())
      throw new Error("대상 프로젝트 폴더가 필요합니다.");
    const executable = await resolveExecutable(connection.binary);
    const models =
      connection.type === "codex"
        ? await codexModels(executable, cwd, controller.signal, options.onPid)
        : connection.type === "claude"
          ? await (options.claudeQuery
              ? options.claudeQuery(
                  executable.prefix[0] ?? executable.file,
                  cwd,
                  controller.signal,
                )
              : claudeModels(
                  executable.prefix[0] ?? executable.file,
                  cwd,
                  controller.signal,
                  options.onPid,
                ))
          : await serverModels(
              connection.type,
              executable,
              cwd,
              controller.signal,
              options.onPid,
            );
    return {
      connectionId: connection.id,
      binary: connection.binary,
      targetProjectPath: cwd,
      queriedAt: new Date().toISOString(),
      status: models.length ? "ready" : "empty",
      models,
      error: models.length
        ? null
        : "조회된 모델이 없습니다. CLI의 인증과 프로젝트 설정을 확인하세요.",
    };
  } catch (error) {
    const diagnostic =
      error instanceof CliDiagnosticError
        ? error.diagnostic
        : cliDiagnostic(error);
    const message = diagnostic.message.slice(0, 1000);
    return {
      connectionId: connection.id,
      binary: connection.binary,
      targetProjectPath: cwd,
      queriedAt: new Date().toISOString(),
      status: classify(error),
      models: [],
      error: message,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
