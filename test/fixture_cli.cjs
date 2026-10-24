#!/usr/bin/env node
// Deterministic local coding CLI used only by acceptance tests. No API calls.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const args = process.argv.slice(2),
  emit = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const model = {
  model: "fixture-model",
  id: "fixture-model",
  value: "fixture-model",
  displayName: "Fixture Agent",
  name: "Fixture Agent",
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "high" },
  ],
  supportedEffortLevels: ["low", "high"],
};
// Explicit native metadata lets acceptance tests exercise pricing without model calls.
try {
  const metadata = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".fixture-model-metadata.json"), "utf8"));
  model.isFree = metadata.isFree;
  model.cost = metadata.cost;
} catch {}
if (args[0] === "debug" && args[1] === "config") {
  // Native configuration preflight is not a model turn or a fixture call.
  emit({default_agent:"fixture",agent:{fixture:{tools:{write:true}}}});
} else if (args.includes("app-server")) {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method === "initialize") emit({ id: m.id, result: {} });
    if (
      m.method === "model/list" &&
      fs.existsSync(path.join(process.cwd(), ".fixture-slow-query"))
    ) {
      fs.unlinkSync(path.join(process.cwd(), ".fixture-slow-query"));
      fs.writeFileSync(
        path.join(process.cwd(), ".fixture-query-pid"),
        String(process.pid),
      );
      return;
    }
    if (m.method === "model/list")
      emit({
        id: m.id,
        result: {
          data: [model, { ...model, model: "fixture-hidden", hidden: true }],
          nextCursor: null,
        },
      });
  });
  process.stdin.on("end", () => process.exit(0));
} else if (args.includes("serve")) {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/provider"))
      res.end(
        JSON.stringify({
          all: [
            {
              id: "fixture",
              key: "DO_NOT_PERSIST",
              models: { "fixture-model": model },
            },
            {
              id: "unconnected",
              models: { inaccessible: { id: "inaccessible" } },
            },
          ],
          connected: ["fixture"],
          failed: [],
          default: { fixture: "fixture-model" },
        }),
      );
    else res.end(JSON.stringify({ paths: { "/provider": { get: {} } } }));
  });
  server.listen(0, "127.0.0.1", () =>
    console.log(
      `server listening on http://127.0.0.1:${server.address().port}`,
    ),
  );
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (args.includes("--input-format")) {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.type === "control_request" && m.request.subtype === "initialize")
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: m.request_id,
          response: { commands: [], models: [model], agents: [], account: {} },
        },
      });
    else if (m.type === "user") {
      fs.appendFileSync(
        path.join(process.cwd(), "unexpected-turn.txt"),
        JSON.stringify(m),
      );
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  const prompt = args.find((a) => a.includes("=== ORIGINAL USER GOAL")) || "";
  const type = prompt.match(/Execution type: (\w+)/)?.[1] || "implementation";
  const reqs = [
    ...new Set([...prompt.matchAll(/^(REQ-\d+):/gm)].map((m) => m[1])),
  ];
  if(prompt.includes("=== AUTONOMOUS WORKFLOW ==="))fs.mkdirSync("verification",{recursive:true});
  const counter = path.join(process.cwd(), prompt.includes("=== AUTONOMOUS WORKFLOW ===") ? "verification/.fixture-calls.json" : ".fixture-calls.json");
  let calls = {};
  try {
    calls = JSON.parse(fs.readFileSync(counter, "utf8"));
  } catch {}
  calls[type] = (calls[type] || 0) + 1;
  fs.writeFileSync(counter, JSON.stringify(calls));
  fs.appendFileSync(
    path.join(process.cwd(), prompt.includes("=== AUTONOMOUS WORKFLOW ===") ? "verification/.fixture-arguments.jsonl" : ".fixture-arguments.jsonl"),
    JSON.stringify({ type, args }) + "\n",
  );
  if (type === "review" && prompt.includes("fixture:qa-regression")) {
    for (const line of fs
      .readFileSync(
        path.join(__dirname, "fixtures/qa-auth-regression.jsonl"),
        "utf8",
      )
      .trim()
      .split("\n"))
      emit(JSON.parse(line));
    process.exit(0);
  }
  if (
    type === "review" &&
    prompt.includes("fixture:qa-incomplete-once") &&
    calls[type] === 1
  ) {
    emit({ type: "thread.started", thread_id: "fixture-session" });
    emit({
      type: "step_finish",
      timestamp: 1791946608401,
      part: { id: "id-440358e11c92" },
    });
    emit({
      type: "text",
      part: {
        text: "Review the authentication flow and API key handling; response not finished yet.",
      },
    });
    process.exit(0);
  }
  if (
    type === "implementation" && prompt.includes("fixture:network") &&
    (!prompt.includes("fixture:network-once") || calls[type] === 1)
  ) {
    emit({ type: "thread.started", thread_id: "fixture-session" });
    console.error("temporary network connection lost");
    process.exit(7);
  }
  if (type === "implementation" && prompt.includes("fixture:tool-arguments-once")) {
    if (calls[type] === 1) {
      emit({ type: "step_start", sessionID: "fixture-malformed-session" });
      emit({ type: "tool_use", part: { tool: "write", state: { status: "error", error: "filePath and content are missing and required", input: {} } } });
      emit({ type: "error", error: { message: 'Stopped after 3 consecutive invalid-argument failures for the "write" tool.' } });
      process.exit(1);
    }
    if (!prompt.includes("filePath and content are missing and required") || args.includes("--session")) {
      console.error("Error: missing schema feedback or reused invalid session");
      process.exit(1);
    }
    const nativeConfig = JSON.parse(process.env.KILO_CONFIG_CONTENT || "{}");
    if (nativeConfig.agent?.fixture?.tools?.write !== false || !prompt.includes("write tool is disabled")) {
      console.error("Error: malformed-write recovery did not exclude write in the effective agent config");
      process.exit(1);
    }
  }
  if (type === "implementation" && prompt.includes("fixture:spent-network") &&
      (!prompt.includes("fixture:spent-network-once") || calls[type] === 1)) {
    emit({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Observed implementation progress before connection lost.",
      },
    });
    console.error("temporary network connection lost");
    process.exit(7);
  }
  if (type === "implementation" && prompt.includes("fixture:quota") &&
      (!prompt.includes("fixture:quota-once") || calls[type] === 1)) {
    emit({ type: "error", error: { code: "insufficient_quota", statusCode: 429, message: "Provider quota exhausted" } });
    process.exit(1);
  }
  if (
    type === "implementation" && prompt.includes("fixture:auth") &&
    (!prompt.includes("fixture:auth-once") || calls[type] === 1)
  ) {
    console.error("authentication required: sign in");
    process.exit(1);
  }
  if (
    type === "implementation" && prompt.includes("fixture:progress-budget-once") && calls[type] === 1
  ) {
    emit({ type: "thread.started", thread_id: "fixture-session" });
    let progress = 0;
    setInterval(() => emit({ type: "item.completed", item: { id: `progress-${++progress}`, type: "agent_message", text: `Completed work item ${progress}.` } }), 100);
    return;
  }
  if (
    prompt.includes("fixture:hang") &&
    type === "implementation" &&
    (!prompt.includes("fixture:hang-once") || calls[type] === 1)
  ) {
    emit({ type: "thread.started", thread_id: "fixture-session" });
    setInterval(() => {}, 1000);
  } else {
    const productBlocked = type === "test" && (prompt.includes("fixture:auto-product-blocked") || prompt.includes("fixture:auto-product-always-blocked")) && (calls[type] === 1 || prompt.includes("fixture:auto-product-always-blocked"));
    let rejected =
      type === "review" &&
      prompt.includes("fixture:reject-once") &&
      calls[type] === 1;
    let evidence = reqs
      .map(
        (r) =>
          `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${r}\nSTATUS: ${productBlocked ? "BLOCKED" : rejected ? "PARTIAL" : "SATISFIED"}\nEVIDENCE: fixture observed acceptance artifact\nCHECK_COMMAND: node --test acceptance.test.cjs\n[/REQUIREMENT_EVIDENCE]`,
      )
      .join("\n");
    if (prompt.includes("fixture:evidence-typo-once") && ["test", "review", "approval"].includes(type) && calls[type] === 1)
      evidence = evidence.replace("REQ_ID: ", "REQ_ID: REQ_ID: ");
    let text = "";
    if (type === "planning") {
      const count = Number(
        prompt.match(/Return exactly (\d+) complete options/)?.[1] || 3,
      );
      text = Array.from(
        { length: count },
        (_, i) =>
          `## OPTION ${i + 1}: Strategy ${i + 1}\n${reqs.join(", ")}\nFiles: artifact.txt\nSteps: implement then verify observed artifact.\nVerification: read artifact.txt and inspect results.\nRisks: bounded fixture ${i + 1}.`,
      ).join("\n\n");
      if (prompt.includes("fixture:plan-external") && (calls.planning === 1 || prompt.includes("fixture:plan-external-always"))) text += "\nRead /tmp/unrequested-reference.txt before implementation.";
    } else if (type === "implementation") {
      fs.writeFileSync(
        path.join(process.cwd(), "artifact.txt"),
        prompt.includes("fixture:contract-early-fail")&&calls.implementation===1?"broken\n":"implemented goal\n",
      );
      if (prompt.includes("fixture:contract-runner-repair")) fs.writeFileSync("package.json", JSON.stringify({ scripts: { test: calls.implementation === 1 ? "node tests/verify-acceptance.mjs || node tests/verify-acceptance.mjs" : "node tests/verify-acceptance.mjs" } }));
      if(prompt.includes("fixture:contract-own-node")){
        fs.mkdirSync("test",{recursive:true});
        fs.writeFileSync("test/value.test.mjs",calls.implementation===1
          ? "import test from 'node:test';test('value:correct',()=>{});"
          : "import test from 'node:test';import a from 'node:assert/strict';import {value} from '../value.mjs';test('value:correct',()=>a.equal(value,1));");
      }
      if (prompt.includes("fixture:contract-create")) {
        fs.mkdirSync(".agent-graph", { recursive: true });
        fs.mkdirSync("tests", { recursive: true });
        fs.writeFileSync("tests/verify-acceptance.mjs", 'import { readFileSync } from "node:fs"; import assert from "node:assert/strict"; assert.equal(readFileSync("artifact.txt", "utf8"), "implemented goal\\n");');
        fs.writeFileSync(".agent-graph/verification.json", JSON.stringify({ version: 1, protectedFiles: ["tests/verify-acceptance.mjs"], checks: [{ id: "acceptance", command: "node tests/verify-acceptance.mjs", requirements: reqs }] }));
      }
      if (prompt.includes("fixture:contract-tamper")) {
        const file = "tests/verify-acceptance.mjs", original = fs.readFileSync(file);
        fs.appendFileSync(file, "\n// changed protected assertion\n");
        if (prompt.includes("fixture:contract-tamper-restore")) {
          fs.writeFileSync(file, original);
          emit({ type: "item.completed", item: { type: "file_change", changes: [{ path: file, kind: "update" }], status: "completed" } });
        }
      }
      text = evidence + "\nImplementation complete.";
    } else if (type === "test")
      text =
        evidence +
        "\nVERDICT: " +
        (fs.existsSync(path.join(process.cwd(), "artifact.txt"))
          ? "PASS"
          : "FAIL");
    else if (type === "review" || type === "approval")
      text =
        evidence +
        "\n" +
        (rejected
          ? "REJECTED: one verification issue remains."
          : "APPROVED: observed acceptance passed.");
    else
      text =
        "Failure evidence reviewed. Inspect the last attempt and fix the cause before resuming.";
    if(type==="test" && prompt.includes("fixture:auto-source-edit") && calls[type]===1)fs.writeFileSync("styles.css","/* unexpected test-role production edit */");
    if(productBlocked)text=evidence+"\nBLOCKED_KIND: product\nVERDICT: BLOCKED";
    emit({ type: "thread.started", thread_id: "fixture-session" });
    if (["review", "approval"].includes(type) && prompt.includes(`fixture:${type}-check-fail-once`) && calls[type] === 1)
      emit({ type: "item.completed", item: { id: "extra-check", type: "command_execution", command: "node --test extra.test.cjs", exit_code: 1, status: "completed", aggregated_output: "# fail 1" } });
    if (type === "test" && !prompt.includes("=== JSON REPORT v1 ===")) {
      const blocked = prompt.includes("fixture:environment-once") && calls[type] === 1;
      emit({ type: "item.completed", item: { id: "acceptance", type: "command_execution", command: "node --test acceptance.test.cjs", exit_code: blocked || productBlocked ? 1 : 0, status: "completed", aggregated_output: productBlocked ? "AssertionError: implementation incomplete" : blocked ? "Error: listen EPERM: operation not permitted 127.0.0.1" : "# pass 1\n# fail 0" } });
    }
    if (prompt.includes("=== JSON REPORT v1 ===") && ["test", "review", "approval"].includes(type)) {
      if (type === "test" && calls.test===1 && (prompt.includes("fixture:contract-hidden-guard")||prompt.includes("fixture:contract-policy-guard"))) {
        fs.writeFileSync("verification/guard-child.pid",String(process.pid));
        if(prompt.includes("fixture:contract-hidden-guard"))fs.writeFileSync("artifact.txt","unexpected test repair\n");
        else emit({type:"tool_use",part:{id:"blocked-write",tool:"write",state:{status:"error",input:{filePath:path.resolve("artifact.txt"),content:"unexpected repair"},error:"Error: [AGENT_GRAPH_TEST_POLICY] Test role cannot edit source before execution"}}});
        setTimeout(()=>fs.writeFileSync("verification/forbidden-late-write","not stopped"),5000);setInterval(()=>{},1000);return;
      }
      if (type === "test") {
        const manifest = JSON.parse(fs.readFileSync(".agent-graph/verification.json", "utf8"));
        for (const check of manifest.checks) {
          if (prompt.includes("fixture:contract-omit-check") && check.id === "second") continue;
          const cwd = process.platform === "win32" ? '"'+process.cwd()+'"' : "'"+process.cwd().replace(/'/g, "'\\''")+"'";
          const observedCommand = prompt.includes("fixture:contract-cwd") ? "cd "+cwd+" && "+check.command : check.command;
          const words=require("../dist/src/core/verification_evidence.js").literalShellWords(observedCommand);
          const executed = words?.[0]==="node"&&words[2]==="verify-node-tests"
            ? spawnSync(process.execPath,words.slice(1),{cwd:process.cwd(),encoding:"utf8"})
            : spawnSync(observedCommand, { shell: true, cwd: process.cwd(), encoding: "utf8" });
          emit({ type: "item.completed", item: { id: check.id, type: "command_execution", command: observedCommand, exit_code: executed.status, status: "completed", aggregated_output: executed.stdout + executed.stderr } });
          if(prompt.includes("fixture:contract-early-fail")&&executed.status!==0){fs.writeFileSync("verification/guard-child.pid",String(process.pid));setTimeout(()=>fs.writeFileSync("verification/forbidden-late-write","not stopped"),5000);setInterval(()=>{},1000);return;}
        }
      }
      const own=JSON.parse(fs.readFileSync(".agent-graph/verification.json","utf8")).nodeTests;
      if(own&&["review","approval"].includes(type))for(const file of [...own.scopes.map(s=>s.file),"verification/node-tests/report.json"]){
        const output=fs.readFileSync(file,"utf8");
        emit({type:"tool_use",part:{id:`inspect-${type}-${file}`,tool:"read",state:{status:"completed",input:{filePath:path.resolve(file)},output}}});
      }
      text = "[AGENT_REPORT]\n" + JSON.stringify({ version: 1, verdict: type === "test" ? "PASS" : "APPROVED", requirements: reqs.map(id => ({ id, status: "SATISFIED", evidence: "inspected actual acceptance artifact and receipts" })),...(own?{testScopes:own.scopes.map(s=>({id:s.id,status:"SATISFIED",evidence:"actual own scope assertions and mutation result inspected"}))}:{}) }) + "\n[/AGENT_REPORT]";
    }
    if (prompt.includes("인터넷 검색")) {
      emit({
        type: "item.completed",
        item: { id: "search-1", type: "web_search" },
      });
      text =
        "[RESEARCH_EVIDENCE]\nSOURCE: https://example.com/observed\nVERIFIED_FACT: observed fixture research.\n" +
        text;
    }
    emit({
      type: "item.completed",
      model: "fixture-model",
      item: {
        id: "answer",
        type: "agent_message",
        text:
          text +
          (prompt.includes("=== JSON REPORT v1 ===") || (prompt.includes("fixture:incomplete-once") && calls[type] === 1)
            ? ""
            : "\n[PHASE_DONE]"),
      },
    });
    if (
      type === "review" &&
      prompt.includes("fixture:qa-auth-once") &&
      calls[type] === 1
    )
      emit({
        type: "error",
        error: {
          name: "ProviderAuthError",
          data: { message: "authentication required: sign in" },
        },
      });
    setTimeout(() => process.exit(0), 30);
  }
}
