import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

/** Already confined. Even scratch creation is subject to the kernel policy. */
const input = JSON.parse(
  Buffer.from(process.argv[2] ?? "", "base64url").toString(),
) as { command: string; scratch: string };
for (const name of ["home", "tmp", "npm-cache"])
  fs.mkdirSync(path.join(input.scratch, name), {
    recursive: true,
    mode: 0o700,
  });
const child = spawn("/bin/sh", ["-c", input.command], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 125;
});
child.once("close", (code) => {
  process.exitCode = code ?? 128;
});
