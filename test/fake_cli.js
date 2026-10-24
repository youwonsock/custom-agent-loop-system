#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2] || "success";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const assistant = (text, id = `text-${Date.now()}`) =>
  emit({ type: "text", id, part: { id, text } });

switch (mode) {
  case "pipe-json-interleaved": {
    const text = '한글🙂'.repeat(1200) + '\n[PHASE_DONE]';
    const bytes = Buffer.from(JSON.stringify({ type: 'text', sessionID: 'pipe-session', part: { text } }) + '\n');
    process.stdout.write(bytes.subarray(0, 3601));
    process.stderr.write('timestamp=2026-10-22T16:51:13Z level=ERROR message="stream error" error.error="Providers for this model are at capacity."\n');
    setTimeout(() => {
      process.stdout.write(bytes.subarray(3601));
      emit({ type: 'step_finish', part: { model: { providerID: 'kilo', modelID: 'pipe-fixture' }, tokens: { total: 42 } } });
    }, 40);
    break;
  }
  case "retry-step-noise": {
    let n=0;
    setInterval(() => { emit({type:"step_start",part:{id:`retry-${n++}`},sessionID:"ses_retryNoise"}); emit({type:"step_finish",part:{id:`done-${n++}`}}); }, 25);
    break;
  }
  case "primary-provider-errors-without-status":
  case "primary-provider-failures": {
    let n=0;
    setInterval(() => {console.error(mode === "primary-provider-errors-without-status" ? `timestamp=${n++} level=ERROR message="stream error" session.id=ses_primary error.error="AI_APICallError: Service Unavailable"` : `timestamp=${n++} level=ERROR message="stream error" session.id=ses_primary error.error.code=504 error.error.message="Upstream idle timeout exceeded"`);emit({type:"step_start",part:{id:`retry-${n}`}});}, 30);
    break;
  }
  case "unavailable-tools": {
    let n=0;
    setInterval(() => emit({type:"tool_use",part:{id:`bad-${n++}`,tool:"exec",state:{status:"error",error:"Model tried to call unavailable tool 'exec'"}}}),30);
    break;
  }
  case "native-provider-retries":
    console.error('timestamp=2026-10-22T16:51:12Z level=INFO message=stream session.id=ses_nativeRetry');
    setInterval(() => console.error('timestamp=2026-10-22T16:51:13Z level=ERROR message="stream error" error.error="Providers for this model are currently at capacity."'), 30);
    break;
  case "qa-auth-regression":
    for (const line of fs
      .readFileSync(
        path.join(__dirname, "fixtures/qa-auth-regression.jsonl"),
        "utf8",
      )
      .trim()
      .split("\n"))
      emit(JSON.parse(line));
    process.exit(0);
    break;
  case "terminal-secret-after-completion":
    assistant("APPROVED\n[PHASE_DONE]");
    emit({
      type: "error",
      error: {
        name: "APIError",
        data: {
          statusCode: 401,
          message: "authentication required: top-secret",
        },
      },
    });
    for (let n = 0; n < 25; n++)
      emit({ type: "tool_result", id: `noise-${n}`, payload: "x".repeat(400) });
    process.exit(0);
    break;
  case "claude-terminal-error":
    assistant("APPROVED\n[PHASE_DONE]");
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Invalid API key"],
      result: "This error must not become assistant completion.\n[PHASE_DONE]",
    });
    process.exit(0);
    break;
  case "tool-auth-error":
    emit({
      type: "tool_use",
      part: {
        id: "fetch",
        type: "tool",
        tool: "webfetch",
        state: {
          status: "error",
          input: { url: "https://example.com" },
          error: "HTTP 401: authentication failed",
        },
      },
    });
    assistant("APPROVED\n[PHASE_DONE]");
    process.exit(0);
    break;
  case "denied-claude-write":
  case "partial-claude-write":
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "write-1",
            name: "Write",
            input: { file_path: "source.ts", content: "changed" },
          },
        ],
      },
    });
    emit({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "write-1",
            is_error: true,
            content: "tool failed",
          },
        ],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      permission_denials:
        mode === "denied-claude-write"
          ? [{ tool_use_id: "write-1", tool_name: "Write" }]
          : [],
      result: "APPROVED\n[PHASE_DONE]",
    });
    process.exit(0);
    break;
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
        "## OPTION 3: C\nPlan C\n[PHASE_DONE]",
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
    process.stdout.write(
      '{"type":"text","id":"split-secret","part":{"id":"split-secret","text":"credential=top-',
    );
    setTimeout(() => {
      process.stdout.write('secret\\n[PHASE_DONE]"}}\n');
      process.exit(0);
    }, 30);
    break;
  case "incomplete":
    assistant("Work stopped before the completion contract.");
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
  case "evidence-flood":
    if (mode === "evidence-flood") {
      emit({
        type: "item.completed",
        item: { id: "changed-file", type: "file_change" },
      });
      emit({
        type: "item.completed",
        item: { id: "searched", type: "web_search" },
      });
      emit({ type: "turn.completed", usage: { output_tokens: 123 } });
      emit({ type: "item.completed", item: { id: "check", type: "command_execution", command: "npm test", exit_code: 0, status: "completed", aggregated_output: "pass 1" } });
    }
    for (let index = 0; index < 20; index++) {
      emit({
        type: "tool_result",
        id: `tool-${index}`,
        payload: "x".repeat(400),
      });
    }
    assistant(
      "Completed after event flood.\n[PHASE_DONE]",
      "event-flood-complete",
    );
    process.exit(0);
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
  case "delayed-model":
    emit({
      type: "step_start",
      id: "delayed-model-step",
      sessionID: "delayed-model-session",
    });
    setTimeout(() => {
      assistant(
        "Long model generation completed.\n[PHASE_DONE]",
        "delayed-model-text",
      );
      process.exit(0);
    }, 1100);
    break;
  case "continuous-progress": {
    let progress = 0;
    emit({
      type: "step_start",
      id: `continuous-${progress++}`,
      sessionID: "continuous-session",
    });
    const timer = setInterval(() => {
      if (progress >= 15) {
        clearInterval(timer);
        assistant(
          "Progressive work completed.\n[PHASE_DONE]",
          "continuous-complete",
        );
        process.exit(0);
        return;
      }
      assistant(`Completed work unit ${progress}`, `continuous-${progress++}`);
    }, 80);
    break;
  }
  case "delayed-tool":
    emit({
      type: "tool_use",
      id: "delayed-tool-event",
      timestamp: Date.now(),
      part: {
        id: "delayed-tool-part",
        tool: "bash",
        state: { status: "running" },
      },
    });
    setTimeout(() => {
      emit({
        type: "tool_use",
        id: "delayed-tool-event",
        timestamp: Date.now(),
        part: {
          id: "delayed-tool-part",
          tool: "bash",
          state: { status: "completed" },
        },
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
      part: {
        id: "tool-hang-part",
        tool: "bash",
        state: { status: "running" },
      },
    });
    setInterval(() => {}, 1000);
    break;
  case "ignore-termination":
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    setInterval(() => {}, 1000);
    break;
  case "spawn-child":
    spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: false,
      stdio: "ignore",
    });
    setInterval(() => {}, 1000);
    break;
  default:
    process.stderr.write(`Unknown fake mode: ${mode}\n`);
    process.exit(2);
}
