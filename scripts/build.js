const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
for (const [command, args] of [
  ["node_modules/typescript/bin/tsc", ["-p", "tsconfig.json"]],
  ["node_modules/typescript/bin/tsc", ["-p", "web/tsconfig.json", "--noEmit"]],
  [
    "node_modules/vite/bin/vite.js",
    ["build", "--config", "web/vite.config.mts"],
  ],
]) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, command), ...args],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
fs.writeFileSync(
  path.join(root, "dist", ".npmignore"),
  "**/*.test.js\n**/*.map\n",
  "utf8",
);
for (const name of fs.readdirSync(path.join(root, "dist", "web", "assets"))) {
  if (name.endsWith(".js") && fs.statSync(path.join(root, "dist", "web", "assets", name)).size > 500_000)
    throw new Error(`Web JavaScript chunk exceeds 500 kB: ${name}`);
}
