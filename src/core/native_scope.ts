import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NativeScopeAudit, SessionState } from "../shared/domain";
import { canonicalCommand, literalShellWords } from "./verification_evidence";

export const SCOPE_DENIED = "[AGENT_GRAPH_SCOPE_DENIED]";
export const SCOPE_VIOLATION = "[AGENT_GRAPH_SCOPE_VIOLATION]";
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const apiFor = (cwd: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? path.win32 : path.posix;
function within(root: string, file: string, api: typeof path.posix): boolean {
  const relative = api.relative(root, file);
  return relative === "" || (!relative.startsWith(".." + api.sep) && relative !== ".." && !api.isAbsolute(relative));
}
function realPath(file: string): string {
  let ancestor = file;
  const suffix: string[] = [];
  for (;;) {
    try { return path.resolve(fs.realpathSync.native(ancestor), ...suffix.reverse()); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // lstat distinguishes a dangling link from a genuinely absent path.
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw Error("unresolved symlink"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw Error("no resolvable ancestor");
      suffix.push(path.basename(ancestor)); ancestor = parent;
    }
  }
}
export function scopePathProblem(value: string, cwd: string, roots: readonly string[], glob = false): string | null {
  if (!value || /[\0\r\n$`]|^[a-z]+:\/\//i.test(value) || value.split(/[\\/]/).includes("..")) return "ambiguous or parent-traversing path";
  const api = apiFor(cwd);
  let name = value === "~" ? os.homedir() : value.startsWith("~/") || value.startsWith("~\\") ? api.join(os.homedir(), value.slice(2)) : value;
  if (glob) {
    const index = name.search(/[*?\[\]{}!]/);
    if (index >= 0) name = name.slice(0, index).replace(/[^\\/]*$/, "") || ".";
  }
  const file = api.resolve(cwd, name), approved = roots.map(root => api.resolve(cwd, root));
  // Foreign-platform paths are used only by pure compatibility checks.
  if (api !== path.posix && process.platform !== "win32") return approved.some(root=>within(root,file,api))?null:"outside approved target roots";
  try {
    const realRoots=approved.map(realPath);
    if(![...approved,...realRoots].some(root=>within(root,file,api)))return "outside approved target roots";
    const real = realPath(file);
    if (!realRoots.some(root => within(root, real, api))) return "symlink leaves approved target roots";
  } catch { return "cannot establish the real target path"; }
  return null;
}

/** Covers explicit native filesystem arguments and literal shell inspection.
 * Executed programs' internal IO still needs the CLI/OS sandbox. */
export function nativeScopePaths(tool: string, args: Obj, cwd: string): { paths: Array<{path:string;glob?:boolean}>; filesystem: boolean } {
  const name = tool.toLowerCase().replace(/[^a-z_]/g, "");
  if (["read", "glob", "grep", "list", "list_directory", "write", "edit", "multiedit", "delete", "move", "rename"].includes(name)) {
    const values = [args.filePath, args.file_path, args.path, args.directory, args.source, args.destination, ...(Array.isArray(args.paths) ? args.paths : [])].filter((v): v is string => typeof v === "string");
    if (["glob", "grep", "list", "list_directory"].includes(name) && !values.length) values.push(cwd);
    const paths: Array<{path:string;glob?:boolean}> = values.map(path => ({path}));
    const pattern=name==="glob"?args.pattern:name==="grep"?args.include:undefined;
    if(typeof pattern==="string"){
      const api=apiFor(cwd),base=values[0]??cwd;
      paths.push({path:api.isAbsolute(pattern)||pattern.startsWith("~")?pattern:`${base}${api.sep}${pattern}`,glob:true});
    }
    return {paths,filesystem:true};
  }
  if (name === "bash" && typeof args.command === "string") {
    const paths: Array<{path:string;glob?:boolean}> = [];
    for (const segment of canonicalCommand(args.command).split(/\s*(?:&&|;|\|)\s*/)) {
      const words = literalShellWords(segment);
      if (!words?.length) continue;
      const executable = words[0]!.split(/[\\/]/).at(-1)!.toLowerCase();
      if (!["ls", "dir", "cat", "head", "tail", "stat", "find", "get-content", "get-childitem"].includes(executable)) continue;
      const files: string[] = [];
      for (let i = 1; i < words.length; i++) {
        const word = words[i]!;
        if (/^-(?:n|c|f|format)$/.test(word)) { i++; continue; }
        if (word.startsWith("-")) { if (executable === "find") break; continue; }
        files.push(word);
      }
      if (!files.length && ["ls", "dir", "find", "get-childitem"].includes(executable)) files.push(cwd);
      paths.push(...files.map(path => ({path,glob:true})));
    }
    return {paths,filesystem:paths.length>0};
  }
  return {paths:[],filesystem:false};
}
export function nativeScopeProblem(tool: string, args: Obj, cwd: string, roots: readonly string[]): string | null {
  const candidates=nativeScopePaths(tool,args,cwd).paths;
  for (const candidate of candidates) {
    const problem = scopePathProblem(candidate.path,cwd,roots,candidate.glob);
    if (problem) return `${tool}: ${candidate.path.slice(0,1000)} (${problem})`;
  }
  // A recursive query may otherwise follow an in-target link to an outside
  // directory even though its explicit root passed the path check. Refuse the
  // query before execution if the searched tree cannot be kept within roots.
  const recursive=tool==="glob"||tool==="grep"||tool==="bash"&&typeof args.command==="string"&&/\bfind\b|\bls\s+-\w*R|[*?\[\]{}]/.test(args.command);
  if(recursive)for(const candidate of candidates){
    const wildcard=candidate.glob?candidate.path.search(/[*?\[\]{}!]/):-1;
    const raw=wildcard>=0?candidate.path.slice(0,wildcard).replace(/[^\\/]*$/,"")||".":candidate.path;
    const search=raw==="~"?os.homedir():raw.startsWith("~/")||raw.startsWith("~\\")?path.join(os.homedir(),raw.slice(2)):raw;
    let pending=[path.resolve(cwd,search)],scanned=0;const visited=new Set<string>();
    while(pending.length){
      const entry=pending.pop()!;
      if(++scanned>10000)return `${tool}: recursive query exceeds scope inspection limit; use a narrower target path`;
      try{
        const stat=fs.lstatSync(entry);
        if(stat.isSymbolicLink()){
          const problem=scopePathProblem(entry,cwd,roots);
          if(problem)return `${tool}: recursive query includes a link outside approved roots: ${entry.slice(0,1000)}`;
        }
        if(!fs.statSync(entry).isDirectory())continue;
        const real=fs.realpathSync.native(entry);if(visited.has(real))continue;visited.add(real);
        pending.push(...fs.readdirSync(entry).map(name=>path.join(entry,name)));
      }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")return `${tool}: cannot establish recursive query boundary`;}
    }
  }
  return null;
}

export class NativeScopeTracker {
  readonly audit: NativeScopeAudit;
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string,string>();
  constructor(private readonly cwd:string,private readonly roots:string[]) {
    this.audit={version:1,cwd,roots:[...roots],inspectedCalls:0,blockedCalls:0,outsideCalls:0,unresolvedCalls:0,blocked:[],violations:[]};
  }
  observe(event:Obj): void {
    if (event.type!=="tool_use") return;
    const part=obj(event.part),state=obj(part.state),args=obj(state.input),tool=String(part.tool??""),status=String(state.status??"");
    const paths=nativeScopePaths(tool,args,this.cwd);
    if (!paths.filesystem) return;
    const id=String(part.callID??part.id??""),problem=nativeScopeProblem(tool,args,this.cwd,this.roots);
    if (!["completed","success","error","failed","denied","rejected"].includes(status)) {
      if (problem && id) { if(this.pending.size>=256){this.audit.unresolvedCalls++;}else this.pending.set(id,problem); }
      return;
    }
    if (id) { this.pending.delete(id); if(this.seen.has(id))return;this.seen.add(id);if(this.seen.size>4096)this.seen.delete(this.seen.values().next().value!); }
    this.audit.inspectedCalls++;
    const blocked=(status!=="completed"&&status!=="success")&&(String(state.error??"").includes(SCOPE_DENIED)||["denied","rejected"].includes(status));
    if(blocked){this.audit.blockedCalls++;if(this.audit.blocked.length<64)this.audit.blocked.push({tool,path:problem??paths.paths.map(p=>p.path).join(", ").slice(0,1200)});return;}
    if(problem || (!paths.paths.length && ["completed","success"].includes(status))){this.audit.outsideCalls++;if(this.audit.violations.length<64)this.audit.violations.push({tool,path:problem??"missing filesystem path"});}
  }
  finish():void {this.audit.unresolvedCalls+=this.pending.size;this.pending.clear();}
}

export function scopeEvidenceProblem(state:SessionState):string|null {
  if(!state.graph.automation?.targetScopeGuard)return null;
  for(const visit of state.visits){
    const binding=state.bindings?.[visit.nodeId];
    for(const attempt of visit.attempts){
      const audit=attempt.scopeAudit;
      if(!audit&&state.connections?.find(c=>c.id===binding?.connectionId)?.type!=="kilo")continue;
      if(!audit||audit.version!==1||audit.cwd!==state.targetProjectPath||!Array.isArray(audit.roots)||!audit.roots.every(p=>typeof p==="string")||
        !audit.roots.includes(state.targetProjectPath)||!audit.roots.every(root=>[state.targetProjectPath,...(state.additionalAllowedPaths??[])].includes(root))||
        ![audit.inspectedCalls,audit.blockedCalls,audit.outsideCalls,audit.unresolvedCalls].every(n=>Number.isSafeInteger(n)&&n>=0)||
        !Array.isArray(audit.blocked)||!Array.isArray(audit.violations)||audit.blocked.length>64||audit.violations.length>64||audit.blockedCalls+audit.outsideCalls>audit.inspectedCalls)return "Kilo 대상 경계의 실행 증거가 없습니다.";
      if(audit.outsideCalls||audit.unresolvedCalls)return "대상 밖 native 파일 조회·탐색 또는 미확정 실행 기록이 남아 있습니다.";
    }
  }
  return null;
}
