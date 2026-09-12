import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs, runCliApplication } from "../../src/interfaces/cli/application";

test("CLI parser preserves flag, value, and equals syntax", () => {
  assert.deepEqual(
    parseCliArgs(["--root", "C:\\data", "--full-access", "--session=id-1", "ignored"]),
    {
      root: "C:\\data",
      "full-access": "true",
      session: "id-1",
    }
  );
});

test("CLI application prepares context once and dispatches the selected command", async () => {
  const events: string[] = [];
  const exitCode = await runCliApplication(["run", "--goal", "ship"], {
    printUsage: () => events.push("usage"),
    prepare: async (command, options) => {
      events.push(`prepare:${command}:${options.goal}`);
      return "context";
    },
    handlers: {
      run: async (options, context) => {
        events.push(`run:${context}:${options.goal}`);
      },
    },
    reportUnknown: (command) => events.push(`unknown:${command}`),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, ["prepare:run:ship", "run:context:ship"]);
});

test("CLI application handles help and unknown commands without dispatch", async () => {
  let prepared = 0;
  let usages = 0;
  const dependencies = {
    printUsage: () => {
      usages++;
    },
    prepare: async () => {
      prepared++;
      return undefined;
    },
    handlers: {},
    reportUnknown: () => undefined,
  };

  assert.equal(await runCliApplication(["--help"], dependencies), 0);
  assert.equal(await runCliApplication(["unknown"], dependencies), 1);
  assert.equal(prepared, 1);
  assert.equal(usages, 2);
});

