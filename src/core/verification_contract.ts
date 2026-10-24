import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { CommandReceipt, SessionState, VerificationContract, VerificationManifest } from "../shared/domain";
import { inside } from "./verification_sources";
import { isVerificationCommand, isBrowserVerificationCommand, checkCommandKey, canonicalCommand, projectCommandKey } from "./verification_evidence";
import { validateNodeTestPolicy, nodeTestScript } from "./node_test_policy";
import { nodeTestVerificationCommand } from "./node_test_command";
export const CONTRACT_FILE = ".agent-graph/verification.json";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const relative = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 500 && !v.includes("\\") && !path.posix.isAbsolute(v) && v.split("/").every(s => s !== ".." && s !== "." && s !== "") && !/^(?:node_modules|verification|artifacts|coverage|\.git)(?:\/|$)/.test(v);
export function validateManifest(value: unknown, requirements: string[], browser: boolean): VerificationManifest {
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.protectedFiles) || !value.protectedFiles.length || value.protectedFiles.length > 200 || !value.protectedFiles.every(relative) || new Set(value.protectedFiles).size !== value.protectedFiles.length || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 50) throw Error("검증 계약 version/보호 파일/검사 목록이 잘못되었습니다.");
  const ids = new Set<string>(), commands = new Set<string>(), covered = new Set<string>();
  const checks = value.checks.map(raw => {
    if (!plain(raw) || typeof raw.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.id) || ids.has(raw.id) || typeof raw.command !== "string" || raw.command.length > 4096 || !isVerificationCommand(raw.command) || commands.has(checkCommandKey(raw.command)) || !Array.isArray(raw.requirements) || !raw.requirements.length || !raw.requirements.every(id => typeof id === "string" && requirements.includes(id)) || new Set(raw.requirements).size !== raw.requirements.length) throw Error("검증 계약의 검사 ID·실제 foreground 명령·요구사항 연결을 확인하세요.");
    ids.add(raw.id); commands.add(checkCommandKey(raw.command)); raw.requirements.forEach(id => covered.add(id as string));
    return { id: raw.id, command: raw.command, requirements: [...raw.requirements] as string[] };
  });
  const missing = requirements.filter(id => !covered.has(id));
  if (missing.length) throw Error(`검증 계약에 검사 연결이 없습니다: ${missing.join(", ")}`);
  if (browser && !(value.protectedFiles as string[]).includes(".agent-graph/browser.json")) throw Error("자율 웹 계약에는 browser spec을 보호 파일로 등록해야 합니다.");
  if (browser && !checks.some(c => isBrowserVerificationCommand(c.command))) throw Error("자율 웹 계약에는 설치된 플랫폼 browser verifier 검사가 필요합니다.");
  if (!checks.some(c => isBrowserVerificationCommand(c.command) || c.command === nodeTestVerificationCommand() || (value.protectedFiles as string[]).some(file => /\.(?:[cm]?js|py|ts)$/.test(file) && c.command.includes(file)))) throw Error("보호된 인수 검사 파일을 직접 실행하는 검사가 필요합니다. npm script 이름만으로 검사 충분성을 보장하지 않습니다.");
  const manifest:VerificationManifest = { version: 1, protectedFiles: [...value.protectedFiles] as string[], checks };
  if (value.nodeTests !== undefined) manifest.nodeTests = validateNodeTestPolicy(value.nodeTests,manifest);
  return manifest;
}
function digest(manifest: VerificationManifest, hashes: Record<string,string>): string { return sha(JSON.stringify({manifest,hashes})); }
export function validContractSnapshot(v: unknown): v is VerificationContract {
  if (!plain(v) || v.version !== 1 || !["pending","locked"].includes(String(v.status))) return false;
  if (v.status === "pending") return v.manifest === undefined && v.hashes === undefined && v.digest === undefined;
  if (!["supplied","implementation"].includes(String(v.origin)) || typeof v.lockedAt !== "string" || !Number.isFinite(Date.parse(v.lockedAt)) || !plain(v.manifest) || !plain(v.hashes) || typeof v.digest !== "string") return false;
  if (!Object.entries(v.hashes).every(([file,hash])=>relative(file)&&typeof hash==="string"&&/^[a-f0-9]{64}$/.test(hash))) return false;
  try {
    const raw=v.manifest as Record<string,unknown>;
    const reqs=Array.isArray(raw.checks)?[...new Set(raw.checks.flatMap(c=>plain(c)&&Array.isArray(c.requirements)?c.requirements.filter((r):r is string=>typeof r==="string"):[]))]:[];
    validateManifest(raw,reqs,false);
  } catch { return false; }
  const expected = [...new Set([CONTRACT_FILE, ...(v.manifest as unknown as VerificationManifest).protectedFiles])].sort();
  if (JSON.stringify(Object.keys(v.hashes).sort()) !== JSON.stringify(expected)) return false;
  return digest(v.manifest as unknown as VerificationManifest,v.hashes as Record<string,string>)===v.digest;
}
async function fileHash(root: string, name: string): Promise<string> {
  const file = await inside(root, name);
  if ((await fs.lstat(path.join(root,name))).isSymbolicLink() || !(await fs.stat(file)).isFile()) throw Error(`검증 보호 파일은 일반 파일이어야 합니다: ${name}`);
  if ((await fs.stat(file)).size > 10*1024*1024) throw Error(`검증 보호 파일이 너무 큽니다: ${name}`);
  return sha(await fs.readFile(file));
}
export async function lockContract(state: SessionState, origin: "supplied"|"implementation"): Promise<VerificationContract> {
  const root = await fs.realpath(state.targetProjectPath);
  const manifestFile=await inside(root,CONTRACT_FILE);
  if((await fs.stat(manifestFile)).size>1024*1024)throw Error("검증 계약이 너무 큽니다.");
  const manifest = validateManifest(JSON.parse(await fs.readFile(manifestFile,"utf8")),state.requirements.items.map(r=>r.id),!!state.graph.automation?.browserVerification);
  if(state.graph.automation?.authoredNodeTests&&manifest.checks.some(c=>/^npm test(?:\s|$)/.test(c.command))&&!manifest.nodeTests)throw Error("새 자율 Node 프리셋에는 자체 테스트 영역·필수 케이스·보호된 결함 탐지 어댑터를 선언한 nodeTests 계약이 필요합니다.");
  const hashes: Record<string,string> = {};
  let totalBytes = 0;
  for (const name of [...new Set([CONTRACT_FILE,...manifest.protectedFiles])].sort()) {
    const file = await inside(root, name);
    totalBytes += (await fs.stat(file)).size;
    if (totalBytes > 50*1024*1024) throw Error("검증 보호 파일의 총 크기가 50MiB를 넘습니다.");
    hashes[name]=await fileHash(root,name);
  }
  return { version:1,status:"locked",origin,lockedAt:new Date().toISOString(),manifest,hashes,digest:digest(manifest,hashes) };
}
export async function contractViolation(state: SessionState): Promise<string|null> {
  const c=state.verificationContract;
  if (c?.status!=="locked") return null;
  if (!validContractSnapshot(c)) return "저장된 검증 계약의 무결성을 확인할 수 없습니다.";
  try { const root=await fs.realpath(state.targetProjectPath); for(const [name,hash]of Object.entries(c.hashes!)) if(await fileHash(root,name)!==hash)return `고정 검증 파일이 변경됐습니다: ${name}`; }
  catch(error){return `고정 검증 파일을 읽을 수 없습니다: ${error instanceof Error?error.message:String(error)}`;}
  return null;
}
export function missingContractReceipts(c: VerificationContract | undefined, commands: CommandReceipt[], required: boolean, cwd?: string): string[] {
  if (!required) return [];
  if (c?.status!=="locked" || !validContractSnapshot(c)) return ["locked verification contract"];
  return c.manifest!.checks.filter(check=>!commands.some(r=>r.exitCode===0&&!r.environmentError&&isVerificationCommand(r.command,cwd)&&projectCommandKey(r.command,cwd)===projectCommandKey(check.command,cwd))).map(c=>c.id);
}

export function contractProofMissing(state: SessionState, commands: CommandReceipt[]): string[] {
  return missingContractReceipts(state.verificationContract, commands, !!state.graph.automation?.verificationContract, state.targetProjectPath);
}

/** Reject observable shell failure masking in registered package runners before testing. */
export async function verificationRunnerProblem(state: SessionState): Promise<string|null> {
  if (state.verificationContract?.status !== "locked") return null;
  if(state.graph?.automation?.verificationContract&&state.graph.automation.authoredNodeTests&&state.verificationContract.manifest!.checks.some(c=>/^npm test(?:\s|$)/.test(c.command))&&!state.verificationContract.manifest!.nodeTests)return "자체 Node 테스트 계약 nodeTests가 필요합니다. 기존 검사를 우회하지 말고 필요한 영역·결함 탐지 계약을 준비하세요.";
  const scripts = state.verificationContract.manifest!.checks.flatMap(check => {
    const command = checkCommandKey(canonicalCommand(check.command));
    const match = command.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?((?:test|check|verify)[\w:-]*)(?:\s|$)/);
    return match ? [match[1]!] : [];
  });
  if (!scripts.length) return null;
  try {
    const root = await fs.realpath(state.targetProjectPath);
    const file = await inside(root, "package.json");
    if ((await fs.stat(file)).size > 1024*1024) return "package.json이 너무 큽니다.";
    const pkg = JSON.parse(await fs.readFile(file,"utf8"));
    if (state.verificationContract.manifest!.nodeTests && pkg.scripts?.test !== nodeTestScript(state.verificationContract.manifest!.nodeTests)) return `자체 Node 검사 계약은 npm test에서 모든 영역 파일을 직접 실행해야 합니다: ${nodeTestScript(state.verificationContract.manifest!.nodeTests)}`;
    const seen = new Set<string>();
    const inspect = (name: string): string|null => {
      if (seen.has(name)) return null;
      seen.add(name);
      if (seen.size > 100) return "검증 package script 참조가 너무 많습니다.";
      const body = pkg.scripts?.[name];
      if (typeof body !== "string" || !body.trim()) return `필수 package script가 없습니다: ${name}`;
      const stripped = body.replace(/2>&1/g, "");
      if (/\|\||\||--(?:passWithNoTests|if-present)\b|(?:^|[;&]\s*)(?:true|exit\s+0)\b/.test(stripped) || stripped.replace(/&&/g, "").includes("&")) return `필수 package script의 실패 마스킹·파이프·백그라운드 실행을 반려했습니다: ${name}`;
      for (const ref of body.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)) { const reason = inspect(ref[1]!); if (reason) return reason; }
      return null;
    };
    for (const script of scripts) { const reason=inspect(script); if(reason)return reason; }
    return null;
  } catch (error) { return `필수 package runner를 확인할 수 없습니다: ${error instanceof Error?error.message:String(error)}`; }
}
