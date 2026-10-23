const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");

async function main() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run through npm run pack:smoke.");
  const repo = path.resolve(__dirname, "..");
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-graph-installed-"),
  );
  let server;
  try {
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [
          npmCli,
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          temporary,
        ],
        { cwd: repo, encoding: "utf8" },
      ),
    );
    const archive = path.join(temporary, report[0].filename);
    await fs.writeFile(
      path.join(temporary, "package.json"),
      '{"private":true}\n',
    );
    execFileSync(
      process.execPath,
      [
        npmCli,
        "install",
        "--omit=dev",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        archive,
      ],
      { cwd: temporary, stdio: "pipe" },
    );
    const installed = path.join(
      temporary,
      "node_modules",
      "custom-agent-loop-system",
    );
    const cli = path.join(installed, "dist", "src", "server", "cli.js");
    const help = execFileSync(process.execPath, [cli, "--help"], {
      encoding: "utf8",
    });
    if (!help.includes("Agent Graph Studio 4.0.0"))
      throw new Error("Installed CLI failed.");
    const { queryModels } = require(
      path.join(installed, "dist", "src", "core", "catalog.js"),
    );
    const project = path.join(temporary, "project");
    await fs.mkdir(project);
    for (const type of ["codex", "claude", "opencode", "kilo"]) {
      const result = await queryModels(
        {
          id: type,
          label: type,
          type,
          binary: path.join(repo, "test", "fixture_cli.cjs"),
        },
        project,
        { timeoutMs: 5000 },
      );
      if (result.status !== "ready")
        throw new Error(`Installed ${type} query failed: ${result.error}`);
    }
    server = spawn(
      process.execPath,
      [
        cli,
        "ui",
        "--root",
        path.join(temporary, "workspace"),
        "--port",
        "0",
        "--no-open",
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const url = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Installed UI startup timed out.")),
        10000,
      );
      server.stdout.on("data", (b) => {
        output += b.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      server.once("error", reject);
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Installed server exited during startup."));
      });
    });
    const html = await (await fetch(url)).text();
    if (!html.includes("Agent Graph Studio") || !html.includes("/assets/"))
      throw new Error("Installed web assets are missing.");
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) {
      const asset = await fetch(url + match[1]);
      if (!asset.ok || !(await asset.arrayBuffer()).byteLength)
        throw new Error("Installed web asset cannot be served: " + match[1]);
    }
    // Lazy chunks are not referenced by the entry HTML; verify the entire installed asset set.
    for (const name of await fs.readdir(path.join(installed, "dist", "web", "assets"))) {
      if (!/\.(js|css)$/.test(name)) continue;
      const asset = await fetch(`${url}/assets/${name}`);
      const local = await fs.readFile(path.join(installed, "dist", "web", "assets", name));
      if (!asset.ok || !Buffer.from(await asset.arrayBuffer()).equals(local))
        throw new Error(`Installed lazy asset is missing or incorrect: ${name}`);
    }
    const bootstrap = await (await fetch(url + "/api/bootstrap")).json();
    if (
      bootstrap.graphs[0]?.version !== 2 ||
      bootstrap.connections.length !== 0
    )
      throw new Error("Installed workspace initialization failed.");
    let shutdownTimer;
    const stopped = once(server, "exit");
    server.send({ type: "shutdown" });
    try {
      await Promise.race([
        stopped,
        new Promise((_, reject) => {
          shutdownTimer = setTimeout(
            () => reject(new Error("Installed server shutdown timed out.")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(shutdownTimer);
    }
    if (server.exitCode !== 0)
      throw new Error("Installed server shutdown failed.");
    process.stdout.write(
      "Installed npm package verified: CLI, web assets, workspace, four model APIs, SDK without bundled CLI, graceful shutdown.\n",
    );
  } finally {
    if (server && server.exitCode === null && server.signalCode === null)
      server.kill("SIGKILL");
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
