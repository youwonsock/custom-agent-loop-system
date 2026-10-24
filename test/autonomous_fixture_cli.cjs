#!/usr/bin/env node
// A deterministic coding CLI fixture; executes real browser checks, never a model API.
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] !== "exec") {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, "fixture_cli.cjs"), ...args],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}
const emit = (e) => process.stdout.write(JSON.stringify(e) + "\n"),
  prompt = args.at(-1),
  type = prompt.match(/Execution type: (\w+)/)?.[1];
fs.mkdirSync("verification", { recursive: true });
let calls = {};
try {
  calls = JSON.parse(fs.readFileSync("verification/fixture-calls.json"));
} catch {}
calls[type] = (calls[type] || 0) + 1;
fs.writeFileSync("verification/fixture-calls.json", JSON.stringify(calls));
const reqs = [
  ...new Set([...prompt.matchAll(/^REQ-\d+:/gm)].map((m) => m[0].slice(0, -1))),
];
const {
  browserVerificationCommand,
} = require("../dist/src/core/browser_command.js");
let verdict = "SATISFIED",
  text = "",
  check = browserVerificationCommand();
if (type === "planning")
  text = `## OPTION 1: Build and independently verify\n${reqs.join(", ")}\nFiles: server.cjs, index.html, styles.css, .agent-graph/browser.json\nSteps: implement, run actual browser assertions, repair, review and approve.\nRisks: browser prerequisites remain required.`;
if (type === "implementation") {
  fs.writeFileSync(
    "server.cjs",
    `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const server=http.createServer((req,res)=>{const file=req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','styles.css'].includes(file)){res.writeHead(404);res.end('missing');return;}res.setHeader('Content-Type',file.endsWith('css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(__dirname,file)));});server.listen(Number(process.env.PORT||0),'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));process.on('SIGTERM',()=>server.close());`,
  );
  fs.writeFileSync(
    "styles.css",
    `body{margin:0}#board{width:${calls.implementation === 1 ? 900 : 320}px;display:grid;grid-template-columns:repeat(4,1fr);gap:4px} .cell{height:40px;background:#ddd}`,
  );
  fs.writeFileSync(
    "index.html",
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><h1>Autonomous browser fixture</h1><div id="board">${Array.from({ length: 16 }, (_, i) => '<div class="cell">' + i + "</div>").join("")}</div><button id="move">Move</button><output id="score"></output><script>let score=Number(localStorage.getItem('score')||0);document.querySelector('#score').textContent=score;document.querySelector('#move').onclick=()=>{score++;localStorage.setItem('score',score);document.querySelector('#score').textContent=score};</script></body></html>`,
  );
  fs.mkdirSync(".agent-graph", { recursive: true });
  fs.writeFileSync(
    ".agent-graph/browser.json",
    JSON.stringify({
      version: 1,
      server: { command: ["node", "server.cjs"] },
      steps: [
        { id: "page", type: "visible", selector: "h1" },
        { id: "cells", type: "count", selector: ".cell", equals: 16 },
        { id: "mobile", type: "viewport", width: 390, height: 844 },
        { id: "overflow", type: "noOverflow" },
        { id: "fit", type: "within", selector: ".cell", container: "#board" },
        { id: "button", type: "click", selector: "#move" },
        { id: "score", type: "text", selector: "#score", equals: "1" },
        { id: "save", type: "snapshot", name: "score", selector: "#score" },
        { id: "reload", type: "reload" },
        {
          id: "persist",
          type: "sameSnapshot",
          name: "score",
          selector: "#score",
        },
        { id: "errors", type: "noConsoleErrors" },
      ],
    }),
  );
  emit({
    type: "item.completed",
    item: {
      id: "files",
      type: "file_change",
      status: "completed",
      changes: [{ path: "styles.css", kind: "update" }],
    },
  });
  text = "Implemented the actual target web app and its acceptance spec.";
}
if (type === "test") {
  const cli = path.resolve(__dirname, "../dist/src/server/cli.js");
  emit({
    type: "item.started",
    item: {
      id: "real-browser",
      type: "command_execution",
      command: check,
      status: "in_progress",
    },
  });
  const r = spawnSync(
    process.execPath,
    [cli, "verify-browser", "--spec", ".agent-graph/browser.json"],
    { encoding: "utf8" },
  );
  emit({
    type: "item.completed",
    item: {
      id: "real-browser",
      type: "command_execution",
      command: check,
      exit_code: r.status,
      status: "completed",
      aggregated_output: r.stdout + r.stderr,
    },
  });
  verdict = r.status === 0 ? "SATISFIED" : "FAILED";
  text = r.status === 0 ? "VERDICT: PASS" : "VERDICT: FAIL";
}
if (["review", "approval"].includes(type)) {
  const proof = prompt
    .split("=== NATIVE VERIFICATION RECEIPTS")[1]
    ?.split("=== REQUIREMENT")[0];
  if (!proof?.includes('"exitCode":0'))
    throw Error("Read-only audit did not receive real test proof");
  text = "APPROVED";
}
if (type !== "planning")
  text =
    reqs
      .map(
        (id) =>
          `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${id}\nSTATUS: ${verdict}\nEVIDENCE: Real generated-server browser assertions; a product overflow failure remains a failure until repair.\nCHECK_COMMAND: ${check}\n[/REQUIREMENT_EVIDENCE]`,
      )
      .join("\n") +
    "\n" +
    text;
emit({
  type: "item.completed",
  item: { id: "answer", type: "agent_message", text: text + "\n[PHASE_DONE]" },
});
