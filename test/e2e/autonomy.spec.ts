import { test, expect } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createServer } from "../../dist/src/server/app";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkProcessLiveness } from "../../dist/src/core/resilience";

test("autonomous preset UI persists browser checks, repair budget and native review policy", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "자율 제작 그래프", exact: true })
    .click();
  await expect(page.getByLabel("전체 시간 예산")).toHaveValue("60");
  await expect(page.getByLabel("전체 에이전트 시도 한도")).toHaveValue("24");
  await expect(page.getByLabel("자동 수정 루프")).toBeChecked();
  await expect(page.getByLabel("테스트 소스 수정 차단")).toBeChecked();
  await expect(page.getByLabel("검토 승인 예산 보존")).toBeChecked();
  await expect(page.getByLabel("일괄 프로세스 종료 차단")).toBeChecked();
  await expect(page.getByLabel("Kilo 대상 밖 조회 차단")).toBeChecked();
  await expect(page.getByLabel("실제 브라우저 검증 필수")).toBeChecked();
  await expect(page.getByLabel("네이티브 자동 승인 검토")).toBeChecked();
  await page.getByLabel("자동 수정 횟수").fill("2");
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("자동 수정 횟수")).toHaveValue("2");
  await page
    .getByTestId("graph-canvas")
    .getByText("계획 수립", { exact: true })
    .click();
  await expect(
    page.getByLabel("사용자가 계획을 승인한 뒤 진행"),
  ).not.toBeChecked();
  await page.screenshot({
    path: "artifacts/screenshots/autonomous-preset.png",
    fullPage: true,
  });
});
test("real browser failure is autonomously repaired through final approval with zero operator actions", async ({}, info) => {
  const root = path.resolve("artifacts/autonomous-workflow"),
    target = path.join(root, "project");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  const server = await createServer({
    root: path.join(root, "studio"),
    monitor: false,
  });
  const states: string[] = [];
  server.coordinator.on("studio", (e) => {
    if (e.type === "session" && e.data) states.push(e.data.status);
  });
  try {
    await server.store.saveConnection({
      id: "autonomous-fixture",
      label: "Deterministic fixture, real browser",
      type: "codex",
      binary: path.resolve("test/autonomous_fixture_cli.cjs"),
    });
    let graph = await server.store.createGraph({ template: "autonomous" });
    graph.defaultBinding = {
      connectionId: "autonomous-fixture",
      modelId: "fixture-model",
    };
    graph = await server.store.saveGraph(graph.id, graph, graph.revision);
    const start = await server.coordinator.start({
      requestId: crypto.randomUUID(),
      graphId: graph.id,
      expectedRevision: graph.revision,
      goal: "fixture:browser-cwd Build a web app with a responsive 16-cell board and persisted button score.",
      targetProjectPath: target,
      settings: {
        maxAgentAttempts: 1,
        maxCompletionRecoveryAttempts: 1,
        maxAutomaticRecoveryCycles: 0,
        phaseTimeoutMs: 15000,
        transportTimeoutMs: 3000,
        idleTimeoutMs: 10000,
        toolTimeoutMs: 10000,
        phaseRecoveryBudgetMs: 25000,
      },
    });
    let state = await server.store.readSession(start.id);
    const deadline = Date.now() + 25000;
    while (state.status !== "SUCCESS" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      state = await server.store.readSession(start.id);
      if (
        ["PAUSED", "WAITING_USER", "FAILED", "BLOCKED"].includes(state.status)
      )
        throw Error(state.statusReason!);
    }
    expect(state.status).toBe("SUCCESS");
    expect(states).not.toContain("WAITING_USER");
    expect(state.pendingApproval).toBeNull();
    expect(state.visits.filter(v=>v.nodeId==="test").at(-1)!.verifiedCommands!.some(c=>c.command.startsWith("cd ")&&c.exitCode===0)).toBe(true);
    expect(state.verificationContract?.status).toBe("locked");
    expect(state.verificationContract?.origin).toBe("implementation");
    expect(state.visits.at(-1)?.output).toContain("[REPORT_PROTOCOL: json-v1]");
    expect(state.visits.map((v) => v.nodeId)).toEqual([
      "planning",
      "implementation",
      "test",
      "implementation",
      "test",
      "review",
      "approval",
    ]);
    expect(state.visits[2]!.verdict).toBe("FAIL");
    expect(state.visits.at(-1)!.verdict).toBe("APPROVED");
    const dir = path.join(target, "verification/browser"),
      files = await fs.readdir(dir);
    const reports = [];
    for (const file of files) {
      if (file === "report.json") continue;
      const p = path.join(dir, file, "report.json");
      try {
        reports.push(JSON.parse(await fs.readFile(p, "utf8")));
      } catch {}
    }
    expect(reports).toHaveLength(2);
    expect(
      reports.some((r) => !r.allPassed && r.error.includes("overflow")),
    ).toBe(true);
    expect(
      reports.some(
        (r) => r.allPassed && r.steps.every((s: any) => s.status === "passed"),
      ),
    ).toBe(true);
    expect(
      reports.every(
        (r) => r.serverStopped && checkProcessLiveness(r.serverPid) === "dead",
      ),
    ).toBe(true);
    await fs.writeFile(
      info.outputPath("autonomous-state.json"),
      JSON.stringify(state, null, 2),
    );
    await fs.writeFile(
      info.outputPath("autonomous-statuses.json"),
      JSON.stringify(states, null, 2),
    );
  } finally {
    await server.app.close();
  }
});
test("browser verifier rejects source changes during owned server shutdown and preserves failed assertions", async () => {
  const target = path.resolve("artifacts/browser-source-race");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.join(target, ".agent-graph"), { recursive: true });
  await fs.writeFile(
    path.join(target, "server.cjs"),
    `const fs=require('node:fs'),http=require('node:http');const s=http.createServer((q,r)=>r.end('<h1>ready</h1>'));s.listen(Number(process.env.PORT||0),'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port));process.on('SIGTERM',()=>{fs.writeFileSync('changed.js','changed');s.close();});`,
  );
  await fs.writeFile(
    path.join(target, ".agent-graph/browser.json"),
    JSON.stringify({
      version: 1,
      server: { command: ["node", "server.cjs"] },
      steps: [{ id: "page", type: "visible", selector: "h1" }],
    }),
  );
  const command = promisify(execFile);
  let code = 0;
  try {
    await command(
      process.execPath,
      [
        path.resolve("dist/src/server/cli.js"),
        "verify-browser",
        "--spec",
        ".agent-graph/browser.json",
      ],
      { cwd: target, timeout: 15000 },
    );
  } catch (e) {
    code = Number((e as { code: number }).code);
  }
  expect(code).toBe(1);
  const report = JSON.parse(
    await fs.readFile(
      path.join(target, "verification/browser/report.json"),
      "utf8",
    ),
  );
  expect(report.allPassed).toBe(false);
  expect(report.error).toContain("Source changed");
  expect(report.serverStopped).toBe(true);
  expect(checkProcessLiveness(report.serverPid!)).toBe("dead");
});

test("unavailable Chromium leaves a failed report with every check unexecuted", async () => {
  const target = path.resolve("artifacts/browser-prerequisite");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.join(target, ".agent-graph"), { recursive: true });
  await fs.writeFile(
    path.join(target, ".agent-graph/browser.json"),
    JSON.stringify({
      version: 1,
      server: { command: ["node", "server.cjs"] },
      steps: [{ id: "page", type: "visible", selector: "h1" }],
    }),
  );
  let code = 0;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        path.resolve("dist/src/server/cli.js"),
        "verify-browser",
        "--spec",
        ".agent-graph/browser.json",
      ],
      {
        cwd: target,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: path.join(target, "missing-browser-cache"),
        },
        timeout: 10000,
      },
    );
  } catch (e) {
    code = Number((e as { code: number }).code);
  }
  expect(code).toBe(1);
  const report = JSON.parse(
    await fs.readFile(
      path.join(target, "verification/browser/report.json"),
      "utf8",
    ),
  );
  expect(report.allPassed).toBe(false);
  expect(report.error).toContain("Chromium unavailable");
  expect(report.serverPid).toBeNull();
  expect(report.steps.every((s: any) => s.status === "not_run")).toBe(true);
});

test("browser verifier never reuses or stops an existing foreign server", async () => {
  const http = await import("node:http");
  const foreign = http.createServer((_q, r) => r.end("foreign owner"));
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const port = (foreign.address() as { port: number }).port;
  const target = path.resolve("artifacts/browser-foreign-owner");
  try {
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.join(target, ".agent-graph"), { recursive: true });
    await fs.writeFile(
      path.join(target, "server.cjs"),
      `console.log('http://127.0.0.1:${port}');setInterval(()=>{},1000);`,
    );
    await fs.writeFile(
      path.join(target, ".agent-graph/browser.json"),
      JSON.stringify({
        version: 1,
        server: { command: ["node", "server.cjs"] },
        steps: [{ id: "page", type: "visible", selector: "h1" }],
      }),
    );
    let code = 0;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          path.resolve("dist/src/server/cli.js"),
          "verify-browser",
          "--spec",
          ".agent-graph/browser.json",
        ],
        { cwd: target, timeout: 10000 },
      );
    } catch (e) {
      code = Number((e as { code: number }).code);
    }
    expect(code).toBe(1);
    const report = JSON.parse(
      await fs.readFile(
        path.join(target, "verification/browser/report.json"),
        "utf8",
      ),
    );
    expect(report.error).toContain("existing server reuse is forbidden");
    expect(report.serverStopped).toBe(true);
    expect(foreign.listening).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
      "foreign owner",
    );
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});
