import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  prepareVerificationCaptures,
  addCapturedEnvironmentDiagnostics,
} from "./verification_capture";
import { CommandReceipt } from "../shared/domain";
const command = "npm test > verification/model-tests.txt 2>&1";
async function workspace(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "captured-diagnostic-"));
  await fs.mkdir(path.join(root, "verification"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test("fresh owned failed capture supplies hashed environment diagnostics without changing the actual exit", async (t) => {
  const root = await workspace(t),
    baseline = await prepareVerificationCaptures(root, [command]);
  await fs.writeFile(
    path.join(root, "verification/model-tests.txt"),
    "✖ http:bind\n  Error: listen EPERM: operation not permitted 127.0.0.1\n",
  );
  const archive = path.join(root, "archive"),
    r: CommandReceipt = {
      id: "native",
      command,
      exitCode: 1,
      environmentError: null,
    };
  await addCapturedEnvironmentDiagnostics([r], baseline, archive);
  assert.equal(r.exitCode, 1);
  assert.match(r.environmentError!, /listen EPERM/);
  assert.match(
    r.environmentError!,
    /capture verification\/model-tests.txt; sha256 [a-f0-9]{64}/,
  );
  const entry = JSON.parse(
    (await fs.readFile(path.join(archive, "index.jsonl"), "utf8")).trim(),
  );
  await fs.writeFile(
    path.join(root, "verification/model-tests.txt"),
    "a later successful rerun\n",
  );
  assert.match(
    await fs.readFile(path.join(archive, entry.file), "utf8"),
    /listen EPERM/,
  );
  assert.equal(entry.exitCode, 1);
});
test("stale logs, successful/unexecuted/masked/unregistered checks and quoted error text never become environmental proof", async (t) => {
  const root = await workspace(t),
    file = path.join(root, "verification/model-tests.txt");
  await fs.writeFile(file, "Error: listen EPERM\n");
  const baseline = await prepareVerificationCaptures(root, [command]);
  const old: CommandReceipt = {
    id: "old",
    command,
    exitCode: 1,
    environmentError: null,
  };
  await addCapturedEnvironmentDiagnostics([old], baseline);
  assert.equal(old.environmentError, null);
  await fs.writeFile(file + ".new", "Error: listen EPERM\n");
  await fs.rename(file + ".new", file);
  for (const [cmd, exit] of [
    [command, 0],
    [command, null],
    [command + " || true", 1],
    ["node --test > verification/other.txt 2>&1", 1],
  ] as const) {
    const receipt: CommandReceipt = {
      id: "case",
      command: cmd,
      exitCode: exit,
      environmentError: null,
    };
    await addCapturedEnvironmentDiagnostics([receipt], baseline);
    assert.equal(receipt.environmentError, null);
    assert.equal(receipt.exitCode, exit);
  }
  const newer = await prepareVerificationCaptures(root, [command]);
  await fs.writeFile(
    file + ".new",
    "AssertionError: expected 'listen EPERM' but got a different message\n",
  );
  await fs.rename(file + ".new", file);
  const product: CommandReceipt = {
    id: "product",
    command,
    exitCode: 1,
    environmentError: null,
  };
  await addCapturedEnvironmentDiagnostics([product], newer);
  assert.equal(product.environmentError, null);
});
test("symlinks, hardlinks, outside paths and oversized captures cannot be read as verification diagnostics", async (t) => {
  const root = await workspace(t),
    file = path.join(root, "verification/model-tests.txt"),
    secret = path.join(root, "outside.txt");
  await fs.writeFile(secret, "Error: listen EPERM\n");
  const before = await prepareVerificationCaptures(root, [command]);
  if (process.platform !== "win32") {
    await fs.symlink(secret, file);
    const r: CommandReceipt = {
      id: "link",
      command,
      exitCode: 1,
      environmentError: null,
    };
    await addCapturedEnvironmentDiagnostics([r], before);
    assert.equal(r.environmentError, null);
    await fs.rm(file);
  }
  await fs.link(secret, file);
  const r: CommandReceipt = {
    id: "hardlink",
    command,
    exitCode: 1,
    environmentError: null,
  };
  await addCapturedEnvironmentDiagnostics([r], before);
  assert.equal(r.environmentError, null);
  await fs.rm(file);
  await fs.writeFile(
    file,
    "Error: listen EPERM\n" + "x".repeat(2 * 1024 * 1024),
  );
  await addCapturedEnvironmentDiagnostics([r], before);
  assert.equal(r.environmentError, null);
  assert.deepEqual(
    await prepareVerificationCaptures(root, [
      "npm test > ../outside.log 2>&1",
      "npm test > outside.txt 2>&1",
    ]),
    [],
  );
});
