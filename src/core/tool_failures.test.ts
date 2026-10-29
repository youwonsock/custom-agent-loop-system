import test from "node:test";
import assert from "node:assert/strict";
import { ToolFailureTracker } from "./tool_failures";
import { normalizeProviderEvent } from "./provider_events";
const error = (
  id: string,
  message = "Model tried to call unavailable tool 'exec'",
) => ({
  type: "tool_use",
  part: { id, tool: "exec", state: { status: "error", error: message } },
});
test("only distinct consecutive tool schema failures stop a native attempt", () => {
  const t = new ToolFailureTracker();
  assert.equal(t.observe(error("1")), null);
  for (let n = 0; n < 10; n++) assert.equal(t.observe(error("1")), null);
  assert.equal(t.observe(error("2")), null);
  assert.match(t.observe(error("3"))!, /3 consecutive/);
  const healthy = new ToolFailureTracker();
  healthy.observe(error("1"));
  healthy.observe(error("2"));
  healthy.observe({
    type: "tool_use",
    part: { id: "good", state: { status: "completed" } },
  });
  assert.equal(healthy.observe(error("3")), null);
  for (let n = 0; n < 4; n++)
    assert.equal(
      healthy.observe(error(`permission-${n}`, "Permission denied")),
      null,
    );
});
test("step notifications, blank text and failed tools never count as useful progress", () => {
  for (const e of [
    { type: "step_start", part: { id: "start" } },
    { type: "step_finish", part: { id: "done" } },
    { type: "text", part: { id: "empty", text: "  " } },
    error("failed"),
  ])
    assert.equal(normalizeProviderEvent(e).progressId, null);
  assert.ok(
    normalizeProviderEvent({
      type: "text",
      part: { id: "text", text: "Actual answer" },
    }).progressId,
  );
  assert.ok(
    normalizeProviderEvent({
      type: "tool_use",
      part: { id: "read", state: { status: "completed" } },
    }).progressId,
  );
});
test("distinct malformed writes trigger a bounded schema fallback without fabricating missing content", () => {
  const tracker = new ToolFailureTracker();
  const write = (id: string) => ({
    type: "tool_use",
    part: {
      id,
      tool: "write",
      state: {
        status: "error",
        input: {},
        error:
          'The write tool was called with invalid arguments: ["content"]: is missing and is required; ["filePath"]: is missing and is required.',
      },
    },
  });
  assert.equal(tracker.observe(write("one")), null);
  assert.equal(
    tracker.observe(write("one")),
    null,
    "stream duplicates do not exhaust recovery",
  );
  assert.match(tracker.observe(write("two"))!, /2 consecutive.*"write"/);
  const denied = new ToolFailureTracker();
  for (let n = 0; n < 4; n++)
    assert.equal(
      denied.observe({
        type: "tool_use",
        part: {
          id: String(n),
          tool: "write",
          state: { status: "error", input: {}, error: "Permission denied" },
        },
      }),
      null,
    );
});
