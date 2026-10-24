#!/usr/bin/env node
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "./app";
import { StudioStore } from "../core/store";
import { SessionCoordinator } from "./coordinator";
import { readJsonFile } from "../core/resilience";
import { runBrowserVerification } from "../core/browser_verification";
import { runNodeTestVerification, summarizeNodeTestReport } from "../core/node_test_verification";
import { validateManifest } from "../core/verification_contract";
import { inside } from "../core/verification_sources";
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
      "Agent Graph Studio 4.0.0\n\nagent-loop ui [--root <directory>] [--port 4317] [--no-open]\nagent-loop init [--root <directory>]\nagent-loop graphs [--root <directory>]\nagent-loop models --connection <id> --target <directory>\nagent-loop run --graph <id> --goal <text> --target <directory>\nagent-loop resume --session <id>\nagent-loop init --autonomous\nagent-loop verify-browser --spec .agent-graph/browser.json [--target <directory>]\nagent-loop verify-node-tests [--target <directory>]\n\nNode.js 24+ and authenticated local coding CLIs are required.\n",
    );
    return;
  }
  if (command === "verify-node-tests") {
    if(args.includes("--help")){process.stdout.write("Run the frozen nodeTests contract: authored scope cases, no-op controls, required assertion failures for protected production mutations. Output: verification/node-tests/report.json. Existing native sandbox and approvals remain binding.\n");return;}
    const controller=new AbortController();
    const abort=()=>controller.abort(Error("Node verification cancelled"));
    process.once("SIGINT",abort);process.once("SIGTERM",abort);
    try {
      const fs = await import("node:fs/promises");
      const target=path.resolve(option("target",process.cwd())!);
      const real=await fs.realpath(target),file=await inside(real,".agent-graph/verification.json");
      if((await fs.stat(file)).size>1024*1024||(await fs.lstat(path.join(real,".agent-graph/verification.json"))).isSymbolicLink())throw Error("Node verification contract must be a bounded regular project file.");
      const raw=JSON.parse(await fs.readFile(file,"utf8"));
      const reqs=[...new Set<string>(raw.checks.flatMap((c:{requirements:string[]})=>c.requirements))];
      const manifest=validateManifest(raw,reqs,false);
      const report=await runNodeTestVerification({target,manifest,signal:controller.signal});
      process.stdout.write(JSON.stringify(summarizeNodeTestReport(report),null,2)+"\n");
      process.exitCode=report.allPassed?0:1;
    } finally {process.off("SIGINT",abort);process.off("SIGTERM",abort);}
    return;
  }
  if (command === "verify-browser") {
    if (args.includes("--help")) {
      process.stdout.write(
        'Spec: {"version":1,"server":{"command":["node","server.mjs"]},"steps":[{"id":"page","type":"visible","selector":"h1"},{"id":"mobile","type":"viewport","width":390,"height":844},{"id":"bounds","type":"noOverflow"}]}\nTypes: viewport, click, press, drag, reload, visible, text, count, within, noOverflow, snapshot, sameSnapshot, differentSnapshot, noConsoleErrors, http. Each step needs a unique id. Output: verification/browser/report.json, screenshots, trace and source hashes. Requires locally installed playwright and Chromium. Executes inside the calling CLI sandbox; permission denial remains blocked.\n',
      );
      return;
    }
    const controller = new AbortController(),
      cancel = () => controller.abort(new Error("Verification cancelled"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const report = await runBrowserVerification({
        target: option("target", process.cwd())!,
        spec: option("spec", ".agent-graph/browser.json")!,
        signal: controller.signal,
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exitCode = report.allPassed ? 0 : 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
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
    if (args.includes("--autonomous")) {
      const graph = await store.createGraph({ template: "autonomous" });
      process.stdout.write(`Autonomous graph: ${graph.id}\n`);
    }
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
