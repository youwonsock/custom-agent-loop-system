import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import {
  SessionOwnership,
  claimNextControlRequest,
  collectRecoveredChildPids,
  completeControlRequest,
  enqueueControlRequest,
  ensureControlQueue,
  getControlQueuePaths,
  readControlAck,
  recoverClaimedControlRequests,
  withShortFileLock,
} from "./resilience";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-test-"));
  try {
    await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("short state lock serializes concurrent updates", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "state_write.lock");
    let value = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withShortFileLock(lockPath, async () => {
          const before = value;
          await new Promise((resolve) => setTimeout(resolve, 2));
          value = before + 1;
        })
      )
    );
    assert.equal(value, 20);
  });
});

test("control queue prioritizes STOP and preserves every request", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    await ensureControlQueue(paths);
    const interrupt = await enqueueControlRequest(paths, "INTERRUPT", "inspect");
    const stop = await enqueueControlRequest(paths, "STOP");
    const first = await claimNextControlRequest(paths);
    assert.equal(first?.request.requestId, stop.requestId);
    await completeControlRequest(paths, first!, "completed", "paused");
    const second = await claimNextControlRequest(paths);
    assert.equal(second?.request.requestId, interrupt.requestId);
    await completeControlRequest(paths, second!, "cancelled", "already paused");
    assert.equal((await readControlAck(paths, stop.requestId))?.result, "completed");
    assert.equal((await readControlAck(paths, interrupt.requestId))?.result, "cancelled");
  });
});

test("malformed control requests are quarantined and cannot escape the ACK directory", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(path.join(dir, "session"));
    await ensureControlQueue(paths);
    const escapeBase = path.join(dir, "session", "escaped-control-ack");
    await fsp.writeFile(
      path.join(paths.requests, "attacker.json"),
      JSON.stringify({
        requestId: "../../escaped-control-ack",
        type: "STOP",
        createdAt: new Date().toISOString(),
        message: null,
      }),
      "utf8"
    );

    assert.equal(await claimNextControlRequest(paths), null);
    assert.equal((await fsp.readdir(paths.requests)).length, 0);
    assert.equal((await fsp.readdir(paths.quarantine)).length, 1);
    await assert.rejects(() => readControlAck(paths, "../../escaped-control-ack"), /Unsafe control request id/);
    await assert.rejects(() => fsp.access(`${escapeBase}.json`), /ENOENT/);
  });
});

test("temporary atomic request files are ignored rather than quarantined", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    await ensureControlQueue(paths);
    const tempName = "control_migrate_0123456789ab.json.tmp.123.456.01234567";
    await fsp.writeFile(path.join(paths.requests, tempName), "partial", "utf8");

    assert.equal(await claimNextControlRequest(paths), null);
    assert.deepEqual(await fsp.readdir(paths.requests), [tempName]);
    assert.equal((await fsp.readdir(paths.quarantine)).length, 0);
  });
});

test("forged completed ACKs are quarantined and cannot discard claimed requests", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    await ensureControlQueue(paths);
    const requestId = "control_recover_0123456789ab";
    const request = {
      requestId,
      type: "STOP",
      createdAt: new Date().toISOString(),
      message: null,
    };
    await fsp.writeFile(
      path.join(paths.processing, `${requestId}.json`),
      JSON.stringify(request),
      "utf8"
    );
    await fsp.writeFile(
      path.join(paths.acks, `${requestId}.json`),
      JSON.stringify({
        requestId: "control_forged_abcdef012345",
        type: "STOP",
        acceptedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        result: "completed",
        message: null,
      }),
      "utf8"
    );

    await recoverClaimedControlRequests(paths);
    assert.deepEqual(await fsp.readdir(paths.requests), [`${requestId}.json`]);
    assert.equal((await fsp.readdir(paths.processing)).length, 0);
    assert.equal((await fsp.readdir(paths.acks)).length, 0);
    assert.equal((await fsp.readdir(paths.quarantine)).length, 1);
  });
});

test("invalid timestamps and oversized messages are quarantined or rejected", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    await ensureControlQueue(paths);
    const requestId = "control_invalid_0123456789ab";
    await fsp.writeFile(
      path.join(paths.requests, `${requestId}.json`),
      JSON.stringify({
        requestId,
        type: "INTERRUPT",
        createdAt: "2026-01-01",
        message: "inspect",
      }),
      "utf8"
    );
    assert.equal(await claimNextControlRequest(paths), null);
    assert.equal((await fsp.readdir(paths.quarantine)).length, 1);
    await assert.rejects(
      () => enqueueControlRequest(paths, "INTERRUPT", "x".repeat(16 * 1024 + 1)),
      /exceeds/
    );
  });
});

test("control request filenames must exactly match their validated request id", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    await ensureControlQueue(paths);
    const request = await enqueueControlRequest(paths, "INTERRUPT", "inspect");
    const expectedPath = path.join(paths.requests, `${request.requestId}.json`);
    const mismatchedPath = path.join(paths.requests, "control_legacy_000000000000.json");
    await fsp.rename(expectedPath, mismatchedPath);

    assert.equal(await claimNextControlRequest(paths), null);
    assert.equal((await fsp.readdir(paths.quarantine)).length, 1);
  });
});

test("control completion rejects invalid results and oversized ACK messages", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    const request = await enqueueControlRequest(paths, "STOP");
    const claimed = await claimNextControlRequest(paths);
    assert.equal(claimed?.request.requestId, request.requestId);
    await assert.rejects(
      () => completeControlRequest(paths, claimed!, "unexpected" as never),
      /Unsupported completed control result/
    );
    await assert.rejects(
      () => completeControlRequest(paths, claimed!, "failed", "x".repeat(16 * 1024 + 1)),
      /exceeds/
    );
    await completeControlRequest(paths, claimed!, "failed", "validation test");
    assert.equal((await readControlAck(paths, request.requestId))?.result, "failed");
  });
});

test("recovery quarantines malformed processing entries instead of replaying them", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    await ensureControlQueue(paths);
    await fsp.writeFile(
      path.join(paths.processing, "control_bad_000000000000.json"),
      "{not-json",
      "utf8"
    );

    await recoverClaimedControlRequests(paths);
    assert.equal((await fsp.readdir(paths.processing)).length, 0);
    assert.equal((await fsp.readdir(paths.requests)).length, 0);
    assert.equal((await fsp.readdir(paths.quarantine)).length, 1);
  });
});

test("valid owner lease prevents duplicate session ownership", async () => {
  await withTempDir(async (dir) => {
    const options = {
      sessionDir: dir,
      ownerLockFileName: "session_owner.lock",
      leaseFileName: "session_lease.json",
      heartbeatIntervalMs: 50,
      leaseTtlMs: 500,
    };
    const first = new SessionOwnership(options);
    const second = new SessionOwnership(options);
    await first.acquire();
    await assert.rejects(() => second.acquire(), /already running|already owned/);
    await first.release();
  });
});

test("expired dead owner permits exactly one concurrent stale takeover", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "session_owner.lock");
    const leasePath = path.join(dir, "session_lease.json");
    await fsp.writeFile(
      lockPath,
      JSON.stringify({
        ownerId: "dead-owner",
        ownerPid: 2147483647,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf8"
    );
    await fsp.writeFile(
      leasePath,
      JSON.stringify({
        ownerId: "dead-owner",
        ownerPid: 2147483647,
        childPid: null,
        acquiredAt: "2000-01-01T00:00:00.000Z",
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:00:20.000Z",
      }),
      "utf8"
    );
    const options = {
      sessionDir: dir,
      ownerLockFileName: "session_owner.lock",
      leaseFileName: "session_lease.json",
      heartbeatIntervalMs: 50,
      leaseTtlMs: 500,
    };
    const candidates = [new SessionOwnership(options), new SessionOwnership(options)];
    const results = await Promise.allSettled(candidates.map((candidate) => candidate.acquire()));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    await Promise.all(candidates.map((candidate) => candidate.release()));
  });
});

test("dead owner lock without a lease is reclaimable only after the lease TTL", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "session_owner.lock");
    const options = {
      sessionDir: dir,
      ownerLockFileName: "session_owner.lock",
      leaseFileName: "session_lease.json",
      heartbeatIntervalMs: 50,
      leaseTtlMs: 100,
    };
    await fsp.writeFile(
      lockPath,
      JSON.stringify({
        ownerId: "dead-before-first-heartbeat",
        ownerPid: 2147483647,
        createdAt: new Date().toISOString(),
      }),
      "utf8"
    );
    await assert.rejects(
      () => new SessionOwnership(options).acquire(),
      /first lease is not yet readable/
    );

    await fsp.writeFile(
      lockPath,
      JSON.stringify({
        ownerId: "dead-before-first-heartbeat",
        ownerPid: 2147483647,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf8"
    );
    const recovered = new SessionOwnership(options);
    const result = await recovered.acquire();
    assert.equal(result.recoveredStaleOwner, true);
    assert.equal(result.previousLease, null);
    await recovered.release();
  });
});

test("failed first lease write removes the newly-created owner lock", async () => {
  await withTempDir(async (dir) => {
    await fsp.mkdir(path.join(dir, "session_lease.json"));
    const ownership = new SessionOwnership({
      sessionDir: dir,
      ownerLockFileName: "session_owner.lock",
      leaseFileName: "session_lease.json",
      heartbeatIntervalMs: 50,
      leaseTtlMs: 100,
    });
    await assert.rejects(() => ownership.acquire());
    await assert.rejects(
      () => fsp.access(path.join(dir, "session_owner.lock")),
      /ENOENT/
    );
  });
});

test("recovery reconciles lease and persisted attempt child PIDs", () => {
  assert.deepEqual(
    collectRecoveredChildPids(
      {
        ownerId: "dead-owner",
        ownerPid: 2147483647,
        childPid: 101,
        acquiredAt: "2000-01-01T00:00:00.000Z",
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:00:20.000Z",
      },
      202
    ),
    [101, 202]
  );
  assert.deepEqual(
    collectRecoveredChildPids(
      {
        ownerId: "dead-owner",
        ownerPid: 2147483647,
        childPid: 101,
        acquiredAt: "2000-01-01T00:00:00.000Z",
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:00:20.000Z",
      },
      101
    ),
    [101]
  );
});
