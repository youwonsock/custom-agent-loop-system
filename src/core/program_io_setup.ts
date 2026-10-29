import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  vmRuntimeFile,
  imageDigest,
  containerHostEnvironment,
} from "./program_io_vm";

/** Explicit developer/setup command. No model or user credentials enter its image. */
export function prepareProgramIoRuntime(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error(
      "The verified VM runtime currently requires Apple Silicon macOS 26 and Apple container 1.6.",
    );
  const binary = "/opt/homebrew/bin/container",
    dist = path.resolve(__dirname, "../.."),
    root = path.dirname(dist),
    descriptor = vmRuntimeFile(),
    cache = path.dirname(descriptor);
  const execute = (args: string[], inherit = false, timeout = 120000) => {
    const p = spawnSync(binary, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      stdio: inherit ? "inherit" : "pipe",
      env: containerHostEnvironment(),
    });
    if (p.status !== 0)
      throw Error(
        `container ${args[0]} failed: ${p.error?.message ?? p.stderr ?? p.status}`,
      );
    return p.stdout;
  };
  const version = execute(["--version"]);
  if (!/\b1\.6\.0\b/.test(version))
    throw Error(
      "This runtime adapter has been verified with container 1.6.0; unsupported versions fail closed.",
    );
  execute(["system", "start", "--enable-kernel-install"], true);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(dist, "program_io_dependencies.json"), "utf8"),
  );
  const lock = fs.readFileSync(path.join(dist, "program_io_package_lock.json"));
  if (createHash("sha256").update(lock).digest("hex") !== metadata.lockDigest)
    throw Error("Packaged runtime dependency lock is invalid.");
  let prepared: { image?: string; lockDigest?: string } | null = null;
  try {
    prepared = JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch {}
  const image =
    process.env.AGENT_GRAPH_IO_SETUP_IMAGE ??
    (prepared && prepared.lockDigest === metadata.lockDigest && prepared.image
      ? prepared.image
      : `agent-graph-io-runtime:node24-${metadata.lockDigest.slice(0, 12)}`);
  let digest: string | null = null;
  try {
    digest = imageDigest(binary, image);
  } catch {}
  if (!digest) {
    const disk = fs.statfsSync(root);
    if (disk.bavail * disk.bsize < 8 * 1024 ** 3)
      throw Error(
        "Building the runtime requires 8 GiB free space. No existing files are automatically deleted.",
      );
    const context = path.join(cache, "setup-" + randomUUID());
    fs.mkdirSync(path.join(context, "scripts"), {
      recursive: true,
      mode: 0o700,
    });
    fs.copyFileSync(
      path.join(root, "package.json"),
      path.join(context, "package.json"),
    );
    fs.writeFileSync(path.join(context, "package-lock.json"), lock);
    fs.copyFileSync(
      path.join(root, "scripts/fix-pty-permissions.js"),
      path.join(context, "scripts/fix-pty-permissions.js"),
    );
    fs.writeFileSync(
      path.join(context, "Dockerfile"),
      `FROM node:24.21.0-bookworm-slim\nENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright\nWORKDIR /opt/agent-runtime\nCOPY package.json package-lock.json ./\nCOPY scripts/fix-pty-permissions.js ./scripts/\nRUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && npm ci --cache /tmp/npm-cache && npx playwright install --with-deps --only-shell chromium && apt-get purge -y --auto-remove make g++ && rm -rf /tmp/npm-cache /var/lib/apt/lists/* /root/.cache /tmp/*\nENV NODE_ENV=production\nCMD ["node"]\n`,
    );
    execute(
      [
        "build",
        "--cpus",
        "2",
        "--memory",
        "3G",
        "--progress",
        "plain",
        "-t",
        image,
        context,
      ],
      true,
      1200000,
    );
    digest = imageDigest(binary, image);
  }
  const code =
    "const f=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,playwright:require('playwright/package.json').version,lockDigest:c.createHash('sha256').update(f.readFileSync('/opt/agent-runtime/package-lock.json')).digest('hex'),interfaces:Object.keys(require('node:os').networkInterfaces())}))";
  const actual = JSON.parse(
    execute([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--progress",
      "none",
      image,
      "node",
      "-e",
      code,
    ]),
  );
  if (
    actual.lockDigest !== metadata.lockDigest ||
    !/^v24\./.test(actual.node) ||
    actual.platform !== "linux" ||
    actual.interfaces.some((name: string) => name !== "lo")
  )
    throw Error("Runtime image dependency, Node or network proof failed.");
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const value = {
    version: 1,
    binary,
    containerVersion: "1.6.0",
    image,
    imageDigest: digest,
    lockDigest: metadata.lockDigest,
    actual,
  };
  const temporary = descriptor + "." + randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temporary, descriptor);
  console.log(
    `Isolated program runtime ready: ${descriptor}\n${digest}\nNode ${actual.node}, Playwright ${actual.playwright}, network none`,
  );
}
if (require.main === module)
  try {
    prepareProgramIoRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
