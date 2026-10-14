import { StudioStore } from "../core/store";
import { GraphRuntime } from "../core/runtime";
import {
  enqueueControlRequest,
  getControlQueuePaths,
} from "../core/resilience";
const [root, sessionId, mode] = process.argv.slice(2);
if (!root || !sessionId) throw new Error("worker 인자가 필요합니다.");
const store = new StudioStore(root);
const runtime = new GraphRuntime(store, sessionId, {
  onState: (state) => {
    if (process.connected)
      process.send?.({ type: "session", sessionId, data: state });
  },
  onLog: (visitId, attemptId, text) => {
    if (process.connected)
      process.send?.({
        type: "log",
        sessionId,
        data: { visitId, attemptId, text },
      });
  },
});
process.on("message", () => runtime.cancelPreflight());
const stop = () => {
  void enqueueControlRequest(
    getControlQueuePaths(store.sessionDir(sessionId)),
    "STOP",
  ).then(() => runtime.cancelPreflight());
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
void runtime
  .run(
    mode === "manual" ? "manual" : mode === "automatic" ? "automatic" : "start",
  )
  .catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.connected) process.disconnect?.();
  });
