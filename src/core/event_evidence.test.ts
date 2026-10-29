import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeCompletedSearch,
  fileMutation,
  MutationTracker,
  observeTokens,
  observeModel,
} from "./event_evidence";
import { shellMutation } from "./shell_mutation";
import * as fs from "node:fs";
import * as path from "node:path";
test("native Kilo step usage/model evidence is retained without reading tool payloads", () => {
  const part = {
    model: { providerID: "kilo", modelID: "reflection/beam" },
    tokens: { total: 13990, input: 11766, output: 12, reasoning: 36 },
  };
  assert.equal(observeTokens({ type: "step_finish", part }), 13990);
  assert.equal(
    observeModel({ type: "step_finish", part }),
    "kilo/reflection/beam",
  );
  assert.equal(observeModel({ type: "tool_use", part }), null);
  assert.equal(observeTokens({ type: "tool_use", part }), 0);
});
test("Claude search starts do not count as completed research; only successful tool results count", () => {
  const pending = new Set<string>();
  assert.equal(
    claudeCompletedSearch(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "s1", name: "WebSearch" }],
        },
      },
      pending,
    ),
    null,
  );
  assert.equal(
    claudeCompletedSearch(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "s1", content: "observed" },
          ],
        },
      },
      pending,
    ),
    "claude:s1",
  );
  claudeCompletedSearch(
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "s2", name: "WebFetch" }] },
    },
    pending,
  );
  assert.equal(
    claudeCompletedSearch(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "s2", is_error: true }],
        },
      },
      pending,
    ),
    null,
  );
});
test("known shell writes and native file change events are treated as mutations", () => {
  assert.equal(
    fileMutation({
      type: "item.completed",
      item: { type: "command_execution", command: "node -e writeFileSync()" },
    }),
    true,
  );
  assert.equal(
    fileMutation({
      type: "tool_use",
      name: "Bash",
      input: { command: "printf changed > file" },
    }),
    true,
  );
  assert.equal(
    fileMutation({
      type: "tool_use",
      name: "Read",
      input: { file_path: "source.ts" },
    }),
    false,
  );
});

test("shell operators are distinguished from quoted/escaped words and harmless stream redirects", () => {
  for (const command of [
    "ls -la ~/Desktop/ 2>/dev/null | head -30",
    "ls 2>&1",
    "printf text > '/dev/null'",
    "echo 'touch file > output'",
    'printf "%s" "writeFile > output"',
    "echo escaped\\>operator",
    "ls -la",
    "cat file < /dev/null",
  ])
    assert.equal(shellMutation(command), false, command);
  for (const command of [
    "printf text > output",
    "printf text 2>&1 >> output",
    "printf text >/dev/null && touch output",
    "echo test >/dev/null.tmp",
    'node -e \'require("fs").writeFileSync("file","x")\'',
    "sed -i '' source.ts",
    "echo $(touch output)",
    "echo `touch output`",
    "ls # harmless comment\ntouch output",
  ])
    assert.equal(shellMutation(command), true, command);
});

test("tool errors/output are not inspected as commands and pre-execution denials are excluded", () => {
  for (const state of [
    {
      status: "completed",
      input: { command: "ls" },
      output: "writeFileSync() > file",
    },
    {
      status: "error",
      input: { command: "ls" },
      error: "example: rm source.ts",
    },
    {
      status: "error",
      input: { command: "touch file" },
      error: "Model tried to call unavailable tool 'invalid'.",
    },
    {
      status: "error",
      input: { command: "touch file" },
      metadata: { approval: { rule: { action: "deny" } } },
    },
  ])
    assert.equal(
      fileMutation({
        type: "tool_use",
        part: { type: "tool", tool: "bash", state },
      }),
      false,
    );
  assert.equal(
    fileMutation({ type: "tool_result", output: { type: "file_change" } }),
    false,
  );
  assert.equal(
    fileMutation({
      type: "tool_use",
      part: {
        tool: "bash",
        state: {
          status: "error",
          input: { command: "printf partial > file; false" },
          error: "process exited 1",
        },
      },
    }),
    true,
  );
});

test("Claude requests and results are paired; confirmed mutations remain sticky after later denials", () => {
  const tracker = new MutationTracker();
  const request = (id: string) => ({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "Write",
          input: { file_path: "source.ts", content: "changed" },
        },
      ],
    },
  });
  tracker.observe(request("denied"));
  assert.equal(tracker.hasMutation, false);
  tracker.observe({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "denied",
          is_error: true,
          content: "ordinary error",
        },
      ],
    },
  });
  tracker.observe({
    type: "result",
    permission_denials: [{ tool_use_id: "denied" }],
  });
  assert.equal(tracker.finish(), false);
  tracker.observe(request("written"));
  tracker.observe({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "written", content: "done" },
      ],
    },
  });
  tracker.observe({
    type: "system",
    subtype: "permission_denied",
    tool_use_id: "written",
  });
  assert.equal(tracker.finish(), true);
  const partial = new MutationTracker();
  partial.observe(request("partial"));
  partial.observe({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "partial",
          is_error: true,
          content: "failed after updating first file",
        },
      ],
    },
  });
  assert.equal(partial.finish(), true);
});

test("Codex file/command events distinguish requests, explicit rejection and partial execution", () => {
  const tracker = new MutationTracker();
  tracker.observe({
    type: "item.started",
    item: { id: "change", type: "file_change" },
  });
  tracker.observe({
    type: "item.completed",
    item: {
      id: "change",
      type: "file_change",
      status: "failed",
      error: { message: "Tool call was denied before execution" },
    },
  });
  assert.equal(tracker.finish(), false);
  tracker.observe({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "printf changed > file",
      status: "failed",
      exit_code: 1,
    },
  });
  assert.equal(tracker.finish(), true);
});

test("sanitized events projected from the reported Kilo QA log contain no observed mutation", () => {
  const tracker = new MutationTracker();
  const fixture = path.resolve(
    __dirname,
    "../../../test/fixtures/qa-auth-regression.jsonl",
  );
  for (const line of fs.readFileSync(fixture, "utf8").trim().split("\n"))
    tracker.observe(JSON.parse(line));
  assert.equal(tracker.finish(), false);
});

test("command wrappers preserve write detection while stream-only tee remains nonmutating", () => {
  for (const command of [
    "sudo -n touch file",
    "sudo -u tester -n rm file",
    "/usr/bin/env FLAG=value touch file",
    "command -p touch file",
    "env -S 'touch file'",
    "sed --in-place=.bak source.ts",
  ])
    assert.equal(shellMutation(command), true, command);
  for (const command of [
    "sudo -n ls 2>/dev/null",
    "env FLAG=value ls",
    "tee /dev/null",
    "tee",
  ])
    assert.equal(shellMutation(command), false, command);
  const tracker = new MutationTracker();
  tracker.observe({
    type: "item.completed",
    item: {
      id: "observed",
      type: "file_change",
      status: "completed",
      metadata: { approval: { rule: { action: "deny" } } },
    },
  });
  assert.equal(tracker.finish(), true);
});
