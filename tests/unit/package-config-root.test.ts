import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  findPackagedConfigRoot,
  readPackagedConfigJson,
  resolvePackagedConfigRoot,
} from "../../src/config/package-config-root";

async function createPackageRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-packaged-config-"));
  await fs.mkdir(path.join(root, "config"));
  await fs.writeFile(path.join(root, "config", "agents.json"), "{}", "utf8");
  await fs.writeFile(path.join(root, "config", "protocol_contract.json"), JSON.stringify({ version: 3 }), "utf8");
  await fs.writeFile(path.join(root, "config", "runtime_defaults.json"), JSON.stringify({ marker: true }), "utf8");
  return root;
}

test("packaged config resolution is anchored to an explicit code root", async () => {
  const root = await createPackageRoot();
  try {
    assert.equal(resolvePackagedConfigRoot(root), path.join(root, "config"));
    assert.equal(findPackagedConfigRoot(path.join(root, "dist", "core")), path.join(root, "config"));
    assert.deepEqual(readPackagedConfigJson<{ marker: boolean }>("runtime_defaults.json", root), { marker: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("packaged config resolution fails closed for missing markers and unsafe filenames", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-packaged-config-invalid-"));
  try {
    await fs.mkdir(path.join(root, "config"));
    assert.throws(() => resolvePackagedConfigRoot(root), /missing required definition markers/u);
    assert.throws(() => findPackagedConfigRoot(root), /Unable to locate packaged config/u);
    await assert.throws(() => readPackagedConfigJson("../runtime_defaults.json", root), /Invalid packaged config filename/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
