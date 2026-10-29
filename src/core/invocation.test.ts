import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createGraph } from "./graph";
import { buildInvocation } from "./invocation";

const fixture = path.resolve(__dirname, "../../../test/fixture_cli.cjs");
const implementation = createGraph().nodes.find((n) => n.type === "implementation")!;
const pathKeys = (env: Record<string, unknown>) => Object.keys(env).filter((k) => k.toUpperCase() === "PATH");

for (const spelling of ["PATH", "Path"]) {
  test(`a parent ${spelling} reaches the CLI and Codex shell as one complete PATH`, { skip: spelling !== "PATH" && process.platform !== "win32" ? "only Windows names are case-insensitive" : false }, async (t) => {
    const original = pathKeys(process.env)[0]!, inherited = process.env[original]!;
    assert.ok(inherited, "the test runner must have a PATH");
    if (original !== spelling) {
      delete process.env[original];
      process.env[spelling] = inherited;
      t.after(() => { delete process.env[spelling]; process.env[original] = inherited; });
    }
    assert.deepEqual(pathKeys(process.env), [spelling]);
    const expected = [path.dirname(process.execPath), inherited].join(path.delimiter);
    const invocation = await buildInvocation(
      { id: "fixture", label: "fixture", type: "codex", binary: fixture },
      { connectionId: "fixture", modelId: "fixture-model" },
      implementation,
      { prompt: "goal", cwd: process.cwd(), fullAccess: false, allowedPaths: [] },
    );
    assert.deepEqual(pathKeys(invocation.env), ["PATH"], "a duplicate spelling would leave the child's PATH ambiguous");
    assert.equal(invocation.env.PATH, expected);
    assert.ok(invocation.args.includes(`shell_environment_policy.set.PATH=${JSON.stringify(expected)}`), "the Codex shell must keep the inherited tools");
  });
}
