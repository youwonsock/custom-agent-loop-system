#!/usr/bin/env node
// The macOS app owns this helper; only its own server receives shutdown IPC.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const project = path.resolve(option("project", path.join(__dirname, "..")));
const root = path.resolve(option("root", path.join(os.homedir(), ".agent-loop", "graph-workspace")));
const port = Number(option("port", "4317"));
const logDirectory = path.join(os.homedir(), "Library", "Logs", "AgentGraphStudio");
const logPath = option("log", path.join(logDirectory, "launcher.log"));
const emit = (state, message, extra = {}) => process.stdout.write(JSON.stringify({ state, message, logPath, ...extra }) + "\n");
let server, preparing, logFd, stopping = false;
const environment = {
  ...process.env,
  PATH: [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || "/usr/bin:/bin"].join(path.delimiter),
  npm_config_cache: path.join(os.homedir(), "Library", "Caches", "AgentGraphStudio", "npm"),
};
async function stop() {
  if (stopping) return;
  stopping = true;
  emit("stopping", "서버를 안전하게 종료하고 있습니다.");
  if (preparing?.pid) {
    try { process.kill(-preparing.pid, "SIGTERM"); } catch { preparing.kill("SIGTERM"); }
  }
  if (server && server.exitCode === null && server.signalCode === null) {
    server.send({ type: "shutdown" });
    const timer = setTimeout(() => server.kill("SIGKILL"), 15_000);
    timer.unref();
    await new Promise(resolve => server.once("exit", resolve));
    clearTimeout(timer);
  }
  emit("stopped", "종료했습니다.");
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => { if (line.trim() === "shutdown") void stop(); });
input.on("close", () => void stop());

async function existingServer() {
  if (!port) return null;
  const url = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(1500) });
    const data = await response.json();
    if (response.ok && data.version === "4.0.0" && data.root === root && Array.isArray(data.graphs)) return url;
  } catch {}
  const occupied = await new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
  if (occupied) throw new Error(`${port} 포트가 다른 서버에서 사용 중입니다. 기존 서버를 확인한 뒤 다시 실행하세요.`);
  return null;
}
function npmFile() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "npm"), "/opt/homebrew/bin/npm", "/usr/local/bin/npm"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { const file = fs.realpathSync(candidate); if (file.endsWith(".js")) return file; } catch {}
  }
  throw new Error("npm을 찾을 수 없습니다. Node.js 24 이상의 설치를 확인하세요.");
}
async function runTask(taskArgs, label) {
  if (stopping) return;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, taskArgs, { cwd: project, env: environment, stdio: ["ignore", logFd, logFd], detached: true });
    preparing = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      preparing = null;
      if (stopping) resolve();
      else if (code === 0) resolve();
      else reject(new Error(`${label}이 실패했습니다${signal ? `: ${signal}` : `: ${code}`}. 로그에서 원인을 확인하세요.`));
    });
  });
}
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 이상이 필요합니다.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("실행 포트가 잘못되었습니다.");
  if (!fs.existsSync(path.join(project, "package.json"))) throw new Error("앱 실행기를 프로젝트 폴더 안에 두고 실행하세요.");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  logFd = fs.openSync(logPath, "a");
  const existing = await existingServer();
  if (stopping) return;
  if (existing) { emit("ready", "이미 실행 중인 서버에 연결했습니다.", { url: existing, owned: false }); return; }
  if (!fs.existsSync(path.join(project, "node_modules", "fastify", "package.json")) || !fs.existsSync(path.join(project, "node_modules", "typescript", "bin", "tsc"))) {
    emit("preparing", "처음 실행에 필요한 패키지를 설치하고 있습니다.");
    await runTask([npmFile(), "ci"], "패키지 설치");
  }
  emit("preparing", "최신 코드를 빌드하고 있습니다.");
  await runTask([path.join(project, "scripts", "build.js")], "앱 빌드");
  if (!stopping) startServer();
}
function startServer() {
  server = spawn(process.execPath, [path.join(project, "dist", "src", "server", "cli.js"), "ui", "--root", root, "--port", String(port), "--no-open"], { cwd: project, env: environment, stdio: ["ignore", "pipe", logFd, "ipc"] });
  let buffer = "", ready = false;
  const timer = setTimeout(() => { emit("error", "서버 시작 시간이 초과되었습니다. 로그를 확인하세요."); void stop(); }, 20_000);
  server.stdout.on("data", data => {
    fs.writeSync(logFd, data);
    buffer = (buffer + data.toString()).slice(-4000);
    const match = buffer.match(/Agent Graph Studio: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match && !ready) { ready = true; clearTimeout(timer); emit("ready", "서버가 실행 중입니다. 브라우저를 닫아도 작업은 계속됩니다.", { url: match[1], owned: true }); }
  });
  server.once("error", error => { clearTimeout(timer); emit("error", error.message); });
  server.once("exit", () => { clearTimeout(timer); if (!stopping) emit("error", "서버가 종료되었습니다. 로그를 확인한 뒤 실행기를 다시 여세요."); });
}
main().catch(error => { if (!stopping) emit("error", error.message); });
