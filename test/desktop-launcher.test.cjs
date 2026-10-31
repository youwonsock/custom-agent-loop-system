const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const project = path.resolve(__dirname, "..");
const launcherBinary = path.join(
  project,
  "Agent Graph Studio.app/Contents/MacOS/AgentGraphStudio",
);

async function executable(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function chosenNode(shell, pathEntries) {
  const started = Date.now();
  const result = spawnSync(launcherBinary, ["--print-node"], {
    encoding: "utf8",
    timeout: 15_000,
    env: { SHELL: shell, PATH: pathEntries.join(":") },
  });
  assert.equal(result.status, 0, result.stderr);
  return { node: result.stdout.trim(), elapsed: Date.now() - started };
}

test("the app prefers the login shell Node and uses Homebrew only as a fallback", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "graph-launcher-node-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const version = "echo 24.22.2";
  const official = await executable(path.join(root, "official/node"), version);
  const other = await executable(path.join(root, "other/node"), version);
  const old = await executable(path.join(root, "old/node"), "echo 22.0.0");
  const cellar = await executable(
    path.join(root, "Cellar/node/25.2.1/bin/node"),
    "echo 25.2.1",
  );
  const brewNode = path.join(root, "brew/node");
  await fs.mkdir(path.dirname(brewNode));
  await fs.symlink(cellar, brewNode);
  const shellFor = (name, node) =>
    executable(path.join(root, name), `echo profile noise; echo ${node}`);
  const entries = (...files) => files.map((file) => path.dirname(file));

  assert.equal(
    chosenNode(await shellFor("shell-official", official), [
      ...entries(brewNode, other),
    ]).node,
    official,
  );
  assert.equal(
    chosenNode(await shellFor("shell-brew", brewNode), entries(brewNode, other))
      .node,
    other,
    "a Homebrew Node is passed over while another supported Node exists",
  );
  assert.equal(
    chosenNode(await shellFor("shell-old", old), entries(other)).node,
    other,
    "a login shell Node below the required version is passed over",
  );
  const silent = await executable(path.join(root, "shell-alias"), "echo alias");
  assert.equal(chosenNode(silent, entries(other)).node, other);
  const hanging = await executable(
    path.join(root, "shell-hang"),
    "exec /bin/sleep 30",
  );
  const late = chosenNode(hanging, entries(other));
  assert.equal(late.node, other);
  assert.ok(
    late.elapsed >= 2_500 && late.elapsed < 10_000,
    `waited ${late.elapsed} ms for the shell`,
  );
});

function launch(root, port, source = project) {
  const child = spawn(
    process.execPath,
    [
      path.join(project, "scripts/desktop-launcher.js"),
      "--project",
      source,
      "--root",
      root,
      "--port",
      String(port),
      "--log",
      path.join(root, "launcher.log"),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const messages = [];
  let buffer = "";
  child.stdout.on("data", (data) => {
    buffer += data.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const waitState = async (state) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const found = messages.find((m) => m.state === state);
      if (found) return found;
      if (state !== "error" && messages.some((m) => m.state === "error"))
        throw new Error(JSON.stringify(messages));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${JSON.stringify(messages)}`);
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.stdin.write("shutdown\n");
    const timer = setTimeout(() => child.kill("SIGKILL"), 17_000);
    await exited;
    clearTimeout(timer);
    assert.equal(child.exitCode, 0);
  };
  return { child, messages, waitState, stop };
}

test(
  "double-click helper builds, serves assets, reuses its existing server and safely stops only its own server",
  { timeout: 45_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-launcher-"));
    const first = launch(root, 0);
    t.after(async () => {
      await first.stop();
      await fs.rm(root, { recursive: true, force: true });
    });
    const ready = await first.waitState("ready");
    assert.equal(ready.owned, true);
    const bootstrap = await (await fetch(ready.url + "/api/bootstrap")).json();
    assert.equal(bootstrap.root, root);
    assert.equal(bootstrap.graphs[0].version, 2);
    const html = await (await fetch(ready.url)).text();
    assert.match(html, /Agent Graph Studio/);
    const asset = html.match(/src="(\/assets\/[^"]+)"/)[1];
    assert.equal((await fetch(ready.url + asset)).status, 200);
    const second = launch(root, Number(new URL(ready.url).port));
    t.after(second.stop);
    const reused = await second.waitState("ready");
    assert.equal(reused.owned, false);
    await second.stop();
    assert.equal((await fetch(ready.url)).status, 200);
    await first.stop();
    await assert.rejects(() => fetch(ready.url));
  },
);

test(
  "an occupied foreign port is reported without stopping its owner",
  { timeout: 10_000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "graph-launcher-foreign-"),
    );
    const foreign = http.createServer((_request, response) =>
      response.end("different service"),
    );
    foreign.listen(0, "127.0.0.1");
    await once(foreign, "listening");
    const port = foreign.address().port;
    const launcher = launch(root, port);
    t.after(async () => {
      await launcher.stop();
      await new Promise((resolve) => foreign.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    });
    const error = await launcher.waitState("error");
    assert.match(error.message, /다른 서버/);
    await launcher.stop();
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      "different service",
    );
  },
);

test(
  "simultaneous launchers reuse one server after serialized setup",
  { timeout: 45_000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "graph-launcher-race-"),
    );
    const socket = http.createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const first = launch(root, port),
      second = launch(root, port);
    t.after(async () => {
      await first.stop();
      await second.stop();
      await fs.rm(root, { recursive: true, force: true });
    });
    const results = await Promise.all([
      first.waitState("ready"),
      second.waitState("ready"),
    ]);
    assert.deepEqual(results.map((r) => r.owned).sort(), [false, true]);
    assert.equal(results[0].url, results[1].url);
    assert.equal(
      [...first.messages, ...second.messages].filter((m) =>
        m.message.includes("패키지를 설치"),
      ).length,
      0,
    );
  },
);

test(
  "stopping during setup terminates its child and releases initialization ownership",
  { timeout: 15_000 },
  async (t) => {
    const source = await fs.mkdtemp(
      path.join(os.tmpdir(), "graph-launcher-cancel-"),
    );
    t.after(() => fs.rm(source, { recursive: true, force: true }));
    await fs.cp(
      path.join(project, "package.json"),
      path.join(source, "package.json"),
    );
    await fs.cp(
      path.join(project, "package-lock.json"),
      path.join(source, "package-lock.json"),
    );
    // Isolate generated files while reusing the already validated installation.
    await fs.symlink(
      path.join(project, "node_modules"),
      path.join(source, "node_modules"),
      "dir",
    );
    await fs.mkdir(path.join(source, "scripts"));
    await fs.writeFile(
      path.join(source, "scripts/build.js"),
      "require('node:fs').writeFileSync('setup.pid', String(process.pid)); setInterval(() => {}, 1000);",
    );
    const launcher = launch(source, 0, source);
    t.after(launcher.stop);
    const deadline = Date.now() + 7000;
    while (
      !(await fs.stat(path.join(source, "setup.pid")).catch(() => null)) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 20));
    const pid = Number(
      await fs.readFile(path.join(source, "setup.pid"), "utf8"),
    );
    await launcher.stop();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(
      fs.access(path.join(source, ".agent-graph-setup.lock")),
    );
    assert.equal(
      launcher.messages.some((m) => m.state === "ready"),
      false,
    );
  },
);
