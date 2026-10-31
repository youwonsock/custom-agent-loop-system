const test = require("node:test");
const assert = require("node:assert/strict");
const { guardedFiles, hasResult } = require("../../scripts/check-vm-gate.js");

test("only execution and isolation source files need a VM result", () => {
  assert.deepEqual(
    guardedFiles([
      "src/core/program_io.ts",
      "src/core/program_io_vm.ts",
      "src/core/invocation_kilo.ts",
      "src/core/runtime_gates.ts",
      "src/core/process_supervisor.ts",
      "src/core/program_io.test.ts",
      "src/core/completion.ts",
      "docs/STATUS.md",
      "web/src/App.tsx",
    ]),
    [
      "src/core/program_io.ts",
      "src/core/program_io_vm.ts",
      "src/core/invocation_kilo.ts",
      "src/core/runtime_gates.ts",
      "src/core/process_supervisor.ts",
    ],
  );
});

test("a VM result counts only when complete and for the head commit", () => {
  const head = "abc1234def5678";
  assert.equal(hasResult("검증\nverify:vm 17/17 @ abc1234\n", head), true);
  assert.equal(hasResult("- `verify:vm 17/17 @ abc1234def`", head), true);
  assert.equal(hasResult("verify:vm 16/17 @ abc1234", head), false);
  assert.equal(hasResult("verify:vm 0/0 @ abc1234", head), false);
  assert.equal(hasResult("verify:vm 17/17 @ 0000000", head), false);
  assert.equal(hasResult("verify:vm 통과", head), false);
  assert.equal(hasResult(null, head), false);
});
