import test from "node:test";
import assert from "node:assert/strict";
import { delay } from "./resilience";
import { DescendantWatch } from "./descendant_watch";

test("a refused process table leaves nothing to reap and no rejected promise", async (t) => {
  t.mock.method(require("node:child_process"), "execFile", () => {
    throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
  });
  const watch = new DescendantWatch(process.pid);
  watch.start();
  await delay(600);
  assert.deepEqual(await watch.reap(10), []);
});
