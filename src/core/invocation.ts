import { AgentNode, ExecutionBinding, LocalConnection } from "../shared/domain";
import { resolveExecutable } from "./catalog";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { kiloRecoveryAgents } from "./kilo_recovery";
import * as os from "node:os";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProgramIoPolicy, prepareProgramIo, IO_UNAVAILABLE } from "./program_io";
const execute=promisify(execFile);
export function isReadOnly(type: AgentNode["type"]): boolean {
  return ["planning", "review", "approval", "interrupt"].includes(type);
}
export async function buildInvocation(
  c: LocalConnection,
  b: ExecutionBinding,
  node: AgentNode,
  opts: {
    prompt: string;
    cwd: string;
    fullAccess: boolean;
    allowedPaths: string[];
    resumeId?: string;
    nativeApprovalReview?: boolean;
    localHttpAccess?: boolean;
    verificationCommands?: string[];
    disableWrite?: boolean;
    testSourcesReadOnly?: boolean;
    guardOwnedProcesses?: boolean;
    verificationAliases?: Record<string,string>;
    scopeRoots?: string[];
    programIoGuard?: {directory:string;protectedFiles:string[];expiresAt:number;providerHome?:string};
  },
): Promise<{
  binary: string;
  args: string[];
  env: Record<string, string>;
  transport?: "pipe";
  programIoPolicy?: ProgramIoPolicy;
}> {
  const executable = await resolveExecutable(c.binary),
    readonly = isReadOnly(node.type);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => typeof v[1] === "string",
    ),
  );
  // Windows names are case-insensitive but this copy is a plain object: a parent
  // "Path" would otherwise leave env.PATH unset and hand the child two spellings.
  const pathKeys = Object.keys(env).filter((key) =>
    process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH",
  );
  const inheritedPath = pathKeys.map((key) => env[key]).find(Boolean) ?? "";
  for (const key of pathKeys) delete env[key];
  env.PATH = [path.dirname(process.execPath), inheritedPath]
    .filter(Boolean)
    .join(path.delimiter);
  let args: string[];
  let programIo:ProgramIoPolicy|undefined;
  if(c.type==="kilo"&&opts.programIoGuard){
    if(!opts.scopeRoots?.length)throw Error(`${IO_UNAVAILABLE} Program isolation requires the native target boundary guard.`);
    if(opts.allowedPaths.length)throw Error(`${IO_UNAVAILABLE} Strict program isolation requires a single target project.`);
    for(const name of ["kilo.json","kilo.jsonc","opencode.json","opencode.jsonc"])
      if(fs.existsSync(path.join("/Library/Application Support/kilo",name)))throw Error(`${IO_UNAVAILABLE} Managed native tool configuration requires a supported isolated integration.`);
    programIo=prepareProgramIo({cwd:opts.cwd,directory:opts.programIoGuard.directory,testRole:node.type==="test",readOnly:readonly,protectedFiles:opts.programIoGuard.protectedFiles,expiresAt:opts.programIoGuard.expiresAt});
    // Provider credentials stay in the trusted control plane; project configs,
    // external plugins/MCP/LSP/formatters cannot create an unconfined tool host.
    env.XDG_DATA_HOME=env.XDG_DATA_HOME??path.join(os.homedir(),".local/share");
    // SDK/config dependencies are trusted host control-plane code. Reuse one
    // private home per session; commands in the VM never mount or inherit it.
    env.HOME=opts.programIoGuard.providerHome??path.join(programIo.directory,"provider-home");
    fs.mkdirSync(env.HOME,{recursive:true,mode:0o700});env.HOME=fs.realpathSync(env.HOME);
    if(env.HOME===programIo.cwd||env.HOME.startsWith(programIo.cwd+path.sep))throw Error(`${IO_UNAVAILABLE} Provider control home must be outside the untrusted project.`);
    env.XDG_CONFIG_HOME=path.join(env.HOME,".config");
    env.XDG_CACHE_HOME=path.join(env.HOME,".cache");
    env.XDG_STATE_HOME=path.join(env.HOME,".local/state");
    env.KILO_CONFIG_DIR=path.join(env.XDG_CONFIG_HOME,"kilo");
    env.KILO_DISABLE_PROJECT_CONFIG="true";env.KILO_DISABLE_EXTERNAL_SKILLS="true";env.KILO_DISABLE_SKILL_SHELL="true";env.KILO_DISABLE_AUTOUPDATE="true";env.KILO_DISABLE_LSP_DOWNLOAD="true";
    env.KILO_DISABLE_DEFAULT_PLUGINS="true";env.KILO_DISABLE_CODEBASE_INDEXING="true";env.KILO_DISABLE_FFF="true";env.KILO_DISABLE_CLAUDE_CODE="true";env.KILO_DISABLE_CLAUDE_CODE_PROMPT="true";env.KILO_DISABLE_CLAUDE_CODE_SKILLS="true";
    env.SHELL="/bin/sh";env.ENV="/dev/null";env.BASH_ENV="/dev/null";
    for(const key of Object.keys(env))if(/^(?:NODE_OPTIONS|NODE_PATH|KILO_CONFIG|OPENCODE_CONFIG|KILO_PURE|DYLD_.*|LD_.*)$/.test(key))delete env[key];
    for(const name of ["NODE_OPTIONS","NODE_PATH","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH","LD_PRELOAD","LD_LIBRARY_PATH"])env[name]="";
    env.GIT_DIR="/dev/null";env.GIT_WORK_TREE=opts.cwd;env.GIT_CONFIG_GLOBAL="/dev/null";env.GIT_CONFIG_NOSYSTEM="1";env.GIT_OPTIONAL_LOCKS="0";
    fs.mkdirSync(env.KILO_CONFIG_DIR,{recursive:true,mode:0o700});
    env.AGENT_GRAPH_PROGRAM_IO=JSON.stringify(programIo);
  }
  if (c.type === "codex") {
    args = [
      "exec",
      "--json",
      "--model",
      b.modelId,
      "--skip-git-repo-check",
      "--sandbox",
      readonly
        ? "read-only"
        : opts.fullAccess
          ? "danger-full-access"
          : "workspace-write",
      "-c",
      "allow_login_shell=false",
      "-c",
      `shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`,
    ];
    if (opts.nativeApprovalReview && !readonly && !opts.fullAccess) {
      // Native reviewer authorizes individual commands; --approve-for-me already selects workspace-write.
      args.splice(args.indexOf("--sandbox"), 2);
      args.splice(1, 0, "--approve-for-me");
    }
    if (opts.localHttpAccess && !readonly && !opts.fullAccess) {
      // Unknown CLIs must not silently ignore the proxy while enabling the
      // legacy network_access flag. Revalidate this adapter before widening.
      try {
        const {stdout}=await execute(executable.file,[...executable.prefix,"--version"],{cwd:opts.cwd,env,timeout:5000,maxBuffer:32768,windowsHide:true});
        if(stdout.trim()!=="codex-cli 0.162.1")throw Error();
      }catch{throw Error(`${IO_UNAVAILABLE} The scoped local HTTP adapter requires verified codex-cli 0.162.1; no model invocation was started. Revalidate the proxy before using another CLI version.`);}
      // Invocation-local command networking: local test servers only. The
      // proxy and explicit destinations must accompany network_access=true.
      args.push("-c", "sandbox_workspace_write.network_access=true",
        "-c", "features.network_proxy.enabled=true",
        "-c", 'features.network_proxy.domains={"localhost"="allow","127.0.0.1"="allow","::1"="allow"}',
        "-c", "features.network_proxy.allow_local_binding=true");
    }
    for (const dir of opts.allowedPaths) args.push("--add-dir", dir);
    if (b.variant)
      args.push("-c", `model_reasoning_effort=${JSON.stringify(b.variant)}`);
    if (opts.resumeId) args.push("resume", opts.resumeId);
    args.push(opts.prompt+(opts.localHttpAccess&&opts.nativeApprovalReview&&!readonly&&!opts.fullAccess
      ? "\nNative local-test networking is enabled through a proxy restricted to localhost/127.0.0.1/::1. Keep commands sandboxed. If a required registered Chromium verifier is blocked specifically by macOS Mach/bootstrap browser-launch permissions, use native automatic approval review for that EXACT foreground verifier command and explain the local headless browser requirement. This is automatic CLI review, not a human approval request. Never use danger-full-access startup flags, change global settings or approve arbitrary commands. If that review is denied, stop with BLOCKED_KIND: external and VERDICT: BLOCKED; do not bypass or rephrase the denied action."
      : ""));
  } else if (c.type === "claude") {
    args = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      b.modelId,
    ];
    if (readonly)
      args.push("--disallowedTools", "Edit,Write,NotebookEdit,Bash");
    else if (opts.fullAccess) args.push("--dangerously-skip-permissions");
    for (const dir of opts.allowedPaths) args.push("--add-dir", dir);
    if (b.variant) args.push("--effort", b.variant);
    if (opts.resumeId) args.push("--resume", opts.resumeId);
  } else {
    args = ["run", "--format", "json", "--model", b.modelId, "--dir", opts.cwd];
    // Kilo emits no JSON until the model starts a step. Bootstrap/provider
    // logs must be enabled before the subcommand to distinguish a live CLI
    // waiting on capacity from a broken initial transport.
    if (c.type === "kilo") args.unshift("--print-logs", "--log-level", "INFO");
    if (b.variant) args.push("--variant", b.variant);
    if (opts.resumeId) args.push("--session", opts.resumeId);
    if (opts.fullAccess && !readonly) args.push("--auto");
    // Only role/access restrictions belong to the orchestrator. Native tools,
    // MCP, web, plugins, skills and hooks retain their CLI configuration.
    const permission: Record<string, unknown> = {
      edit: readonly ? "deny" : "allow",
    };
    if (readonly) permission.bash = programIo?"allow":"deny";
    if(programIo){permission["*"]="deny";permission.bash="allow";permission.todowrite="allow";permission.edit="deny";}
    if (opts.allowedPaths.length)
      permission.external_directory = Object.fromEntries(
        opts.allowedPaths.map((p) => [
          `${p.replace(/\\/g, "/").replace(/\/$/, "")}/**`,
          "allow",
        ]),
      );
    if(c.type==="kilo"&&opts.scopeRoots)permission.external_directory={"*":"deny",...Object.fromEntries(opts.scopeRoots.flatMap(p=>{const root=p.replace(/\\/g,"/").replace(/\/$/,"");return[[root,"allow"],[`${root}/**`,"allow"]];}))};
    const key =
      c.type === "kilo" ? "KILO_CONFIG_CONTENT" : "OPENCODE_CONFIG_CONTENT";
    let native = env[key]
      ? (JSON.parse(env[key]) as Record<string, unknown>)
      : {};
    if(programIo)native=Object.fromEntries(Object.entries(native).filter(([name])=>["provider","model","small_model","enabled_providers","disabled_providers"].includes(name)));
    delete env.AGENT_GRAPH_KILO_CHECKS;
    const guardedChecks = c.type === "kilo" && (programIo||(!readonly&&(opts.verificationCommands?.length||opts.guardOwnedProcesses))||opts.scopeRoots?.length);
    if (guardedChecks) env.AGENT_GRAPH_KILO_CHECKS = JSON.stringify({cwd: opts.cwd, commands: readonly?[]:opts.verificationCommands??[],...(opts.testSourcesReadOnly?{testSourcesReadOnly:true}:{}),...(opts.guardOwnedProcesses?{guardOwnedProcesses:true}:{}),...(opts.verificationAliases?{aliases:opts.verificationAliases}:{}),...(opts.scopeRoots?{scopeRoots:opts.scopeRoots}:{}),...(programIo?{programIo,readOnlyRole:readonly}:{})});
    const recoveryAgents: Record<string, {tools?: Record<string, unknown>}> = Object.create(null);
    if (c.type === "kilo" && !readonly && opts.disableWrite) {
      // Kilo resolves effective agents before plugin config hooks; write=false
      // must be part of the invocation config, not a later hook mutation.
      const names = await kiloRecoveryAgents(executable.file, executable.prefix, opts.cwd, env);
      const nativeAgents = (native.agent as typeof recoveryAgents | undefined) ?? {};
      for (const name of names) recoveryAgents[name] = {
        ...nativeAgents[name], tools: {...nativeAgents[name]?.tools, write: false},
      };
    }
    env[key] = JSON.stringify({
      ...native,
      ...(programIo?{snapshot:false,lsp:false,formatter:false,mcp:{},tools:{"*":false,bash:true,todowrite:true,read:false,glob:false,grep:false,write:false,edit:false,apply_patch:false,task:false,skill:false}}:{}),
      ...(Object.keys(recoveryAgents).length ? {agent: {
        ...((native.agent as Record<string, unknown>) ?? {}), ...recoveryAgents,
      }} : {}),
      ...(guardedChecks ? {plugin: [
        ...(Array.isArray(native.plugin) ? native.plugin : []),
        pathToFileURL(path.join(__dirname, "kilo_protocol_plugin.js")).href,
      ]} : {}),
      ...(c.type === "kilo" && !readonly && opts.disableWrite ? {tools: {
        ...((native.tools as Record<string, unknown>) ?? {}), write: false,
      }} : {}),
      permission: {
        ...((native.permission as Record<string, unknown>) ?? {}),
        ...permission,
      },
    });
    const protocol =
      c.type !== "kilo"
        ? ""
        : "\n\nNative tool protocol: use the exact schema supplied by this CLI. Never send an empty tool input. After a schema error, correct the missing fields before trying again; do not repeat the same invalid call. " +
          (programIo
            ? `Kernel-isolated tool protocol: commands execute in a Linux VM with Node 24 and preinstalled Chromium/Playwright, regardless of the provider CLI host platform. Each bash command gets a fresh VM, destroyed before its result is accepted. Start, use and close any server in the same foreground check; no background server or PID survives to a later call. Use bash(command, description) for ALL project file operations. Native read/glob/grep/write/edit/task/skill/MCP tools are disabled. Use target-relative paths, shell cat/ls/grep for inspection and small quoted heredocs for implementation writes. ${readonly?"This role is READ ONLY: only inspection commands (cat/ls/head/tail/sed/grep) are permitted; do not execute tests, Node programs, mkdir or writes.":opts.testSourcesReadOnly?"Test role: exact registered foreground checks, inspection and verification output preparation only. Never edit product/tests/config; return FAIL on a failure.":"Implementation owns all product and authored-test repairs."} Review/approval must read each own test file and the canonical quality report using standalone cat commands. The VM confines every command and its children; HOME/cache/temp are private under verification/.agent-io. Host network, home, sockets and credentials are unavailable. Never use /tmp output paths, host credentials/configuration or unregistered execution tools. Emit AGENT_REPORT only in final assistant text.`
            : readonly
            ? "Use only permitted read-only tools: read(filePath), glob(pattern), grep(pattern) to inspect target files and prior actual test evidence. exec, exec_command, execute, bash, write and edit are unavailable in this read-only role; never call them or request shell/write permissions. For planning, use the supplied browser command/schema contract without reading the platform implementation."
            : "Use bash with command (string) and description (string) for shell commands, never exec or exec_command. " +
              (opts.disableWrite
                ? "The write tool is disabled in this attempt after observed schema failures; Kilo also excludes its shared native edit group. Do not call write/edit or invent content for a failed empty call. Use permitted bash commands with small, safely quoted heredocs to create or update files; preserve frozen acceptance files. "
                : "The write tool requires both filePath (absolute path) and content (string). Keep each write small; never send {}. ") +
              (opts.testSourcesReadOnly ? "This test role cannot edit ANY source, tests, package or configuration. Execute exact registered checks and inspect via read/glob/grep or read-only shell commands. On first failure report FAIL with concrete diagnostics; implementation owns every repair. " : "Preserve existing tests and use bash to run them before deciding whether additional coverage is necessary. ") +
              (process.platform === "win32"
                ? "The tool shell is Windows PowerShell: use npm.cmd and npx.cmd to avoid npm.ps1 execution policy errors, or invoke node.exe directly. Use PowerShell syntax, not Bash for/do/done loops or &&. Do not change the host execution policy."
                : ""));
    args.push(opts.prompt + protocol);
    if(c.type==="kilo"&&opts.scopeRoots)args[args.length-1]+=`\nTarget scope: native filesystem tools may inspect only these approved roots: ${JSON.stringify(opts.scopeRoots)}. Default glob/grep path is the target project. Never inspect parent directories, global configuration, credentials or orchestrator sessions. A scope denial happened before execution; correct the path and continue using target-relative files. Registered platform verifiers may be executed as supplied; do not read/search their installation. Emit AGENT_REPORT directly in the final assistant response, never write AGENT_REPORT.json in read-only/test roles.`;
  }
  return {
    binary: executable.file,
    args: [...executable.prefix, ...args],
    env,
    ...(programIo?{programIoPolicy:programIo}:{}),
    ...(c.type === "kilo" && process.platform === "win32"
      ? { transport: "pipe" as const }
      : {}),
  };
}
