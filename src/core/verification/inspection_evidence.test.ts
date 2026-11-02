import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InspectionTracker } from "./inspection_evidence";
const cwd = path.resolve("owned project"),
  file = "test/controller.test.mjs";
test("completed native reads and exact read commands prove inspection; prose, failures and other directories do not", () => {
  const t = new InspectionTracker(cwd);
  t.observe({ type: "text", part: { text: `read ${file}` } });
  t.observe({
    type: "tool_use",
    part: {
      tool: "read",
      state: { status: "error", input: { filePath: file } },
    },
  });
  t.observe({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: `cat ${file} | head`,
      exit_code: 0,
    },
  });
  t.observe({
    type: "item.completed",
    item: { type: "command_execution", command: `cat ${file}`, exit_code: 1 },
  });
  assert.deepEqual(t.files, []);
  t.observe({
    type: "tool_use",
    part: {
      tool: "read",
      state: { status: "completed", input: { filePath: path.join(cwd, file) } },
    },
  });
  t.observe({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "Get-Content verification/node-tests/report.json",
      exit_code: 0,
    },
  });
  assert.deepEqual(t.files, [file, "verification/node-tests/report.json"]);
  t.observe({
    type: "tool_use",
    part: {
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: path.resolve(cwd, "../outside") },
      },
    },
  });
  assert.equal(t.files.length, 2);
});
test("Claude inspection requires the matching successful native Read result", () => {
  const t = new InspectionTracker(cwd);
  t.observe({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { file_path: file },
        },
      ],
    },
  });
  assert.deepEqual(t.files, []);
  t.observe({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "read",
          is_error: false,
          content: "actual source",
        },
      ],
    },
  });
  assert.deepEqual(t.files, [file]);
});
test("Kilo and OpenCode shell inspection needs a completed exit-zero standalone read", () => {
  const t = new InspectionTracker(cwd);
  const event = (command: string, status: string, exit: number) => ({
    type: "tool_use",
    part: {
      tool: "bash",
      state: { status, input: { command }, metadata: { exit } },
    },
  });
  t.observe(event(`cat ${file}`, "error", 0));
  t.observe(event(`cat ${file}`, "completed", 1));
  t.observe(event(`cat ${file} | head -100`, "completed", 0));
  assert.deepEqual(t.files, []);
  t.observe(event(`cd "${cwd}" && cat ${file}`, "completed", 0));
  t.observe(
    event(
      "Get-Content -literalpath verification/node-tests/report.json -raw",
      "completed",
      0,
    ),
  );
  assert.deepEqual(t.files, [file, "verification/node-tests/report.json"]);
});
test("read bundles count each file only when the exit code or the file itself proves it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inspection-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "README.md"), "docs");
  await fs.writeFile(path.join(root, "slug.mjs"), "code");
  await fs.mkdir(path.join(root, "folder"));
  const read = (command: string, exit = 0) => {
    const tracker = new InspectionTracker(root);
    tracker.observe({
      type: "tool_use",
      part: {
        tool: "bash",
        state: {
          status: "completed",
          input: { command },
          metadata: { exit },
        },
      },
    });
    return tracker.files;
  };
  const both = ["README.md", "slug.mjs"];
  for (const command of [
    "cat README.md; echo '---'; cat slug.mjs",
    'cat README.md && echo "--- code ---" && cat slug.mjs',
    "cat README.md; cat slug.mjs",
    "cat README.md && printf '\\n' && cat slug.mjs",
    `cd "${root}" && cat README.md slug.mjs`,
  ])
    assert.deepEqual(read(command), both, command);
  // Only the exit code of the last part is known.
  assert.deepEqual(read("cat gone.md; cat slug.mjs"), ["slug.mjs"]);
  assert.deepEqual(read("cat folder; cat slug.mjs"), ["slug.mjs"]);
  assert.deepEqual(read("cat gone.md && cat slug.mjs"), [
    "gone.md",
    "slug.mjs",
  ]);
  for (const command of [
    "cat README.md | head -5; cat slug.mjs",
    "cat README.md > copy; cat slug.mjs",
    "cat README.md; rm slug.mjs; cat slug.mjs",
    "cat README.md; echo $(rm slug.mjs)",
    "cat README.md; cd other; cat slug.mjs",
    "cat README.md || cat slug.mjs",
    "cat -n README.md; cat slug.mjs",
    "cat README.md\ncat slug.mjs",
  ])
    assert.deepEqual(read(command), [], command);
  assert.deepEqual(read("cat README.md; cat slug.mjs", 1), []);
});
