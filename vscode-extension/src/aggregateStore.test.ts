import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoopState } from "./types";
import {
  ExtensionAggregateStore,
  ExtensionImmutableArtifactStore,
  aggregateChecksum,
  isValidAggregateState,
  sealAggregateState,
} from "./aggregateStore";

function minimalState(sessionId: string): LoopState {
  return {
    stateVersion: 2,
    sessionId,
    status: "WAITING_USER",
    updatedAt: new Date(0).toISOString(),
  } as LoopState;
}

test("extension aggregate checksum matches sealed state and detects tampering", () => {
  const sealed = sealAggregateState(minimalState("checksum"), 3, 2);
  assert.equal(isValidAggregateState(sealed), true);
  assert.equal(sealed.aggregateChecksum, aggregateChecksum(sealed));
  assert.equal(isValidAggregateState({ ...sealed, status: "SUCCESS" }), false);
});

test("extension aggregate store migrates legacy state and commits CAS/WAL idempotently", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-extension-aggregate-"));
  try {
    const statePath = path.join(root, "loop_state.json");
    await fs.writeFile(statePath, JSON.stringify(minimalState("offline")), "utf8");
    const store = new ExtensionAggregateStore(root, "loop_state.json");
    const migrated = await store.loadUnlocked();
    assert.equal(migrated?.aggregateRevision, 0);
    assert.equal(isValidAggregateState(migrated), true);

    const committed = await store.updateOfflineUnlocked({
      expectedRevision: 0,
      requestId: "approve_request_1",
      mutate: (state) => {
        state.planApproved = true;
      },
      assertNoLiveOwner: () => {},
    });
    assert.equal(committed.aggregateRevision, 1);
    assert.equal(committed.planApproved, true);
    assert.deepEqual(committed.processedRequestIds, ["approve_request_1"]);

    const duplicate = await store.updateOfflineUnlocked({
      expectedRevision: 0,
      requestId: "approve_request_1",
      mutate: (state) => {
        state.planApproved = false;
      },
      assertNoLiveOwner: () => {
        throw new Error("duplicate requests must return before ownership checks");
      },
    });
    assert.equal(duplicate.aggregateRevision, 1);
    assert.equal(duplicate.planApproved, true);

    await assert.rejects(
      store.updateOfflineUnlocked({
        expectedRevision: 0,
        requestId: "stale_request",
        mutate: () => {},
        assertNoLiveOwner: () => {},
      }),
      /revision conflict/
    );

    await fs.writeFile(statePath, JSON.stringify(migrated), "utf8");
    const recovered = await store.loadUnlocked();
    assert.equal(recovered?.aggregateRevision, 1);
    const repairedSnapshot = JSON.parse(await fs.readFile(statePath, "utf8")) as LoopState;
    assert.equal(repairedSnapshot.aggregateRevision, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extension offline aggregate writes fail closed for a live owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-extension-owner-"));
  try {
    await fs.writeFile(
      path.join(root, "loop_state.json"),
      JSON.stringify(minimalState("owner")),
      "utf8"
    );
    const store = new ExtensionAggregateStore(root, "loop_state.json");
    await store.loadUnlocked();
    await assert.rejects(
      store.updateOfflineUnlocked({
        expectedRevision: 0,
        requestId: "blocked_request",
        mutate: (state) => {
          state.status = "STOPPED";
        },
        assertNoLiveOwner: () => {
          throw new Error("active owner");
        },
      }),
      /active owner/
    );
    assert.equal((await store.loadUnlocked())?.aggregateRevision, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extension artifact store uses immutable SHA-256 addressed files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-extension-artifact-"));
  try {
    const store = new ExtensionImmutableArtifactStore(root);
    const first = await store.put("approved plan\n", "text/markdown");
    const second = await store.put("approved plan\n", "text/markdown");
    assert.deepEqual(second, first);
    const content = await fs.readFile(
      path.join(root, "sha256", first.sha256.slice(0, 2), first.sha256),
      "utf8"
    );
    assert.equal(content, "approved plan\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
