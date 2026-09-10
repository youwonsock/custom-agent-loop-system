import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { VerificationProcessRuntime } from "./verification-process-runtime";

const windowsHelperAvailable = process.platform !== "win32" || Boolean(
  (process.env.AGENT_LOOP_VERIFICATION_HELPER && existsSync(process.env.AGENT_LOOP_VERIFICATION_HELPER)) ||
  // TypeScript emits this test under dist/src/runtime, so native is three
  // levels above (__dirname -> src -> dist -> project root).
  existsSync(path.resolve(__dirname, "../../../native/bin/win32-x64/verification-host.exe"))
);

test("verification runtime times out and cleans a child process tree", { skip: !windowsHelperAvailable }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-process-runtime-"));
  try {
    const result = await new VerificationProcessRuntime().execute({
      runId: "runtime-test",
      verificationId: "runtime-test-verification",
      projectRoot: root,
      command: {
        id: "tree",
        label: "tree",
        executable: process.execPath,
        args: ["-e", "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'}); setTimeout(()=>{},60000)"],
        cwd: ".",
        timeoutMs: 300,
        requirementIds: ["REQ-001"],
      },
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.processTreeClean, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification runtime bounds captured output", { skip: !windowsHelperAvailable }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-process-output-"));
  try {
    const result = await new VerificationProcessRuntime().execute({
      runId: "runtime-output-test",
      verificationId: "runtime-output-verification",
      projectRoot: root,
      command: {
        id: "output",
        label: "output",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(5*1024*1024))"],
        cwd: ".",
        timeoutMs: 5000,
        requirementIds: ["REQ-001"],
      },
    });
    assert.equal(result.processTreeClean, true);
    assert.equal(result.outputTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 4 * 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification runtime rejects an already aborted command before spawning", { skip: !windowsHelperAvailable }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-process-abort-before-"));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      new VerificationProcessRuntime().execute({
        runId: "runtime-abort-before",
        verificationId: "runtime-abort-before-verification",
        projectRoot: root,
        command: { id: "abort", label: "abort", executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 1_000, requirementIds: ["REQ-001"] },
        signal: controller.signal,
      }),
      /aborted before/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification runtime records normal exit, bounded redacted output, and a resolved cwd", { skip: !windowsHelperAvailable }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-process-success-"));
  try {
    const result = await new VerificationProcessRuntime({ sensitiveValues: ["TOP_SECRET"] }).execute({
      runId: "runtime-success",
      verificationId: "runtime-success-verification",
      projectRoot: root,
      command: {
        id: "success",
        label: "success",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('TOP_SECRET'); process.stderr.write('diagnostic'); process.exit(3)"],
        cwd: ".",
        timeoutMs: 5_000,
        requirementIds: ["REQ-001"],
      },
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.processTreeClean, true);
    assert.equal(result.stdout, "[REDACTED]");
    assert.equal(result.stderr, "diagnostic");
    assert.equal(result.resolvedCwd, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification runtime fails closed for missing executables and escaping cwd", { skip: !windowsHelperAvailable }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-process-preflight-"));
  try {
    await assert.rejects(
      new VerificationProcessRuntime().execute({
        runId: "runtime-missing",
        verificationId: "runtime-missing-verification",
        projectRoot: root,
        command: { id: "missing", label: "missing", executable: "agent-loop-command-that-does-not-exist", args: [], cwd: ".", timeoutMs: 1_000, requirementIds: ["REQ-001"] },
      }),
      /could not be resolved/u,
    );
    await assert.rejects(
      new VerificationProcessRuntime().execute({
        runId: "runtime-cwd",
        verificationId: "runtime-cwd-verification",
        projectRoot: root,
        command: { id: "cwd", label: "cwd", executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: "..", timeoutMs: 1_000, requirementIds: ["REQ-001"] },
      }),
      /cwd escapes/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification runtime aborts a running command and confirms cleanup", { skip: !windowsHelperAvailable }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-process-abort-"));
  try {
    const controller = new AbortController();
    const pending = new VerificationProcessRuntime({ terminationGraceMs: 25, killTimeoutMs: 1_000 }).execute({
      runId: "runtime-abort",
      verificationId: "runtime-abort-verification",
      projectRoot: root,
      command: { id: "abort", label: "abort", executable: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"], cwd: ".", timeoutMs: 10_000, requirementIds: ["REQ-001"] },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await pending;
    assert.equal(result.processTreeClean, true);
    assert.notEqual(result.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
