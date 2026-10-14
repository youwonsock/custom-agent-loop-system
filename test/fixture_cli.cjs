#!/usr/bin/env node
// Deterministic local coding CLI used only by acceptance tests. No API calls.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
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
if (args.includes("app-server")) {
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
  const counter = path.join(process.cwd(), ".fixture-calls.json");
  let calls = {};
  try {
    calls = JSON.parse(fs.readFileSync(counter, "utf8"));
  } catch {}
  calls[type] = (calls[type] || 0) + 1;
  fs.writeFileSync(counter, JSON.stringify(calls));
  fs.appendFileSync(
    path.join(process.cwd(), ".fixture-arguments.jsonl"),
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
    prompt.includes("fixture:network") &&
    (!prompt.includes("fixture:network-once") || calls[type] === 1)
  ) {
    emit({ type: "thread.started", thread_id: "fixture-session" });
    console.error("temporary network connection lost");
    process.exit(7);
  }
  if (prompt.includes("fixture:spent-network")) {
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
  if (
    prompt.includes("fixture:auth") &&
    (!prompt.includes("fixture:auth-once") || calls[type] === 1)
  ) {
    console.error("authentication required: sign in");
    process.exit(1);
  }
  if (
    prompt.includes("fixture:hang") &&
    type === "implementation" &&
    (!prompt.includes("fixture:hang-once") || calls[type] === 1)
  ) {
    emit({ type: "thread.started", thread_id: "fixture-session" });
    setInterval(() => {}, 1000);
  } else {
    let rejected =
      type === "review" &&
      prompt.includes("fixture:reject-once") &&
      calls[type] === 1;
    const evidence = reqs
      .map(
        (r) =>
          `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${r}\nSTATUS: ${rejected ? "PARTIAL" : "SATISFIED"}\nEVIDENCE: fixture observed acceptance artifact\n[/REQUIREMENT_EVIDENCE]`,
      )
      .join("\n");
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
    } else if (type === "implementation") {
      fs.writeFileSync(
        path.join(process.cwd(), "artifact.txt"),
        "implemented goal\n",
      );
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
    emit({ type: "thread.started", thread_id: "fixture-session" });
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
          (prompt.includes("fixture:incomplete-once") && calls[type] === 1
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
