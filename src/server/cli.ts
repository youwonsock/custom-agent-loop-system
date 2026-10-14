#!/usr/bin/env node
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "./app";
import { StudioStore } from "../core/store";
import { SessionCoordinator } from "./coordinator";
import { readJsonFile } from "../core/resilience";
import { queryModels } from "../core/catalog";
const args = process.argv.slice(2),
  command = args[0] ?? "ui";
function option(key: string, fallback?: string): string | undefined {
  const index = args.indexOf(`--${key}`);
  return index < 0 ? fallback : args[index + 1];
}
const root = path.resolve(
  option("root", path.join(os.homedir(), ".agent-loop", "graph-workspace"))!,
);
async function main(): Promise<void> {
  if (["--help", "-h", "help"].includes(command)) {
    process.stdout.write(
      "Agent Graph Studio 4.0.0\n\nagent-loop ui [--root <directory>] [--port 4317] [--no-open]\nagent-loop init [--root <directory>]\nagent-loop graphs [--root <directory>]\nagent-loop models --connection <id> --target <directory>\nagent-loop run --graph <id> --goal <text> --target <directory>\nagent-loop resume --session <id>\n\nNode.js 24+ and authenticated local coding CLIs are required.\n",
    );
    return;
  }
  if (command === "ui") {
    const port = Number(option("port", "4317"));
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("port는 0~65535 정수여야 합니다.");
    const server = await createServer({
      root,
      devOrigin: option("dev-origin"),
    });
    let address: string;
    try {
      address = await server.app.listen({ host: "127.0.0.1", port });
    } catch (error) {
      await server.app.close();
      throw error;
    }
    server.setOrigin(address);
    process.stdout.write(
      `Agent Graph Studio: ${address}\nData: ${root}\n브라우저를 닫아도 실행은 계속됩니다. 종료: Ctrl+C\n`,
    );
    if (!args.includes("--no-open")) {
      const [binary, browserArgs] =
        process.platform === "darwin"
          ? ["open", [address]]
          : process.platform === "win32"
            ? ["cmd", ["/d", "/c", "start", "", address]]
            : ["xdg-open", [address]];
      const browser = spawn(binary as string, browserArgs as string[], {
        stdio: "ignore",
        windowsHide: true,
      });
      browser.on("error", () =>
        process.stdout.write(`브라우저에서 ${address} 를 여세요.\n`),
      );
    }
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void server.app
        .close()
        .then(
          () => {
            process.exitCode = 0;
          },
          (error) => {
            console.error(error);
            process.exitCode = 1;
          },
        )
        .finally(() => {
          if (process.connected) process.disconnect?.();
        });
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    // A managed launcher can request the same graceful close on every OS.
    // Windows child.kill() does not deliver a catchable POSIX signal.
    process.on("message", (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "shutdown"
      )
        close();
    });
    process.on("disconnect", close);
    return;
  }
  const store = new StudioStore(root);
  await store.init();
  if (command === "init") {
    process.stdout.write(`Initialized ${root}\n`);
    return;
  }
  if (command === "graphs") {
    process.stdout.write(JSON.stringify(await store.graphs(), null, 2) + "\n");
    return;
  }
  if (command === "models") {
    const c = (await store.connections()).find(
      (c) => c.id === option("connection"),
    );
    if (!c) throw new Error("등록한 --connection ID를 지정하세요.");
    process.stdout.write(
      JSON.stringify(
        await queryModels(c, option("target", process.cwd())!),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const manager = new SessionCoordinator(store);
  if (command === "run") {
    let id = option("graph");
    if (!id) throw new Error("--graph ID 또는 JSON 파일을 지정하세요.");
    if (id.endsWith(".json")) {
      const doc = await readJsonFile(path.resolve(id));
      id = (await store.createGraph({ document: doc })).id;
    }
    const graph = await store.graph(id);
    const state = await manager.start({
      requestId: crypto.randomUUID(),
      graphId: id,
      expectedRevision: graph.revision,
      goal: option("goal", "")!,
      targetProjectPath: option("target", process.cwd())!,
      accessMode: args.includes("--full-access") ? "full_access" : "ask",
    });
    process.stdout.write(
      `Session: ${state.id}\n승인과 상태 확인: agent-loop ui --root ${root}\n`,
    );
  } else if (command === "resume") {
    const id = option("session");
    if (!id) throw new Error("--session ID를 지정하세요.");
    await manager.resume(id);
  } else throw new Error(`지원되지 않는 명령: ${command}`);
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
