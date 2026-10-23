// Bootstrap helpers must work before project dependencies or dist exist.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const markerPath = project => path.join(project, "node_modules", ".agent-graph-install.json");
function fingerprint(project) {
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json"]) hash.update(fs.readFileSync(path.join(project, file))).update("\0");
  return { hash: hash.digest("hex"), nodeMajor: process.versions.node.split(".")[0], abi: process.versions.modules, platform: process.platform, arch: process.arch };
}
function validatePackages(project) {
  const manifest = read(path.join(project, "package.json"));
  const lock = read(path.join(project, "package-lock.json"));
  if (!manifest || !lock?.packages) throw new Error("package.json 또는 lockfile을 읽을 수 없습니다.");
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const expected = lock.packages[`node_modules/${name}`]?.version;
    const actual = read(path.join(project, "node_modules", name, "package.json"))?.version;
    if (!expected || actual !== expected) throw new Error(`설치 버전 불일치: ${name} (${actual ?? "없음"} / ${expected ?? "lockfile 누락"})`);
  }
  for (const file of ["typescript/bin/tsc", "vite/bin/vite.js"]) {
    if (!fs.existsSync(path.join(project, "node_modules", file))) throw new Error(`필수 실행 파일 누락: ${file}`);
  }
  const probe = spawnSync(process.execPath, ["-e", "require('node-pty')"], { cwd: project, encoding: "utf8", timeout: 10_000 });
  if (probe.error || probe.status !== 0) throw new Error(`node-pty 로딩 실패: ${probe.error?.message ?? probe.stderr}`);
}
async function ensureDependencies(project, install, signal) {
  const expected = fingerprint(project);
  let valid = JSON.stringify(read(markerPath(project))) === JSON.stringify(expected);
  if (valid) { try { validatePackages(project); } catch { valid = false; } }
  if (valid) return false;
  fs.rmSync(markerPath(project), { force: true });
  signal?.throwIfAborted();
  await install();
  signal?.throwIfAborted();
  validatePackages(project);
  if (JSON.stringify(fingerprint(project)) !== JSON.stringify(expected)) throw new Error("설치 중 프로젝트 의존성이 변경되었습니다. 다시 실행하세요.");
  fs.writeFileSync(markerPath(project), JSON.stringify(expected));
  return true;
}
function dead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}
// Publish a complete record atomically; an interrupted writer never leaves an empty lock.
function publish(file, record) {
  const temporary = `${file}.${record.id}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx" });
  try { fs.linkSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}
function reclaim(file) {
  const previous = read(file);
  if (!previous || !dead(previous.pid) || (previous.childPid && !dead(previous.childPid))) return;
  const guard = `${file}.reclaim`, token = { id: randomUUID(), pid: process.pid };
  try { publish(guard, token); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const held = read(guard);
    if (held && dead(held.pid) && read(guard)?.id === held.id) fs.rmSync(guard, { force: true });
    return;
  }
  try {
    const current = read(file);
    if (current?.id === previous.id && dead(current.pid) && (!current.childPid || dead(current.childPid))) fs.rmSync(file, { force: true });
  } finally { if (read(guard)?.id === token.id) fs.rmSync(guard, { force: true }); }
}
async function acquireSetupLock(project, { signal, timeoutMs = 300_000 } = {}) {
  const file = path.join(project, ".agent-graph-setup.lock");
  const record = { id: randomUUID(), pid: process.pid, childPid: null };
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    try { publish(file, record); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      reclaim(file);
      if (Date.now() >= deadline) throw new Error("다른 실행기가 프로젝트를 준비 중입니다. 종료를 확인한 뒤 다시 실행하세요.");
      await delay(50, undefined, { signal });
    }
  }
  return {
    setChild(pid) {
      if (read(file)?.id !== record.id) throw new Error("프로젝트 초기화 잠금 소유권을 잃었습니다.");
      record.childPid = pid;
      const temporary = `${file}.${record.id}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(record));
      fs.renameSync(temporary, file);
    },
    release() { if (read(file)?.id === record.id) fs.rmSync(file, { force: true }); },
  };
}
module.exports = { ensureDependencies, fingerprint, markerPath, validatePackages, acquireSetupLock };
