import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createGraph } from "../runtime/graph";
import { buildInvocation } from "./invocation";

const fixture = path.resolve(__dirname, "../../../../test/fixture_cli.cjs");
const implementation = createGraph().nodes.find(
  (n) => n.type === "implementation",
)!;
const pathKeys = (env: Record<string, unknown>) =>
  Object.keys(env).filter((k) => k.toUpperCase() === "PATH");

for (const spelling of ["PATH", "Path"]) {
  test(
    `a parent ${spelling} reaches the CLI and Codex shell as one complete PATH`,
    {
      skip:
        spelling !== "PATH" && process.platform !== "win32"
          ? "only Windows names are case-insensitive"
          : false,
    },
    async (t) => {
      const original = pathKeys(process.env)[0]!,
        inherited = process.env[original]!;
      assert.ok(inherited, "the test runner must have a PATH");
      if (original !== spelling) {
        delete process.env[original];
        process.env[spelling] = inherited;
        t.after(() => {
          delete process.env[spelling];
          process.env[original] = inherited;
        });
      }
      assert.deepEqual(pathKeys(process.env), [spelling]);
      const expected = [path.dirname(process.execPath), inherited].join(
        path.delimiter,
      );
      const invocation = await buildInvocation(
        { id: "fixture", label: "fixture", type: "codex", binary: fixture },
        { connectionId: "fixture", modelId: "fixture-model" },
        implementation,
        {
          prompt: "goal",
          cwd: process.cwd(),
          fullAccess: false,
          allowedPaths: [],
        },
      );
      assert.deepEqual(
        pathKeys(invocation.env),
        ["PATH"],
        "a duplicate spelling would leave the child's PATH ambiguous",
      );
      assert.equal(invocation.env.PATH, expected);
      assert.ok(
        invocation.args.includes(
          `shell_environment_policy.set.PATH=${JSON.stringify(expected)}`,
        ),
        "the Codex shell must keep the inherited tools",
      );
    },
  );
}

test("an automated Claude role gets its tools up front, and only when it can use them", async () => {
  const graph = createGraph();
  const args = async (
    type: string,
    options: Partial<Parameters<typeof buildInvocation>[3]>,
  ) =>
    (
      await buildInvocation(
        { id: "c", label: "c", type: "claude", binary: fixture },
        { connectionId: "c", modelId: "m" },
        graph.nodes.find((n) => n.type === type)!,
        {
          prompt: "goal",
          cwd: process.cwd(),
          fullAccess: false,
          allowedPaths: [],
          ...options,
        },
      )
    ).args;
  const unattended = { claudeUnattended: { browserVerification: true } };
  const tools = (list: string[]) => list[list.indexOf("--allowedTools") + 1]!;

  const builder = await args("implementation", unattended);
  assert.match(tools(builder), /^Edit,Write,/);
  assert.match(tools(builder), /Bash\(npm:\*\)/);
  const sandbox = JSON.parse(builder[builder.indexOf("--settings") + 1]!);
  assert.equal(sandbox.sandbox.network.allowLocalBinding, true);
  assert.match(sandbox.sandbox.excludedCommands[0], /verify-browser/);

  const tester = await args("test", {
    ...unattended,
    verificationCommands: ["python3 -m pytest"],
  });
  assert.doesNotMatch(tools(tester), /Edit|Write|Bash\(npm:\*\)/);
  assert.match(tools(tester), /Bash\(python3 -m pytest\)/);

  const noBrowser = await args("test", {
    claudeUnattended: { browserVerification: false },
  });
  assert.equal(
    JSON.parse(noBrowser[noBrowser.indexOf("--settings") + 1]!).sandbox
      .excludedCommands,
    undefined,
  );

  for (const list of [
    await args("planning", unattended),
    await args("implementation", {}),
    await args("implementation", { ...unattended, fullAccess: true }),
  ]) {
    assert.ok(!list.includes("--allowedTools"));
    assert.ok(!list.includes("--settings"));
  }
});
