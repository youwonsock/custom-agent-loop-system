const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const {
  ensureDependencies,
  markerPath,
  acquireSetupLock,
} = require("../../scripts/launcher-environment");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-deps-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = {
    dependencies: { "node-pty": "1.0.0" },
    devDependencies: { typescript: "1.0.0", vite: "1.0.0" },
  };
  const packages = Object.fromEntries(
    ["node-pty", "typescript", "vite"].map((name) => [
      `node_modules/${name}`,
      { version: "1.0.0" },
    ]),
  );
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({ packages }),
  );
  let installs = 0;
  const install = async () => {
    installs++;
    for (const name of ["node-pty", "typescript", "vite"]) {
      const dir = path.join(root, "node_modules", name);
      await fs.mkdir(path.join(dir, "bin"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ version: "1.0.0", main: "index.js" }),
      );
      await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};");
    }
    await fs.writeFile(path.join(root, "node_modules/typescript/bin/tsc"), "");
    await fs.writeFile(path.join(root, "node_modules/vite/bin/vite.js"), "");
  };
  return { root, install, installs: () => installs };
}
test("cold install and unchanged restart, lockfile/runtime changes and missing or incorrect packages", async (t) => {
  const f = await fixture(t);
  assert.equal(await ensureDependencies(f.root, f.install), true);
  assert.equal(await ensureDependencies(f.root, f.install), false);
  assert.equal(f.installs(), 1);
  await fs.appendFile(path.join(f.root, "package-lock.json"), "\n");
  assert.equal(await ensureDependencies(f.root, f.install), true);
  const marker = JSON.parse(await fs.readFile(markerPath(f.root), "utf8"));
  await fs.writeFile(
    markerPath(f.root),
    JSON.stringify({ ...marker, abi: "old" }),
  );
  assert.equal(await ensureDependencies(f.root, f.install), true);
  await fs.rm(path.join(f.root, "node_modules/vite"), { recursive: true });
  assert.equal(await ensureDependencies(f.root, f.install), true);
  await fs.writeFile(
    path.join(f.root, "node_modules/node-pty/package.json"),
    '{"version":"0.0.0"}',
  );
  assert.equal(await ensureDependencies(f.root, f.install), true);
  assert.equal(f.installs(), 5);
});
test("failed, invalid and cancelled installs cannot publish a marker and can be retried", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    ensureDependencies(f.root, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  await assert.rejects(fs.access(markerPath(f.root)));
  await assert.rejects(
    ensureDependencies(f.root, async () => {}),
    /설치 버전/,
  );
  const controller = new AbortController();
  await assert.rejects(
    ensureDependencies(
      f.root,
      async () => {
        await f.install();
        controller.abort();
      },
      controller.signal,
    ),
  );
  await assert.rejects(fs.access(markerPath(f.root)));
  assert.equal(await ensureDependencies(f.root, f.install), true);
});
test("native loading failure invalidates an otherwise matching installation", async (t) => {
  const f = await fixture(t);
  await ensureDependencies(f.root, f.install);
  await fs.writeFile(
    path.join(f.root, "node_modules/node-pty/index.js"),
    'throw new Error("native ABI mismatch");',
  );
  assert.equal(await ensureDependencies(f.root, f.install), true);
  assert.equal(f.installs(), 2);
});
test("setup lock serializes contenders and cancellation leaves the owner intact", async (t) => {
  const f = await fixture(t);
  const first = await acquireSetupLock(f.root);
  let entered = false;
  const second = acquireSetupLock(f.root).then((lock) => {
    entered = true;
    return lock;
  });
  const controller = new AbortController();
  const cancelled = acquireSetupLock(f.root, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(entered, false);
  first.release();
  (await second).release();
  await assert.rejects(fs.access(path.join(f.root, ".agent-graph-setup.lock")));
});
test("dead owners are recovered once but their living setup children remain protected", async (t) => {
  const f = await fixture(t);
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => child.kill());
  const lockFile = path.join(f.root, ".agent-graph-setup.lock");
  await fs.writeFile(
    lockFile,
    JSON.stringify({ id: "dead", pid: deadPid, childPid: child.pid }),
  );
  await assert.rejects(
    acquireSetupLock(f.root, { timeoutMs: 100 }),
    /다른 실행기/,
  );
  const closed = once(child, "exit");
  child.kill();
  await closed;
  let active = 0,
    maximum = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      const lock = await acquireSetupLock(f.root);
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      lock.release();
    }),
  );
  assert.equal(maximum, 1);
});
