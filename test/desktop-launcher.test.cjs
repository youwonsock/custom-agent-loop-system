const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const project = path.resolve(__dirname, "..");

function launch(root, port) {
  const child = spawn(process.execPath, [path.join(project, "scripts/desktop-launcher.js"), "--project", project, "--root", root, "--port", String(port), "--log", path.join(root, "launcher.log")], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let buffer = "";
  child.stdout.on("data", data => {
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
      const found = messages.find(m => m.state === state);
      if (found) return found;
      if (state !== "error" && messages.some(m => m.state === "error")) throw new Error(JSON.stringify(messages));
      await new Promise(resolve => setTimeout(resolve, 20));
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
  return { child, waitState, stop };
}

test("double-click helper builds, serves assets, reuses its existing server and safely stops only its own server", { timeout: 45_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-launcher-"));
  const first = launch(root, 0);
  t.after(async () => { await first.stop(); await fs.rm(root, { recursive: true, force: true }); });
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
});

test("an occupied foreign port is reported without stopping its owner", { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-launcher-foreign-"));
  const foreign = http.createServer((_request, response) => response.end("different service"));
  foreign.listen(0, "127.0.0.1");
  await once(foreign, "listening");
  const port = foreign.address().port;
  const launcher = launch(root, port);
  t.after(async () => { await launcher.stop(); await new Promise(resolve => foreign.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const error = await launcher.waitState("error");
  assert.match(error.message, /다른 서버/);
  await launcher.stop();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "different service");
});
