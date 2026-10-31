import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IoUnavailable } from "./program_io_errors";
import { InvocationContext } from "./invocation_types";

const execute = promisify(execFile);
export async function codexArguments({
  binding: b,
  opts,
  env,
  readonly,
  executable,
}: InvocationContext): Promise<string[]> {
  const args = [
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
      const { stdout } = await execute(
        executable.file,
        [...executable.prefix, "--version"],
        {
          cwd: opts.cwd,
          env,
          timeout: 5000,
          maxBuffer: 32768,
          windowsHide: true,
        },
      );
      if (stdout.trim() !== "codex-cli 0.162.1") throw Error();
    } catch {
      throw new IoUnavailable(
        `The scoped local HTTP adapter requires verified codex-cli 0.162.1; no model invocation was started. Revalidate the proxy before using another CLI version.`,
      );
    }
    // Invocation-local command networking: local test servers only. The
    // proxy and explicit destinations must accompany network_access=true.
    args.push(
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      "features.network_proxy.enabled=true",
      "-c",
      'features.network_proxy.domains={"localhost"="allow","127.0.0.1"="allow","::1"="allow"}',
      "-c",
      "features.network_proxy.allow_local_binding=true",
    );
  }
  for (const dir of opts.allowedPaths) args.push("--add-dir", dir);
  if (b.variant)
    args.push("-c", `model_reasoning_effort=${JSON.stringify(b.variant)}`);
  if (opts.resumeId) args.push("resume", opts.resumeId);
  args.push(
    opts.prompt +
      (opts.localHttpAccess &&
      opts.nativeApprovalReview &&
      !readonly &&
      !opts.fullAccess
        ? "\nNative local-test networking is enabled through a proxy restricted to localhost/127.0.0.1/::1. Keep commands sandboxed. If a required registered Chromium verifier is blocked specifically by macOS Mach/bootstrap browser-launch permissions, use native automatic approval review for that EXACT foreground verifier command and explain the local headless browser requirement. This is automatic CLI review, not a human approval request. Never use danger-full-access startup flags, change global settings or approve arbitrary commands. If that review is denied, stop with BLOCKED_KIND: external and VERDICT: BLOCKED; do not bypass or rephrase the denied action."
        : ""),
  );
  return args;
}
