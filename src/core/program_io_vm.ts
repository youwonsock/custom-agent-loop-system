import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const unavailable = (message: string): Error =>
  Error(`[AGENT_GRAPH_IO_UNAVAILABLE] ${message}`);
export interface VmRuntime {
  binary: string;
  image: string;
  imageDigest: string;
  lockDigest: string;
  controlHome?: string;
}
export interface VmPolicy extends VmRuntime {
  runtimeRoot: string;
  distRoot: string;
  manifestRoot: string;
  mode: "implementation" | "test" | "readonly";
  protectedFiles: string[];
  uid: number;
  gid: number;
}
const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export function containerHostEnvironment(
  vm: Pick<VmRuntime, "controlHome"> = {},
): Record<string, string> {
  return {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: vm.controlHome ?? os.homedir(),
    LANG: "en_US.UTF-8",
  };
}
export function vmRuntimeFile(): string {
  return (
    process.env.AGENT_GRAPH_IO_VM_RUNTIME ??
    path.join(os.homedir(), ".cache/agent-graph/program-io/runtime.json")
  );
}
export function vmRuntimeAvailable(): boolean {
  return (
    fs.existsSync(vmRuntimeFile()) &&
    fs.existsSync("/opt/homebrew/bin/container")
  );
}
function cli(binary: string, args: string[], timeout = 15000, home?: string) {
  const p = spawnSync(binary, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: containerHostEnvironment({ controlHome: home }),
  });
  if (p.status !== 0)
    throw unavailable(
      `Container runtime ${args[0]} failed: ${p.error?.message ?? p.stderr.slice(-2000)}`,
    );
  return p.stdout;
}
export function imageDigest(
  binary: string,
  image: string,
  home?: string,
): string {
  const data = JSON.parse(
    cli(binary, ["image", "inspect", image], 15000, home),
  );
  const item = Array.isArray(data) ? data[0] : data;
  const digest =
    item?.configuration?.descriptor?.digest ??
    item?.index?.digest ??
    item?.descriptor?.digest;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest))
    throw unavailable("Container image identity is unavailable.");
  return digest;
}
export function prepareVmPolicy(
  directory: string,
  cwd: string,
  mode: VmPolicy["mode"],
  protectedFiles: string[],
): VmPolicy {
  const value = JSON.parse(
    fs.readFileSync(vmRuntimeFile(), "utf8"),
  ) as VmRuntime;
  if (
    value.binary !== "/opt/homebrew/bin/container" ||
    typeof value.image !== "string" ||
    !value.image ||
    !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest)
  )
    throw unavailable("Invalid isolated runtime descriptor.");
  if (!/\b1\.6\.0\b/.test(cli(value.binary, ["--version"])))
    throw unavailable(
      "Unsupported container CLI version; this adapter is verified with 1.6.0.",
    );
  const status = spawnSync(value.binary, ["system", "status"], {
    encoding: "utf8",
    timeout: 10000,
    env: containerHostEnvironment(),
  });
  if (status.status !== 0)
    cli(value.binary, ["system", "start", "--disable-kernel-install"], 30000);
  const distRoot = path.resolve(__dirname, "../.."),
    runtimeRoot = path.dirname(distRoot),
    metadata = JSON.parse(
      fs.readFileSync(
        path.join(distRoot, "program_io_dependencies.json"),
        "utf8",
      ),
    );
  if (value.lockDigest !== metadata.lockDigest)
    throw unavailable(
      "Isolated runtime dependencies differ from this package lock; prepare the runtime again.",
    );
  if (imageDigest(value.binary, value.image) !== value.imageDigest)
    throw unavailable("Isolated runtime image identity changed.");
  const manifestRoot = path.join(directory, "runtime-manifest");
  fs.mkdirSync(manifestRoot, { mode: 0o700 });
  fs.copyFileSync(
    path.join(runtimeRoot, "package.json"),
    path.join(manifestRoot, "package.json"),
  );
  fs.mkdirSync(path.join(manifestRoot, "dist"));
  fs.symlinkSync(
    "/opt/agent-runtime/node_modules",
    path.join(manifestRoot, "node_modules"),
  );
  for (const p of [cwd, runtimeRoot, distRoot, manifestRoot])
    if (/[,\0\r\n]/.test(p))
      throw unavailable("A mount path contains unsafe separators.");
  if (
    cwd === "/opt/agent-runtime" ||
    cwd.startsWith("/opt/agent-runtime/") ||
    "/opt/agent-runtime".startsWith(cwd + path.sep)
  )
    throw unavailable(
      "The project collides with the isolated runtime namespace.",
    );
  return {
    ...value,
    controlHome: os.homedir(),
    runtimeRoot,
    distRoot,
    manifestRoot,
    mode,
    protectedFiles,
    uid: process.getuid!(),
    gid: process.getgid!(),
  };
}
export function projectDirectory(root: string, name: string): string {
  const destination = path.resolve(root, name),
    relative = path.relative(root, destination);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw unavailable("Invalid project scratch path.");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const real = fs.realpathSync(current),
      r = path.relative(root, real);
    if (r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r))
      throw unavailable("Project output symlink leaves the target.");
  }
  return fs.realpathSync(destination);
}
export function vmCommandArguments(
  vm: VmPolicy,
  cwd: string,
  scratch: string,
  bootstrap: string,
  inner: unknown,
  name: string,
  environment: Record<string, string>,
  policyId: string,
): string[] {
  const args = [
    "run",
    "--name",
    name,
    "--label",
    `agent.graph.policy=${policyId}`,
    "--network",
    "none",
    "--no-dns",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--uid",
    String(vm.uid),
    "--gid",
    String(vm.gid),
    "--cpus",
    "2",
    "--memory",
    "2G",
    "--shm-size",
    "256M",
    "--workdir",
    cwd,
    "--progress",
    "none",
  ];
  const mount = (source: string, target: string, readonly: boolean) =>
    args.push(
      "--mount",
      `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`,
    );
  mount(vm.manifestRoot, vm.runtimeRoot, true);
  mount(vm.distRoot, path.join(vm.runtimeRoot, "dist"), true);
  mount(cwd, cwd, vm.mode !== "implementation");
  if (vm.mode === "test")
    mount(
      projectDirectory(cwd, "verification"),
      path.join(cwd, "verification"),
      false,
    );
  else if (vm.mode === "readonly")
    mount(projectDirectory(cwd, path.relative(cwd, scratch)), scratch, false);
  if (vm.mode === "implementation")
    for (const file of vm.protectedFiles) {
      const p = path.resolve(cwd, file);
      if (fs.existsSync(p)) args.push("--read-only-path", p);
    }
  for (const [k, v] of Object.entries(environment))
    args.push("--env", `${k}=${v}`);
  args.push(
    vm.image,
    "/usr/local/bin/node",
    bootstrap,
    Buffer.from(JSON.stringify(inner)).toString("base64url"),
  );
  return args;
}
export function removeVm(vm: VmRuntime, name: string): boolean {
  const removed = spawnSync(vm.binary, ["delete", "--force", name], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
    env: containerHostEnvironment(vm),
  });
  if (
    removed.status !== 0 &&
    !/notfound|not found|does not exist/i.test(removed.stderr)
  )
    return false;
  try {
    const all = JSON.parse(
      cli(
        vm.binary,
        ["list", "--all", "--format", "json"],
        15000,
        vm.controlHome,
      ),
    );
    return (
      Array.isArray(all) &&
      !all.some(
        (item: { id?: string; configuration?: { id?: string } }) =>
          item.id === name || item.configuration?.id === name,
      )
    );
  } catch {
    return false;
  }
}
/** Controller backstop after a broker crash. Never touches another policy's VM. */
export function cleanupPolicyVms(vm: VmRuntime, policyId: string): number {
  const all = JSON.parse(
    cli(
      vm.binary,
      ["list", "--all", "--format", "json"],
      15000,
      vm.controlHome,
    ),
  );
  if (!Array.isArray(all))
    throw unavailable("Cannot confirm owned VM cleanup.");
  const prefix = `agio-${policyId.slice(0, 16)}-`;
  const names = all
    .map(
      (item: { id?: string; configuration?: { id?: string } }) =>
        item.id ?? item.configuration?.id,
    )
    .filter(
      (id: unknown): id is string =>
        typeof id === "string" && id.startsWith(prefix),
    );
  for (const name of names)
    if (!removeVm(vm, name)) throw unavailable("Owned VM cleanup failed.");
  return names.length;
}
export function vmArgumentsDigest(args: string[]): string {
  return sha(JSON.stringify(args));
}
