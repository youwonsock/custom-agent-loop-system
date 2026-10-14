const { spawn, spawnSync } = require("node:child_process");
const compiled = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
  { stdio: "inherit" },
);
if (compiled.status) process.exit(compiled.status);
const backend = spawn(
  process.execPath,
  [
    "dist/src/server/cli.js",
    "ui",
    "--no-open",
    "--dev-origin",
    "http://127.0.0.1:5173",
  ],
  { stdio: "inherit" },
);
const frontend = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--config", "web/vite.config.mts"],
  { stdio: "inherit" },
);
const stop = () => {
  backend.kill();
  frontend.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
