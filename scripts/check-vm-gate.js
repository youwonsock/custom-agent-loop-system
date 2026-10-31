#!/usr/bin/env node
// Hosted macOS runners have no virtualization (kern.hv_support is 0), so CI cannot
// run verify:vm. A pull request that changes execution or isolation code states
// the local result in its body instead. Run by .github/workflows/vm-gate.yml.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const GUARDED =
  /^src\/core\/(?:program_io|invocation|kilo_|native_scope|process_|runtime)[^/]*\.ts$/;

function guardedFiles(files) {
  return files.filter(
    (file) => GUARDED.test(file) && !/\.test\.ts$/.test(file),
  );
}
/** The line must name the head commit, so a later push asks for a new run. */
function hasResult(body, headSha) {
  return String(body ?? "")
    .split(/\r?\n/)
    .some((line) => {
      const match = /verify:vm\s+(\d+)\/(\d+)\s+@\s*([0-9a-f]{7,40})/.exec(
        line,
      );
      return (
        !!match &&
        Number(match[2]) > 0 &&
        match[1] === match[2] &&
        headSha.startsWith(match[3])
      );
    });
}
function main() {
  const event = JSON.parse(
      fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    ),
    { base, head, body } = event.pull_request;
  const files = guardedFiles(
    execFileSync("git", ["diff", "--name-only", `${base.sha}...${head.sha}`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean),
  );
  if (!files.length) {
    console.log("No execution or isolation code changed.");
    return;
  }
  if (hasResult(body, head.sha)) {
    console.log("verify:vm result found for the head commit.");
    return;
  }
  console.error(
    `These files need npm run verify:vm on macOS:\n  ${files.join("\n  ")}\nAdd this line to the pull request body:\n  verify:vm <passed>/<total> @ ${head.sha.slice(0, 7)}`,
  );
  process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { guardedFiles, hasResult };
