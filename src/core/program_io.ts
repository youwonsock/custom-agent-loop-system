import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { literalShellWords } from "./verification_evidence";
import { preExecutionDenied } from "./event_evidence";
import type { ProgramIoAudit, SessionState } from "../shared/domain";
import {
  VmPolicy,
  prepareVmPolicy,
  vmCommandArguments,
  removeVm,
  cleanupPolicyVms,
  containerHostEnvironment,
} from "./program_io_vm";

export const IO_UNAVAILABLE = "[AGENT_GRAPH_IO_UNAVAILABLE]";
export const IO_VIOLATION = "[AGENT_GRAPH_IO_VIOLATION]";
export const IO_DENIED = "[AGENT_GRAPH_IO_DENIED]";
export interface ProgramIoPolicy {
  version: 1;
  id: string;
  cwd: string;
  directory: string;
  node: string;
  runner: string;
  bootstrap: string;
  profile: string;
  profileDigest: string;
  publicKey: string;
  privateKey: string;
  expiresAt: number;
  writableRoots: string[];
  runtimeReadRoots: string[];
  scratch: string;
  preflightPassed: boolean;
  browserPath: string;
  backend: "macos-seatbelt" | "apple-container-vm";
  vm?: VmPolicy;
}
type Obj = Record<string, unknown>;
export type ProgramIoCommandPolicy = Pick<
  ProgramIoPolicy,
  "id" | "node" | "runner" | "publicKey"
>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
export const ioDigest = (v: string | Buffer): string =>
  createHash("sha256").update(v).digest("hex");
const quote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
const key = <T extends "pkcs8" | "spki">(data: string, type: T) => ({
  key: Buffer.from(data, "base64"),
  format: "der" as const,
  type,
});
export function ioSign(value: unknown, policy: ProgramIoPolicy): string {
  return sign(
    null,
    Buffer.from(JSON.stringify(value)),
    key(policy.privateKey, "pkcs8"),
  ).toString("base64url");
}
export function ioVerify(
  value: unknown,
  signature: unknown,
  policy: Pick<ProgramIoPolicy, "publicKey">,
): boolean {
  try {
    return (
      typeof signature === "string" &&
      verify(
        null,
        Buffer.from(JSON.stringify(value)),
        key(policy.publicKey, "spki"),
        Buffer.from(signature, "base64url"),
      )
    );
  } catch {
    return false;
  }
}
export function wrapProgramCommand(
  command: string,
  policy: ProgramIoPolicy,
  nativeCommand = command,
): string {
  const payload = {
    version: 1,
    policyId: policy.id,
    id: randomUUID(),
    command,
    nativeCommand,
  };
  return [
    policy.node,
    policy.runner,
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ioSign(payload, policy),
  ]
    .map(quote)
    .join(" ");
}
export function readProgramAuthorization(
  payload: string,
  signature: unknown,
  policy: ProgramIoCommandPolicy,
): { id: string; command: string; nativeCommand: string } | null {
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      data.version !== 1 ||
      data.policyId !== policy.id ||
      typeof data.id !== "string" ||
      typeof data.command !== "string" ||
      !ioVerify(data, signature, policy)
    )
      return null;
    return {
      id: data.id,
      command: data.command,
      nativeCommand:
        typeof data.nativeCommand === "string"
          ? data.nativeCommand
          : data.command,
    };
  } catch {
    return null;
  }
}
export function unwrapProgramCommand(
  command: string,
  policy: ProgramIoCommandPolicy,
): { id: string; command: string; nativeCommand: string } | null {
  try {
    const words = literalShellWords(command);
    if (
      words?.length !== 4 ||
      words[0] !== policy.node ||
      words[1] !== policy.runner
    )
      return null;
    return readProgramAuthorization(words[2]!, words[3], policy);
  } catch {
    return null;
  }
}
export function programCommandProof(
  command: string,
  policy: ProgramIoCommandPolicy,
): { payload: string; signature: string } | null {
  const words = literalShellWords(command);
  return unwrapProgramCommand(command, policy) && words
    ? { payload: words[2]!, signature: words[3]! }
    : null;
}
export function programProofAuthorization(
  proof: unknown,
  policy: ProgramIoCommandPolicy,
): ReturnType<typeof readProgramAuthorization> {
  const value = obj(proof);
  return typeof value.payload === "string"
    ? readProgramAuthorization(value.payload, value.signature, policy)
    : typeof value.wrappedCommand === "string"
      ? unwrapProgramCommand(value.wrappedCommand, policy)
      : null;
}
/** Only public keys from this controller-owned visit, never project/home scans. */
export function programPromptPolicies(
  policy: ProgramIoPolicy,
): ProgramIoCommandPolicy[] {
  const policies: ProgramIoCommandPolicy[] = [policy],
    parent = path.dirname(policy.directory);
  for (const entry of fs
    .readdirSync(parent, { withFileTypes: true })
    .slice(0, 100)) {
    if (!entry.isDirectory() || !/^[-a-f0-9]{36}-io$/.test(entry.name))
      continue;
    try {
      const file = path.join(parent, entry.name, "policy.json");
      if (fs.statSync(file).size > 65536) continue;
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        p.preflightPassed &&
        p.node === policy.node &&
        p.runner === policy.runner &&
        typeof p.id === "string" &&
        typeof p.publicKey === "string" &&
        !policies.some((x) => x.id === p.id)
      )
        policies.push({
          id: p.id,
          node: p.node,
          runner: p.runner,
          publicKey: p.publicKey,
        });
    } catch {
      /* An incomplete setup never authorizes history normalization. */
    }
  }
  return policies;
}

/** Read-only operating-system/runtime resources, never home/config/session trees. */
export function discoverIoRuntimeRoots(): string[] {
  const roots = [
    path.dirname(path.dirname(fs.realpathSync(process.execPath))),
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname, "../../../package.json"),
  ];
  const req = createRequire(__filename);
  for (const name of ["playwright", "playwright-core", "fastify", "node-pty"]) {
    try {
      let p = req.resolve(name);
      while (
        path.dirname(p) !== p &&
        !fs.existsSync(path.join(p, "package.json"))
      )
        p = path.dirname(p);
      roots.push(p);
      // The installed platform's dependencies are immutable runtime code.
      const at = p.lastIndexOf(`${path.sep}node_modules${path.sep}`);
      if (at >= 0) roots.push(p.slice(0, at) + path.sep + "node_modules");
    } catch {
      /* Optional browser/runtime resources are not expanded to home. */
    }
  }
  try {
    const pw = req("playwright") as { chromium: { executablePath(): string } };
    let browser = fs.realpathSync(pw.chromium.executablePath());
    const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
    if (browser.startsWith(cache + path.sep))
      roots.push(path.dirname(cache) + "/ms-playwright");
    else roots.push(path.dirname(path.dirname(browser)));
  } catch {
    /* Browser installation is checked by the verifier itself. */
  }
  return [
    ...new Set(
      roots.filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p)),
    ),
  ];
}
export function seatbeltProfile(
  cwd: string,
  writable: string[],
  runtime: string[],
  protectedFiles: string[] = [],
): string {
  const q = (s: string) => JSON.stringify(s),
    lines = [
      "(version 1)",
      "(deny default)",
      "(allow process-exec process-fork)",
      "(allow signal (target same-sandbox))",
      "(allow process-info* (target same-sandbox))",
      '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osversion") (sysctl-name "kern.osproductversion") (sysctl-name "kern.version") (sysctl-name "kern.argmax") (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc"))',
      '(allow system-mac-syscall (mac-policy-name "vnguard"))',
      '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
      '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.secinitd"))',
      '(allow mach-register mach-lookup (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))',
      '(allow mach-lookup (global-name "com.apple.PowerManagement.control"))',
      // macOS getcwd requires this literal root permission, not a root subpath.
      '(allow file-read* file-test-existence (literal "/"))',
      '(allow file-read-metadata file-test-existence (path-ancestors "/System/Volumes/Data/private"))',
      '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/zero"))',
      '(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))',
      '(allow file-read-metadata (literal "/dev") (literal "/var") (literal "/tmp") (literal "/etc"))',
      '(allow file-read* (literal "/private/var/select/sh"))',
      '(allow file-read-metadata (literal "/private/var/select"))',
      '(allow sysctl-read (sysctl-name "machdep.cpu.brand_string"))',
      '(allow file-read-data file-write-data (regex #"^/dev/fd/[012]$"))',
      '(allow network-bind (local tcp "localhost:*"))',
      '(allow network-inbound (local tcp "localhost:*"))',
      '(allow network-outbound (remote tcp "localhost:*"))',
    ];
  const readonly = [
    cwd,
    ...runtime,
    "/System",
    "/bin",
    "/usr/bin",
    "/usr/lib",
    "/usr/share",
  ];
  for (const root of readonly)
    lines.push(
      `(allow file-read* file-test-existence file-map-executable (subpath ${q(root)}))`,
    );
  const ancestors = new Set<string>();
  for (const root of readonly) {
    let p = root;
    while (path.dirname(p) !== p) {
      ancestors.add(p);
      p = path.dirname(p);
    }
  }
  for (const p of ancestors)
    lines.push(
      `(allow file-read-metadata file-test-existence (literal ${q(p)}))`,
    );
  for (const root of writable)
    lines.push(`(allow file-write* (subpath ${q(root)}))`);
  for (const file of protectedFiles)
    lines.push(`(deny file-write* (subpath ${q(file)}))`);
  return lines.join("\n") + "\n";
}

export function prepareProgramIo(options: {
  cwd: string;
  directory: string;
  testRole: boolean;
  readOnly: boolean;
  protectedFiles?: string[];
  expiresAt?: number;
  backend?: "macos-seatbelt" | "apple-container-vm";
}): ProgramIoPolicy {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec"))
    throw Error(
      `${IO_UNAVAILABLE} Kernel program I/O isolation is not supported on this host; refusing unsandboxed execution.`,
    );
  const cwd = fs.realpathSync(options.cwd),
    requested = path.resolve(options.directory);
  if (fs.existsSync(requested) && fs.readdirSync(requested).length)
    throw Error(
      `${IO_UNAVAILABLE} Refusing to overwrite an existing broker audit directory.`,
    );
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  const directory = fs.realpathSync(requested);
  if (directory === cwd || directory.startsWith(cwd + path.sep))
    throw Error(
      `${IO_UNAVAILABLE} The broker/audit directory must be outside untrusted project writes.`,
    );
  const id = randomUUID(),
    scratch = path.join(cwd, "verification", ".agent-io", id),
    runtimeReadRoots = discoverIoRuntimeRoots();
  if (
    cwd === path.parse(cwd).root ||
    runtimeReadRoots.some(
      (root) => root === cwd || root.startsWith(cwd + path.sep),
    )
  )
    throw Error(
      `${IO_UNAVAILABLE} The project must be disjoint from the trusted runtime installation.`,
    );
  if (
    runtimeReadRoots.some(
      (root) => root === path.parse(root).root || root === os.homedir(),
    )
  )
    throw Error(`${IO_UNAVAILABLE} A runtime read root is too broad.`);
  const writableRoots = options.readOnly
    ? [scratch]
    : options.testRole
      ? [path.join(cwd, "verification")]
      : [cwd];
  let profile = seatbeltProfile(
    cwd,
    writableRoots,
    runtimeReadRoots,
    (options.protectedFiles ?? []).map((f) => path.resolve(cwd, f)),
  );
  if (options.readOnly)
    for (const dir of [
      path.join(cwd, "verification"),
      path.join(cwd, "verification/.agent-io"),
    ])
      profile += `(allow file-write-create (require-all (literal ${JSON.stringify(dir)}) (vnode-type DIRECTORY)))\n`;
  const backend = options.backend ?? "apple-container-vm";
  const keys = generateKeyPairSync("ed25519"),
    policy: ProgramIoPolicy = {
      version: 1,
      id,
      cwd,
      directory,
      node: fs.realpathSync(process.execPath),
      runner: path.join(__dirname, "program_io_runner.js"),
      bootstrap: path.join(__dirname, "program_io_bootstrap.js"),
      profile,
      profileDigest: ioDigest(profile),
      publicKey: keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      privateKey: keys.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
      expiresAt: options.expiresAt ?? Date.now() + 3600000,
      writableRoots,
      runtimeReadRoots,
      scratch,
      preflightPassed: false,
      browserPath:
        process.env.PLAYWRIGHT_BROWSERS_PATH ??
        path.join(os.homedir(), "Library/Caches/ms-playwright"),
      backend,
    };
  if (backend === "apple-container-vm") {
    try {
      policy.vm = prepareVmPolicy(
        directory,
        cwd,
        options.readOnly
          ? "readonly"
          : options.testRole
            ? "test"
            : "implementation",
        options.protectedFiles ?? [],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Error(
        message.startsWith(IO_UNAVAILABLE)
          ? message
          : `${IO_UNAVAILABLE} ${message}`,
      );
    }
    policy.browserPath = "/ms-playwright";
    policy.runtimeReadRoots = [policy.vm.distRoot, policy.vm.manifestRoot];
    policy.profile = JSON.stringify({
      version: 1,
      backend,
      vm: policy.vm,
      target: cwd,
      network: "none",
      rootReadOnly: true,
      capabilities: [],
      scratch,
    });
    policy.profileDigest = ioDigest(policy.profile);
  }
  fs.writeFileSync(path.join(directory, "profile.sb"), policy.profile, {
    mode: 0o600,
  });
  const canary = path.join(directory, "outside-canary.txt");
  fs.writeFileSync(canary, "protected-broker-canary");
  const denied =
    backend === "apple-container-vm"
      ? "['EPERM','EACCES','ENOENT'].includes(e.code)"
      : "['EPERM','EACCES'].includes(e.code)";
  const code = `const f=require('node:fs'),c=require('node:child_process'),p=${JSON.stringify(canary)};let n=0;for(const fn of [()=>f.readFileSync(p),()=>f.writeFileSync(p,'escape'),()=>f.readdirSync(${JSON.stringify(directory)}),()=>f.statSync(p)]){try{fn()}catch(e){if(${denied})n++}}const child=c.spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync(process.argv[1]);process.exit(9)}catch(e){process.exit(${denied}?0:8)}",p],{stdio:'pipe'});if(n!==4||child.status!==0)process.exit(7);${backend === "apple-container-vm" ? "if(Object.keys(require('node:os').networkInterfaces()).some(n=>n!=='lo'))process.exit(6);" : ""}console.log('AGENT_GRAPH_KERNEL_PREFLIGHT_OK');`;
  const name = `agio-preflight-${id}`,
    inner = {
      command: `node -e ${quote(code)}`,
      scratch: path.join(scratch, "preflight"),
    };
  const probe = policy.vm
    ? spawnSync(
        policy.vm.binary,
        vmCommandArguments(
          policy.vm,
          cwd,
          scratch,
          policy.bootstrap,
          inner,
          name,
          programEnvironment(policy),
          id,
        ),
        {
          encoding: "utf8",
          timeout: 45000,
          maxBuffer: 65536,
          env: containerHostEnvironment(policy.vm),
        },
      )
    : spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, policy.node, "-e", code],
        {
          cwd,
          env: programEnvironment(policy),
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 65536,
        },
      );
  const removed = policy.vm ? removeVm(policy.vm, name) : true;
  policy.preflightPassed =
    removed &&
    probe.status === 0 &&
    probe.stdout.trim() === "AGENT_GRAPH_KERNEL_PREFLIGHT_OK" &&
    fs.readFileSync(canary, "utf8") === "protected-broker-canary";
  const publicPolicy = {
    ...policy,
    privateKey: undefined,
    profile: undefined,
    preflight: {
      status: probe.status,
      error: probe.error?.message ?? null,
      stdout: probe.stdout,
      stderr: probe.stderr,
    },
  };
  fs.writeFileSync(
    path.join(directory, "policy.json"),
    JSON.stringify(publicPolicy, null, 2),
  );
  if (!policy.preflightPassed)
    throw Error(
      `${IO_UNAVAILABLE} Kernel isolation preflight failed: ${probe.error?.message ?? probe.stderr ?? probe.status}`,
    );
  return policy;
}
export function programEnvironment(
  policy: ProgramIoPolicy,
  commandId = "preflight",
): Record<string, string> {
  const scratch = path.join(policy.scratch, commandId);
  return {
    PATH: [
      policy.vm ? "/usr/local/bin" : path.dirname(policy.node),
      "/usr/bin",
      "/bin",
    ].join(":"),
    HOME: path.join(scratch, "home"),
    TMPDIR: path.join(scratch, "tmp"),
    TMP: path.join(scratch, "tmp"),
    TEMP: path.join(scratch, "tmp"),
    SHELL: "/bin/sh",
    ENV: "/dev/null",
    BASH_ENV: "/dev/null",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    npm_config_cache: path.join(scratch, "npm-cache"),
    npm_config_update_notifier: "false",
    PLAYWRIGHT_BROWSERS_PATH: policy.browserPath,
    AGENT_GRAPH_IO_ACTIVE: policy.id,
  };
}

export class ProgramIoTracker {
  private readonly calls = new Map<string, { id: string; command: string }>();
  private unwrapped = 0;
  constructor(readonly policy: ProgramIoPolicy) {}
  normalize(event: Obj): Obj {
    const part = obj(event.part),
      state = obj(part.state),
      args = obj(state.input);
    if (
      event.type !== "tool_use" ||
      part.tool !== "bash" ||
      typeof args.command !== "string"
    )
      return event;
    const metadata = obj(state.metadata),
      proof = obj(metadata.agentGraphProgramIo);
    const direct = unwrapProgramCommand(args.command, this.policy);
    const recorded = programProofAuthorization(proof, this.policy);
    // Some CLI versions persist the original input before tool.execute.before.
    // The after hook supplies the same signed authorization, bound to that input.
    const command =
        direct ?? (recorded?.nativeCommand === args.command ? recorded : null),
      terminal = [
        "completed",
        "success",
        "error",
        "failed",
        "denied",
        "rejected",
      ].includes(String(state.status));
    if (terminal) {
      if (
        preExecutionDenied(state.error, state.metadata) ||
        ["denied", "rejected"].includes(String(state.status))
      )
        return command
          ? {
              ...event,
              part: {
                ...part,
                state: {
                  ...state,
                  input: { ...args, command: command.command },
                },
              },
            }
          : event;
      if (command) this.calls.set(command.id, command);
      else if (
        !preExecutionDenied(state.error, state.metadata) &&
        !["denied", "rejected"].includes(String(state.status))
      )
        this.unwrapped++;
    }
    return command
      ? {
          ...event,
          part: {
            ...part,
            state: { ...state, input: { ...args, command: command.command } },
          },
        }
      : event;
  }
  finish(): ProgramIoAudit {
    const audit: ProgramIoAudit = {
      version: 1,
      backend: this.policy.backend,
      policyId: this.policy.id,
      profileDigest: this.policy.profileDigest,
      cwd: this.policy.cwd,
      preflightPassed: this.policy.preflightPassed,
      nativeCommands: this.calls.size,
      completedCommands: 0,
      unwrappedCommands: this.unwrapped,
      unresolvedCommands: 0,
      invalidReceipts: 0,
      runtimeReadRoots: this.policy.runtimeReadRoots,
      commands: [],
    };
    const starts = new Map<string, Obj>(),
      ends = new Map<string, Obj>();
    try {
      // A crashed broker cannot sign completion. Clean its VM, but retain failure.
      if (this.policy.vm && cleanupPolicyVms(this.policy.vm, this.policy.id))
        audit.invalidReceipts++;
      const file = path.join(this.policy.directory, "receipts.jsonl");
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > 8 * 1024 * 1024)
          throw Error("receipt size limit");
        for (const line of fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)) {
          const record = JSON.parse(line),
            data = obj(record.data);
          if (
            !ioVerify(data, record.signature, this.policy) ||
            data.policyId !== this.policy.id ||
            data.profileDigest !== this.policy.profileDigest ||
            typeof data.id !== "string"
          )
            throw Error("invalid signed broker receipt");
          const map =
            data.type === "start" ? starts : data.type === "end" ? ends : null;
          if (!map || map.has(data.id))
            throw Error("duplicate/unknown broker receipt");
          map.set(data.id, data);
        }
      }
      for (const call of this.calls.values()) {
        const a = starts.get(call.id),
          b = ends.get(call.id);
        if (
          !a ||
          !b ||
          a.command !== call.command ||
          b.command !== call.command ||
          !Number.isInteger(b.exitCode) ||
          b.backend !== this.policy.backend ||
          b.processGroupStopped !== true ||
          (this.policy.vm && b.containerRemoved !== true)
        ) {
          audit.unresolvedCommands++;
          continue;
        }
        audit.completedCommands++;
        audit.commands.push({
          id: call.id,
          command: call.command,
          exitCode: b.exitCode as number,
          pid: a.pid as number,
          processGroupStopped: true,
          ...(this.policy.vm
            ? { containerRemoved: true, containerName: String(a.containerName) }
            : {}),
        });
      }
      if ([...starts.keys(), ...ends.keys()].some((id) => !this.calls.has(id)))
        audit.invalidReceipts++;
      if (
        ioDigest(
          fs.readFileSync(path.join(this.policy.directory, "profile.sb")),
        ) !== this.policy.profileDigest
      )
        audit.invalidReceipts++;
    } catch {
      audit.invalidReceipts++;
    }
    return audit;
  }
}
export function programIoEvidenceProblem(state: SessionState): string | null {
  if (!state.graph.automation?.programIoGuard) return null;
  for (const visit of state.visits)
    for (const attempt of visit.attempts) {
      const binding = state.bindings[visit.nodeId],
        kilo =
          state.connections.find((c) => c.id === binding?.connectionId)
            ?.type === "kilo",
        a = attempt.programIoAudit;
      if (!kilo && !a) continue;
      let root = state.targetProjectPath;
      try {
        root = fs.realpathSync(root);
      } catch {}
      if (
        !a ||
        a.version !== 1 ||
        a.backend !== "apple-container-vm" ||
        a.cwd !== root ||
        !a.preflightPassed ||
        typeof a.policyId !== "string" ||
        !a.policyId ||
        !/^[a-f0-9]{64}$/.test(a.profileDigest) ||
        !Array.isArray(a.runtimeReadRoots) ||
        !Array.isArray(a.commands) ||
        a.commands.length !== a.completedCommands ||
        a.commands.some(
          (c) =>
            !c.processGroupStopped ||
            !c.containerRemoved ||
            !Number.isInteger(c.exitCode) ||
            !Number.isSafeInteger(c.pid) ||
            c.pid <= 0,
        ) ||
        ![
          a.nativeCommands,
          a.completedCommands,
          a.unwrappedCommands,
          a.unresolvedCommands,
          a.invalidReceipts,
        ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        a.nativeCommands !== a.completedCommands ||
        a.unwrappedCommands ||
        a.unresolvedCommands ||
        a.invalidReceipts
      )
        return "프로그램 I/O 커널 격리 증거가 누락됐거나 우회·미완료 실행이 있습니다.";
    }
  return null;
}
