#!/usr/bin/env node

const { spawn } = require("node:child_process");

const mode = process.argv[2] || "success";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const assistant = (text, id = `text-${Date.now()}`) =>
  emit({ type: "text", id, part: { id, text } });

switch (mode) {
  case "success":
    emit({ type: "step_start", id: "step-1", sessionID: "fake-session-1" });
    assistant("Completed fake work.\n[PHASE_DONE]");
    process.exit(0);
    break;
  case "planner":
    assistant(
      "=== PLAN OPTIONS ===\n" +
      "## OPTION 1: A\nPlan A\n\n" +
      "## OPTION 2: B\nPlan B\n\n" +
      "## OPTION 3: C\nPlan C\n[PHASE_DONE]"
    );
    process.exit(0);
    break;
  case "prompt-echo":
    process.stdout.write("Prompt says to print [PHASE_DONE]\n");
    process.exit(0);
    break;
  case "secret-echo":
    assistant("credential=top-secret\n[PHASE_DONE]");
    process.exit(0);
    break;
  case "split-secret-echo":
    process.stdout.write('{"type":"text","id":"split-secret","part":{"id":"split-secret","text":"credential=top-');
    setTimeout(() => {
      process.stdout.write('secret\\n[PHASE_DONE]"}}\n');
      process.exit(0);
    }, 30);
    break;
  case "wrapped-secret-echo":
    assistant("credential=top-secret\n[PHASE_DONE]", "wrapped-secret");
    process.exit(0);
    break;
  case "incomplete":
    assistant("Work stopped before the completion contract.");
    process.exit(0);
    break;
  case "malformed-structured-event":
    process.stdout.write(
      '{"type":"tool_use","part":{"tool":"websearch","state":{"status":"completed"}},"broken"::true}\n'
    );
    assistant("Malformed provider output must not pass.\n[PHASE_DONE]", "malformed-complete");
    process.exit(0);
    break;
  case "exit-fail":
    assistant("temporary network connection lost");
    process.exit(7);
    break;
  case "rate-limit":
    assistant("429 rate limit; Retry-After: 1");
    process.exit(1);
    break;
  case "event-flood":
    for (let index = 0; index < 20; index++) {
      emit({
        type: "tool_result",
        id: `tool-${index}`,
        payload: "x".repeat(400),
      });
    }
    assistant("Completed after event flood.\n[PHASE_DONE]", "event-flood-complete");
    // Keep the producer alive briefly so this ring-buffer test does not also
    // depend on platform-specific PTY close/drain ordering under CI load.
    setTimeout(() => process.exit(0), 250);
    break;
  case "raw-log-backpressure":
    for (let index = 0; index < 100; index++) {
      emit({ type: "tool_result", id: `slow-log-${index}`, payload: "b".repeat(256) });
    }
    setTimeout(() => {
      assistant("Completed after raw-log backpressure.\n[PHASE_DONE]", "backpressure-complete");
      setTimeout(() => process.exit(0), 100);
    }, 180);
    break;
  case "no-output":
    setInterval(() => {}, 1000);
    break;
  case "spinner":
    setInterval(() => process.stdout.write("\u001b[2K\r|"), 20);
    break;
  case "permission-prompt":
    process.stdout.write("Allow access to C:\\outside? [y/n]\n");
    setInterval(() => {}, 1000);
    break;
  case "confirmation-prompt":
    process.stdout.write("Continue? [y/n]\n");
    process.stdin.on("data", (chunk) => {
      if (/y/i.test(String(chunk))) {
        assistant("Unsafe confirmation was accepted.\n[PHASE_DONE]", "auto-y-result");
        process.exit(0);
      }
    });
    setInterval(() => {}, 1000);
    break;
  case "control-poll-error":
    emit({ type: "step_start", id: "control-poll-error", sessionID: "control-session" });
    setInterval(() => {}, 1000);
    break;
  case "raw-log-directory":
    require("node:fs").writeFileSync("provider-spawned.txt", "unsafe");
    assistant("Provider should not have started.\n[PHASE_DONE]", "raw-log-directory");
    process.exit(0);
    break;
  case "raw-log-runtime-error":
    require("node:fs").writeFileSync("provider-spawned.txt", "started");
    assistant("Trigger the injected raw log failure.", "raw-log-runtime-error");
    setInterval(() => {}, 1000);
    break;
  case "raw-log-final-error":
    require("node:fs").writeFileSync("provider-spawned.txt", "started");
    assistant("Provider completed before raw log finalization.\n[PHASE_DONE]", "raw-log-final-error");
    process.exit(0);
    break;
  case "delayed-model":
    emit({ type: "step_start", id: "delayed-model-step", sessionID: "delayed-model-session" });
    setTimeout(() => {
      assistant("Long model generation completed.\n[PHASE_DONE]", "delayed-model-text");
      process.exit(0);
    }, 220);
    break;
  case "continuous-progress": {
    let progress = 0;
    emit({ type: "step_start", id: `continuous-${progress++}`, sessionID: "continuous-session" });
    const timer = setInterval(() => {
      if (progress >= 5) {
        clearInterval(timer);
        assistant("Progressive work completed.\n[PHASE_DONE]", "continuous-complete");
        process.exit(0);
        return;
      }
      emit({ type: "step_start", id: `continuous-${progress++}`, sessionID: "continuous-session" });
    }, 80);
    break;
  }
  case "delayed-tool":
    emit({
      type: "tool_use",
      id: "delayed-tool-event",
      timestamp: Date.now(),
      part: { id: "delayed-tool-part", tool: "bash", state: { status: "running" } },
    });
    setTimeout(() => {
      emit({
        type: "tool_use",
        id: "delayed-tool-event",
        timestamp: Date.now(),
        part: { id: "delayed-tool-part", tool: "bash", state: { status: "completed" } },
      });
      assistant("Long tool completed.\n[PHASE_DONE]", "delayed-tool-text");
      process.exit(0);
    }, 250);
    break;
  case "tool-hang":
    emit({
      type: "tool_use",
      id: "tool-hang-event",
      timestamp: Date.now(),
      part: { id: "tool-hang-part", tool: "bash", state: { status: "running" } },
    });
    setInterval(() => {}, 1000);
    break;
  case "ignore-termination":
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    setInterval(() => {}, 1000);
    break;
  case "spawn-child":
    spawn(process.execPath, ["-e", [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      "fs.writeFileSync('descendant-pid.txt',String(child.pid))",
      "setInterval(()=>{},1000)",
    ].join("; ")], {
      detached: false,
      stdio: "ignore",
    });
    setInterval(() => {}, 1000);
    break;
  default:
    process.stderr.write(`Unknown fake mode: ${mode}\n`);
    process.exit(2);
}
