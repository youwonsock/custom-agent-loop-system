const pty = require("node-pty");

const shell = process.env.ComSpec || "cmd.exe";
const child = pty.spawn(shell, ["/d", "/c", "echo agent-loop-pty-smoke"], {
  name: "xterm-color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let output = "";
child.onData((chunk) => { output += chunk; });
child.onExit(({ exitCode }) => {
  if (exitCode !== 0 || !output.includes("agent-loop-pty-smoke")) {
    console.error(`node-pty smoke failed (exit ${exitCode}): ${output}`);
    process.exit(1);
    return;
  }
  process.stdout.write("Electron node-pty smoke passed.\n", () => process.exit(0));
});
