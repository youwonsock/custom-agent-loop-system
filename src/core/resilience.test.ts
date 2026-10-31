import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { SessionOwnership } from "./session_ownership";
import {
  claimNextControlRequest,
  completeControlRequest,
  enqueueControlRequest,
  ensureControlQueue,
  getControlQueuePaths,
  readControlAck,
  recoverClaimedControlRequests,
} from "./control_queue";
import { collectRecoveredChildPids } from "./resilience";
import { acquireShortFileLock, withShortFileLock } from "./file_lock";

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
        }),
      ),
    );
    assert.equal(value, 20);
  });
});

test("a freshly abandoned short lock is reclaimed immediately and concurrent takeovers stay serialized", async () => {
  await withTempDir(async (dir) => {
    const lock = path.join(dir, "state.lock");
    await fsp.writeFile(
      lock,
      JSON.stringify({
        ownerId: "crashed-writer",
        ownerPid: 2147483647,
        createdAt: new Date().toISOString(),
      }),
    );
    let value = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withShortFileLock(
          lock,
          async () => {
            const previous = value;
            await new Promise((resolve) => setTimeout(resolve, 2));
            value = previous + 1;
          },
          1000,
        ),
      ),
    );
    assert.equal(value, 10);
  });
});

test("control queue prioritizes STOP and preserves every request", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    await ensureControlQueue(paths);
    const interrupt = await enqueueControlRequest(
      paths,
      "INTERRUPT",
      "inspect",
    );
    const stop = await enqueueControlRequest(paths, "STOP");
    const first = await claimNextControlRequest(paths);
    assert.equal(first?.request.requestId, stop.requestId);
    await completeControlRequest(paths, first!, "completed", "paused");
    const second = await claimNextControlRequest(paths);
    assert.equal(second?.request.requestId, interrupt.requestId);
    await completeControlRequest(paths, second!, "cancelled", "already paused");
    assert.equal(
      (await readControlAck(paths, stop.requestId))?.result,
      "completed",
    );
    assert.equal(
      (await readControlAck(paths, interrupt.requestId))?.result,
      "cancelled",
    );
  });
});

test("a STOP is still delivered when its accepted ack cannot be written", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    const stop = await enqueueControlRequest(paths, "STOP");
    // A directory at the ack path makes the atomic rename fail on every platform.
    const ackPath = path.join(paths.acks, `${stop.requestId}.json`);
    await fsp.mkdir(ackPath);
    const claimed = await claimNextControlRequest(paths);
    assert.equal(claimed?.request.requestId, stop.requestId);
    await fsp.rmdir(ackPath);
    await completeControlRequest(paths, claimed!, "completed", "stopped");
    assert.equal(
      (await readControlAck(paths, stop.requestId))?.result,
      "completed",
    );
    assert.deepEqual(await fsp.readdir(paths.processing), []);
  });
});

test("a request claimed by a dead worker returns to the queue unless it finished", async () => {
  await withTempDir(async (dir) => {
    const paths = getControlQueuePaths(dir);
    const unfinished = await enqueueControlRequest(paths, "STOP");
    await claimNextControlRequest(paths);
    const finished = await enqueueControlRequest(paths, "INTERRUPT", "inspect");
    const claimed = await claimNextControlRequest(paths);
    assert.equal(claimed?.request.requestId, finished.requestId);
    const processingPath = claimed!.processingPath;
    const copy = await fsp.readFile(processingPath);
    await completeControlRequest(paths, claimed!, "completed");
    // The worker died after its ack and before removing the processing file.
    await fsp.writeFile(processingPath, copy);

    await recoverClaimedControlRequests(paths);

    assert.deepEqual(await fsp.readdir(paths.processing), []);
    assert.deepEqual(await fsp.readdir(paths.requests), [
      `${unfinished.requestId}.json`,
    ]);
    const again = await claimNextControlRequest(paths);
    assert.equal(again?.request.requestId, unfinished.requestId);
    assert.equal(await claimNextControlRequest(paths), null);
  });
});

test("an abandoned reclaim guard is cleared only when it is old and its owner is dead", async () => {
  await withTempDir(async (dir) => {
    const lock = path.join(dir, "state.lock"),
      guard = `${lock}.reclaim`;
    const record = (ownerPid: number) =>
      JSON.stringify({
        ownerId: "previous",
        ownerPid,
        createdAt: new Date().toISOString(),
      });
    const age = (file: string) => {
      const old = new Date(Date.now() - 60_000);
      return fsp.utimes(file, old, old);
    };
    await fsp.writeFile(lock, record(2147483647));

    await fsp.writeFile(guard, record(process.pid));
    await age(guard);
    await assert.rejects(acquireShortFileLock(lock, 200), /Timed out/);
    assert.ok(await fsp.stat(guard), "a live owner keeps its guard");

    await fsp.writeFile(guard, record(2147483647));
    await assert.rejects(acquireShortFileLock(lock, 200), /Timed out/);
    assert.ok(await fsp.stat(guard), "a fresh guard may still be in use");

    await age(guard);
    const acquired = await acquireShortFileLock(lock, 2000);
    await acquired.release();
    await assert.rejects(fsp.stat(guard), { code: "ENOENT" });
    await assert.rejects(fsp.stat(lock), { code: "ENOENT" });
  });
});

test("a lock file without a readable record is reclaimed only after the stale limit", async () => {
  await withTempDir(async (dir) => {
    const lock = path.join(dir, "state.lock");
    await fsp.writeFile(lock, "");
    await assert.rejects(acquireShortFileLock(lock, 150), /Timed out/);
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lock, old, old);
    const acquired = await acquireShortFileLock(lock, 2000);
    assert.notEqual(acquired.ownerId, "");
    await acquired.release();
  });
});

test("releasing a lock taken over by another owner leaves the new lock alone", async () => {
  await withTempDir(async (dir) => {
    const lock = path.join(dir, "state.lock");
    const first = await acquireShortFileLock(lock);
    const successor = JSON.stringify({
      ownerId: "successor",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
    });
    await fsp.writeFile(lock, successor);
    await first.release();
    assert.equal(await fsp.readFile(lock, "utf8"), successor);
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
    await assert.rejects(
      () => second.acquire(),
      /already running|already owned/,
    );
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
      "utf8",
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
      "utf8",
    );
    const options = {
      sessionDir: dir,
      ownerLockFileName: "session_owner.lock",
      leaseFileName: "session_lease.json",
      heartbeatIntervalMs: 50,
      leaseTtlMs: 500,
    };
    const candidates = [
      new SessionOwnership(options),
      new SessionOwnership(options),
    ];
    const results = await Promise.allSettled(
      candidates.map((candidate) => candidate.acquire()),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
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
      "utf8",
    );
    await assert.rejects(
      () => new SessionOwnership(options).acquire(),
      /first lease is not yet readable/,
    );

    await fsp.writeFile(
      lockPath,
      JSON.stringify({
        ownerId: "dead-before-first-heartbeat",
        ownerPid: 2147483647,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf8",
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
      /ENOENT/,
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
      202,
    ),
    [101, 202],
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
      101,
    ),
    [101],
  );
});
