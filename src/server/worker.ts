import { StudioStore } from "../core/store";
import { GraphRuntime } from "../core/runtime";
import {
  enqueueControlRequest,
  getControlQueuePaths,
} from "../core/control_queue";
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
    // All state/log writes and lease release have completed. ConPTY can retain
    // native helper handles, so end this single-session worker after IPC drains.
    const exit = () => process.exit(process.exitCode ?? 0);
    if (process.connected) {
      process.once("disconnect", exit);
      process.disconnect?.();
    } else exit();
  });
