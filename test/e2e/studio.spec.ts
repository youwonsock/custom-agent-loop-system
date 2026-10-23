import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
const binary = path.resolve("test/fixture_cli.cjs"),
  target = path.resolve("artifacts/e2e-project");
async function waitForCanvasFit(page: Page) {
  await expect
    .poll(() =>
      page.getByTestId("graph-canvas").evaluate((canvas) => {
        const box = canvas.getBoundingClientRect(),
          nodes = [...canvas.querySelectorAll(".react-flow__node")];
        return (
          nodes.length === 8 &&
          nodes.every((node) => {
            const b = node.getBoundingClientRect();
            return (
              b.left >= box.left - 1 &&
              b.right <= box.right + 1 &&
              b.top >= box.top - 1 &&
              b.bottom <= box.bottom + 1
            );
          })
        );
      }),
    )
    .toBe(true);
}
test.beforeAll(async () => {
  await fs.mkdir(target, { recursive: true });
});
test("editor disables execution and explains completion paths that bypass tests or final approval", async ({ page }) => {
  await page.route("**/api/bootstrap*", async route => {
    const response = await route.fetch();
    const boot = await response.json();
    const graph = boot.graphs.find((g: any) => g.nodes.some((n: any) => n.id === "approval") && g.nodes.some((n: any) => n.id === "test"));
    graph.defaultBinding = { connectionId: "fixture", modelId: "fixture-model" };
    graph.edges.find((e: any) => e.source === "implementation" && e.outcome === "success").target = "SUCCESS";
    boot.graphs = [graph];
    await route.fulfill({ response, json: boot });
  });
  await page.goto("/");
  await page.getByLabel("실행 목표").fill("Do not skip verification");
  await expect(page.getByText("완료(SUCCESS)는 최종 승인 노드의 성공 경로로만 연결하세요.", { exact: true })).toBeVisible();
  await expect(page.getByText("실행·재진입·중단 경로에서 테스트를 건너뛰고 완료할 수 없습니다.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "그래프 실행", exact: false })).toBeDisabled();
  await page.screenshot({ path: "artifacts/screenshots/unsafe-success-blocked.png", fullPage: true });
});
test("editor rejects a closed execution cycle using the shared server diagnostics", async ({ page }) => {
  await page.route("**/api/bootstrap*", async route => {
    const response = await route.fetch();
    const boot = await response.json();
    const graph = boot.graphs.find((g: any) => g.nodes.some((n: any) => n.id === "approval"));
    graph.defaultBinding = { connectionId: "fixture", modelId: "fixture-model" };
    graph.edges = graph.edges.map((e: any) => e.source === "interrupt" ? e : { ...e, target: e.source });
    boot.graphs = [graph];
    await route.fulfill({ response, json: boot });
  });
  await page.goto("/");
  await page.getByLabel("실행 목표").fill("Closed cycles must not run");
  await expect(page.getByText("완료 또는 일시정지로 나갈 수 있는 경로가 없습니다.", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "그래프 실행", exact: false })).toBeDisabled();
});
test("graph editing, model connection, plan editing/approval and complete execution", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByLabel("그래프 이름")).toBeVisible();
  await page.getByRole("button", { name: "새 그래프", exact: true }).click();
  await page.getByLabel("그래프 이름").fill("GUI 인수 검증");
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  await page.locator('[title="계획 노드 추가"]').click();
  await page.getByLabel("노드 이름").fill("독립 계획 노드");
  await page.getByRole("button", { name: "노드 선택 해제" }).click();
  await expect(page.getByTestId("graph-canvas")).toContainText(
    "독립 계획 노드",
  );
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(page.getByTestId("graph-canvas")).not.toContainText(
    "독립 계획 노드",
  );
  await page.getByRole("button", { name: "CLI 연결", exact: false }).click();
  await page.getByLabel("연결 이름").fill("검증용 CLI");
  await page.getByLabel("CLI 실행 파일").fill(binary);
  await page.getByLabel("모델 조회 프로젝트").fill(target);
  await page
    .getByRole("button", { name: "등록하고 모델 조회", exact: true })
    .click();
  await expect(
    page.getByText("모델 조회 완료", { exact: true }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "그래프 편집", exact: false }).click();
  await page
    .getByLabel("기본 실행 설정 연결")
    .selectOption({ label: "검증용 CLI · codex" });
  await page.getByLabel("기본 실행 설정 모델").selectOption("fixture-model");
  await page
    .getByLabel("실행 목표")
    .fill("Create and verify the fixture acceptance artifact.");
  await expect(
    page.getByRole("button", { name: "그래프 실행", exact: false }),
  ).toBeEnabled();
  await page.screenshot({
    path: "artifacts/screenshots/editor-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "그래프 실행", exact: false }).click();
  await expect(
    page.getByRole("heading", { name: "계획을 검토하고 승인하세요" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /선택지 2/ }).click();
  await page.getByRole("button", { name: "문서 수정", exact: true }).click();
  const area = page.getByLabel("계획 문서");
  const body = await area.inputValue();
  await area.fill(body + "\nOperator acceptance review complete.");
  await page.getByRole("button", { name: "CLI 연결", exact: false }).click();
  await page.getByRole("button", { name: "실행 기록", exact: false }).click();
  await expect(area).toHaveValue(body + "\nOperator acceptance review complete.");
  await page.getByRole("button", { name: "문서 저장", exact: true }).click();
  await expect(page.getByText(/문서 rev 2/)).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/plan-review.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "이 계획 승인 후 계속", exact: true })
    .click();
  await expect(page.locator(".page-heading .status-pill")).toHaveText("완료", {
    timeout: 20_000,
  });
  await expect(
    page.getByText("모든 필수 요구사항, 실제 테스트 실행 증거와 최종 승인을 확인했습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".visit-panel")).toContainText("최종 승인");
  await page.screenshot({
    path: "artifacts/screenshots/run-complete.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "실행 기록", exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "실행 기록", exact: false }).click();
  await page.getByLabel("실행 세션").selectOption({ index: 1 });
  await expect(page.locator(".page-heading .status-pill")).toHaveText("완료");
});
test("desktop and narrow layout keep the canvas and controls usable without horizontal overflow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await waitForCanvasFit(page);
  await page.screenshot({
    path: "artifacts/screenshots/layout-desktop.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect(
    page.getByRole("button", { name: "폴더 선택", exact: true }),
  ).toBeVisible();
  await waitForCanvasFit(page);
  await page.screenshot({
    path: "artifacts/screenshots/layout-narrow.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await waitForCanvasFit(page);
  await expect(page.getByLabel("기본 실행 설정 연결")).toBeVisible();
  expect(
    await page
      .locator(".inspector-body")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBeTruthy();
  await page.screenshot({
    path: "artifacts/screenshots/layout-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
});

test("node dragging, ports, undo/redo, inheritance and graph import/export work through the GUI", async ({
  page,
}) => {
  const graphName = `Graph interaction ${crypto.randomUUID()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "새 그래프", exact: true }).click();
  await page.getByLabel("그래프 이름").fill(graphName);
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  const builder = page.getByTestId("node-implementation");
  await builder.click();
  await page.getByLabel("역할 이름").fill("Acceptance Builder");
  await page
    .getByLabel("역할 지침")
    .fill("Preserve the original goal and verify every acceptance item.");
  await page.getByLabel("실패 시 다음 단계").selectOption("PAUSED");
  await expect(page.locator(".react-flow__edge")).toHaveCount(12);
  await page.getByRole("button", { name: "노드 선택 해제" }).click();
  const box = await builder.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.45, box!.y + 25);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.45 + 50, box!.y + 50, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  const saved = (await (await page.request.get("/api/graphs")).json()).find(
    (g: any) => g.name === graphName,
  );
  expect(saved.nodes.find((n: any) => n.id === "implementation").roleName).toBe(
    "Acceptance Builder",
  );
  expect(
    saved.nodes.find((n: any) => n.id === "implementation").position.x,
  ).not.toBe(380);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  // Drag a failure handle to a target handle rather than using the inspector selector.
  const source = page.locator(
      '.react-flow__node[data-id="implementation"] .react-flow__handle[data-handleid="failure"]',
    ),
    dest = page.locator(
      '.react-flow__node[data-id="interrupt"] .react-flow__handle[data-handleid="in"]',
    );
  const a = await source.boundingBox(),
    b = await dest.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, {
    steps: 16,
  });
  await page.mouse.up();
  await builder.click();
  await expect(page.getByLabel("실패 시 다음 단계")).toHaveValue("interrupt");
  await page.getByRole("button", { name: "노드 선택 해제" }).click();
  await page.getByRole("button", { name: "복제", exact: true }).click();
  await expect(page.getByLabel("그래프 이름")).toHaveValue(
    graphName + " 복사본",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(path.resolve("artifacts/exported-graph.json"));
  await page
    .locator('input[type="file"]')
    .setInputFiles(path.resolve("artifacts/exported-graph.json"));
  await expect(page.getByText(/새 ID로 그래프를 가져왔습니다/)).toBeVisible();
  const imports = (await (await page.request.get("/api/graphs")).json()).filter(
    (g: any) => g.name === graphName + " 복사본",
  );
  expect(imports.length).toBe(2);
  expect(imports[0].id).not.toBe(imports[1].id);
  await page.getByRole("button", { name: "폴더 선택", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "프로젝트 폴더 선택" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "이 폴더 사용", exact: true }).click();
  await expect(page.getByText(/대상 프로젝트를 선택했습니다/)).toBeVisible();
});

test("conflicting browser edits preserve local draft and can be saved as a new graph", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "새 그래프", exact: true }).click();
  await page.getByLabel("그래프 이름").fill("Conflict baseline");
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByLabel("그래프 이름")).toHaveValue(
    "Conflict baseline",
  );
  await page
    .getByLabel("그래프 설명")
    .fill("First window saved this revision.");
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  await second
    .getByLabel("그래프 설명")
    .fill("Second window keeps its local draft.");
  await expect(second.getByText("저장 충돌", { exact: true })).toBeVisible();
  await expect(second.getByLabel("그래프 설명")).toHaveValue(
    "Second window keeps its local draft.",
  );
  await second.reload();
  await expect(second.getByText("저장 충돌", { exact: true })).toBeVisible();
  await expect(second.getByLabel("그래프 설명")).toHaveValue(
    "Second window keeps its local draft.",
  );
  await second
    .getByRole("button", { name: "새 그래프로 저장", exact: true })
    .click();
  await expect(
    second.getByText("초안을 새 그래프로 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await expect(second.getByLabel("그래프 설명")).toHaveValue(
    "Second window keeps its local draft.",
  );
  await second.close();
});

test("mobile library and node controls remain available and the project path is restored", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("대상 프로젝트")).toBeVisible();
  await page.getByLabel("대상 프로젝트").fill(target);
  await page.reload();
  await expect(page.getByLabel("대상 프로젝트")).toHaveValue(target);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("그래프 선택")).toBeVisible();
  await page
    .getByRole("button", { name: "모바일 새 그래프", exact: true })
    .click();
  await expect(page.getByLabel("그래프 이름")).toBeVisible();
  await page
    .getByLabel("노드 선택", { exact: true })
    .selectOption("implementation");
  await expect(page.getByLabel("역할 이름")).toBeVisible();
  await page
    .getByLabel("역할 지침")
    .fill("Mobile inspector keeps controls in one vertical flow.");
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  expect(
    await page
      .locator(".inspector-body")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBeTruthy();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "artifacts/screenshots/mobile-controls-verified.png",
    fullPage: true,
  });
});

test("node deletion, redo and per-node model override preserve graph defaults", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "새 그래프", exact: true }).click();
  await page
    .getByLabel("그래프 이름")
    .fill("Binding and node removal acceptance");
  await page.getByTestId("node-implementation").click();
  await page.getByLabel("그래프 기본 연결·모델 사용").uncheck();
  await expect(page.getByLabel("노드 실행 설정 연결")).toBeVisible();
  await page
    .getByLabel("노드 실행 설정 연결")
    .selectOption({ label: "검증용 CLI · codex" });
  await page.getByRole("button", { name: "모델 조회", exact: true }).click();
  await page.getByLabel("노드 실행 설정 모델").selectOption("fixture-model");
  await page.getByLabel("노드 실행 설정 추론 강도").selectOption("high");
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  const docs = await (await page.request.get("/api/graphs")).json();
  const g = docs.find(
    (d: any) => d.name === "Binding and node removal acceptance",
  );
  expect(
    g.nodes.find((n: any) => n.id === "implementation").binding.variant,
  ).toBe("high");
  expect(g.defaultBinding).toBeUndefined();
  await page.getByRole("button", { name: "노드 삭제", exact: true }).click();
  await expect(page.getByTestId("node-implementation")).toHaveCount(0);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(page.getByTestId("node-implementation")).toBeVisible();
  await page.getByRole("button", { name: "재실행", exact: true }).click();
  await expect(page.getByTestId("node-implementation")).toHaveCount(0);
});

test("closing and reopening the browser retains a running worker and Stop works from the restored UI", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("그래프 이름")).toBeVisible();
  const bootstrap = await (await page.request.get("/api/bootstrap")).json();
  const origin = "http://127.0.0.1:4379";
  const headers = { Origin: origin };
  const base = bootstrap.graphs.find((g: any) =>
    g.nodes.some((n: any) => n.id === "implementation"),
  );
  const connection = bootstrap.connections.find(
    (c: any) => c.label === "검증용 CLI",
  );
  expect(connection).toBeTruthy();
  const g = {
    ...base,
    name: "Browser lifecycle acceptance",
    nodes: base.nodes.filter((n: any) =>
      ["implementation", "interrupt"].includes(n.id),
    ),
    edges: base.edges
      .filter((e: any) => ["implementation", "interrupt"].includes(e.source))
      .map((e: any) =>
        e.source === "implementation" && e.outcome === "success"
          ? { ...e, target: "PAUSED" }
          : e,
      ),
    entrypoints: {
      start: "implementation",
      reentry: "implementation",
      interrupt: "interrupt",
      cycleCompletion: "implementation",
    },
    defaultBinding: { connectionId: connection.id, modelId: "fixture-model" },
  };
  const graph = await (
    await page.request.post("/api/graphs", { headers, data: { document: g } })
  ).json();
  const started = await page.request.post("/api/sessions", {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      graphId: graph.id,
      expectedRevision: graph.revision,
      goal: "fixture:hang",
      targetProjectPath: target,
    },
  });
  expect(started.status()).toBe(202);
  const run = await started.json();
  await expect
    .poll(async () => {
      const state = await (
        await page.request.get(`/api/sessions/${run.id}`)
      ).json();
      return state.visits[0]?.attempts[0]?.activity;
    })
    .toBe("model_generation");
  await page.close();
  const restored = await context.newPage();
  await restored.goto("/");
  await restored
    .getByRole("button", { name: "실행 기록", exact: false })
    .click();
  await restored.getByLabel("실행 세션").selectOption(run.id);
  await expect(restored.locator(".page-heading .status-pill")).toHaveText(
    "실행 중",
  );
  await restored.getByRole("button", { name: "중지", exact: true }).click();
  await expect(restored.locator(".page-heading .status-pill")).toHaveText(
    "중지됨",
  );
  await restored.close();
});

test("canvas zoom is saved and restored when reopening the graph", async ({
  page,
}) => {
  const name = `Viewport ${crypto.randomUUID()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "새 그래프", exact: true }).click();
  await page.getByLabel("그래프 이름").fill(name);
  await waitForCanvasFit(page);
  await page.locator(".react-flow__controls-zoomin").click();
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  const graph = (await (await page.request.get("/api/graphs")).json()).find(
    (g: any) => g.name === name,
  );
  expect(graph.viewport.zoom).not.toBe(1);
  await page.reload();
  await expect(page.getByLabel("그래프 이름")).toHaveValue(name);
  await expect
    .poll(() =>
      page
        .locator(".react-flow__viewport")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a),
    )
    .toBeCloseTo(graph.viewport.zoom, 2);
});

test("graph removal uses its identity while completed execution snapshots remain readable", async ({
  page,
}) => {
  const name = `Removal ${crypto.randomUUID()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "새 그래프", exact: true }).click();
  await page.getByLabel("그래프 이름").fill(name);
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  const graph = (await (await page.request.get("/api/graphs")).json()).find(
    (g: any) => g.name === name,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await expect
    .poll(
      async () =>
        await page.request
          .get(`/api/graphs/${graph.id}`)
          .then((r) => r.status()),
    )
    .toBe(404);
  await page.getByRole("button", { name: "실행 기록", exact: false }).click();
  const sessions = await (await page.request.get("/api/sessions")).json();
  const completed = sessions.find((s: any) => s.status === "SUCCESS");
  expect(completed).toBeTruthy();
  await page.getByLabel("실행 세션").selectOption(completed.id);
  await expect(page.locator(".page-heading .status-pill")).toHaveText("완료");
});

async function startQaFixture(page: Page, goal: string, pricing?: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  await page.goto("/");
  await expect(page.getByLabel("그래프 이름")).toBeVisible();
  const headers = { Origin: "http://127.0.0.1:4379" };
  expect((await page.request.get("/api/bootstrap")).status()).toBe(200);
  const project = path.resolve(
    `artifacts/qa-error-project-${crypto.randomUUID()}`,
  );
  await fs.mkdir(project, { recursive: true });
  if (pricing) await fs.writeFile(path.join(project, ".fixture-model-metadata.json"), JSON.stringify(pricing));
  const connectionResponse = await page.request.post("/api/connections", {
    headers,
    data: {
      id: crypto.randomUUID(),
      label: "QA 진단 검증 CLI",
      type: "kilo",
      binary,
    },
  });
  expect(connectionResponse.status(), await connectionResponse.text()).toBe(
    200,
  );
  const connection = await connectionResponse.json();
  const created = await (
    await page.request.post("/api/graphs", {
      headers,
      data: { name: `QA 오류 검증 ${crypto.randomUUID()}` },
    })
  ).json();
  const graph = await (
    await page.request.put(`/api/graphs/${created.id}`, {
      headers,
      data: {
        expectedRevision: created.revision,
        document: {
          ...created,
          defaultBinding: {
            connectionId: connection.id,
            modelId: "fixture/fixture-model",
          },
          nodes: created.nodes.map((n: any) =>
            n.type === "planning"
              ? { ...n, planning: { ...n.planning, requiresApproval: false } }
              : n,
          ),
        },
      },
    })
  ).json();
  const started = await page.request.post("/api/sessions", {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      graphId: graph.id,
      expectedRevision: graph.revision,
      goal,
      targetProjectPath: project,
      settings: {
        maxAgentAttempts: 1,
        maxCompletionRecoveryAttempts: 1,
        maxAutomaticRecoveryCycles: 0,
        retryBackoffMs: [10],
        ...settings,
      },
    },
  });
  expect(started.status(), await started.text()).toBe(202);
  const run = await started.json();
  await page.getByRole("button", { name: "실행 기록", exact: false }).click();
  await page.getByLabel("실행 세션").selectOption(run.id);
  return { id: run.id, project };
}

for (const isFree of [true, false]) {
  test(`${isFree ? "free recovery" : "paid limit"} displays the pricing evidence and stop reason`, async ({ page }) => {
    const { id } = await startQaFixture(page, "fixture:spent-network", { isFree }, {
      maxAutomaticRecoveryCycles: 1, automaticRecoveryBackoffMs: [60000],
    });
    try {
      await expect(page.locator(".page-heading .status-pill")).toHaveText(isFree ? "복구 예약" : "일시정지");
      await expect(page.locator(".run-reason")).toContainText(isFree ? "무료로 확인된 모델" : "유료 모델이므로");
      await expect(page.locator(".attempt-detail").first()).toContainText(isFree ? "무료 확인" : "유료");
      const state = await (await page.request.get(`/api/sessions/${id}`)).json();
      expect(state.visits[0].attempts).toHaveLength(1);
      expect(state.visits[0].attempts[0].pricing.status).toBe(isFree ? "free" : "paid");
      await page.screenshot({ path: `artifacts/screenshots/${isFree ? "free-model-recovery" : "paid-model-limit"}.png`, fullPage: true });
    } finally {
      expect((await page.request.post(`/api/sessions/${id}/actions`, {
        headers: { Origin: "http://127.0.0.1:4379" },
        data: { requestId: crypto.randomUUID(), type: "stop" },
      })).status()).toBe(200);
    }
  });
}

test("QA auth displays the real CLI/node cause and manual resume preserves prior stages", async ({
  page,
}) => {
  const { id, project } = await startQaFixture(page, "fixture:qa-auth-once");
  await expect(page.locator(".page-heading .status-pill")).toHaveText(
    "사용자 대기",
  );
  await expect(page.locator(".run-reason")).toContainText(
    "QA 검토 · QA 진단 검증 CLI",
  );
  await expect(page.locator(".run-reason")).toContainText(
    "authentication required: sign in",
  );
  const before = await (await page.request.get(`/api/sessions/${id}`)).json();
  const qa = before.visits.find((v: any) => v.nodeId === "review");
  expect(qa.attempts).toHaveLength(1);
  await page.screenshot({
    path: "artifacts/screenshots/qa-auth-error-context.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "중지", exact: true }).click();
  await expect(page.locator(".page-heading .status-pill")).toHaveText("중지됨");
  await page.reload();
  await page.getByRole("button", { name: "실행 기록", exact: false }).click();
  await page.getByLabel("실행 세션").selectOption(id);
  await page.getByRole("button", { name: "재개", exact: true }).click();
  await expect(page.locator(".page-heading .status-pill")).toHaveText("완료");
  const after = await (await page.request.get(`/api/sessions/${id}`)).json();
  expect(after.visits.slice(0, 3)).toEqual(before.visits.slice(0, 3));
  expect(after.approvedPlanRef).toEqual(before.approvedPlanRef);
  expect(after.visits.find((v: any) => v.nodeId === "review").id).toBe(qa.id);
  expect(
    after.visits.find((v: any) => v.nodeId === "review").attempts,
  ).toHaveLength(2);
  expect(
    JSON.parse(
      await fs.readFile(path.join(project, ".fixture-calls.json"), "utf8"),
    ),
  ).toEqual({
    planning: 1,
    implementation: 1,
    test: 1,
    review: 2,
    approval: 1,
  });
  await page.screenshot({
    path: "artifacts/screenshots/qa-resume-verified.png",
    fullPage: true,
  });
});

test("reported Kilo QA log events proceed to final approval through the GUI", async ({
  page,
}) => {
  const { id } = await startQaFixture(page, "fixture:qa-regression");
  await expect(page.locator(".page-heading .status-pill")).toHaveText("완료");
  const run = await (await page.request.get(`/api/sessions/${id}`)).json();
  const qa = run.visits.find((v: any) => v.nodeId === "review");
  expect(qa.status).toBe("succeeded");
  expect(qa.attempts).toHaveLength(1);
  expect(qa.attempts[0].failureKind).toBeNull();
  expect(run.visits.at(-1).nodeId).toBe("approval");
});

test("environment-blocked verification displays the cause and resumes only the same test visit", async ({ page }) => {
  const { id, project } = await startQaFixture(page, "fixture:environment-once");
  await expect(page.locator(".page-heading .status-pill")).toHaveText("사용자 대기");
  await expect(page.locator(".run-reason")).toContainText("listen EPERM");
  const before = await (await page.request.get(`/api/sessions/${id}`)).json();
  const visit = before.visits.at(-1);
  expect(visit.nodeId).toBe("test");
  expect(visit.verdict).toBe("BLOCKED");
  await page.screenshot({ path: "artifacts/screenshots/environment-blocked.png", fullPage: true });
  await page.getByRole("button", { name: "재개", exact: true }).click();
  await expect(page.locator(".page-heading .status-pill")).toHaveText("완료");
  const after = await (await page.request.get(`/api/sessions/${id}`)).json();
  expect(after.visits.find((v: any) => v.nodeId === "test").id).toBe(visit.id);
  expect(after.visits.slice(0, 2)).toEqual(before.visits.slice(0, 2));
  expect(JSON.parse(await fs.readFile(path.join(project, ".fixture-calls.json"), "utf8")))
    .toEqual({ planning: 1, implementation: 1, test: 2, review: 1, approval: 1 });
});

test("view changes preserve a pending graph save and unfinished connection input", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "새 그래프", exact: true }).click();
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/graphs/*", async route => {
    if (route.request().method() === "PUT") await pending;
    await route.continue();
  });
  try {
    const saving = page.waitForRequest(request => request.method() === "PUT" && request.url().includes("/api/graphs/"));
    await page.getByLabel("그래프 이름").fill("전환 중 보존하는 초안");
    await saving;
    await page.getByRole("button", { name: "CLI 연결", exact: false }).click();
    await page.getByLabel("연결 이름").fill("아직 등록하지 않은 연결");
    await page.getByRole("button", { name: "그래프 편집", exact: false }).click();
    await expect(page.getByLabel("그래프 이름")).toHaveValue("전환 중 보존하는 초안");
    await page.getByRole("button", { name: "CLI 연결", exact: false }).click();
    await expect(page.getByLabel("연결 이름")).toHaveValue("아직 등록하지 않은 연결");
  } finally { release(); }
  await page.getByRole("button", { name: "그래프 편집", exact: false }).click();
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
});

test("view changes keep one SSE subscription and cancel inactive log polling", async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { streams: 0, createdStreams: 0, activeLogs: 0, maxLogs: 0 };
    (window as any).__studioProbe = probe;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      closed = false;
      constructor(url: string | URL, init?: EventSourceInit) { super(url, init); probe.streams++; probe.createdStreams++; }
      close() { if (!this.closed) { probe.streams--; this.closed = true; } super.close(); }
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (!String(input).includes("/logs?")) return nativeFetch(input, init);
      let finished = false;
      const finish = () => { if (!finished) { finished = true; probe.activeLogs--; } };
      probe.activeLogs++; probe.maxLogs = Math.max(probe.maxLogs, probe.activeLogs);
      init?.signal?.addEventListener("abort", finish, { once: true });
      try { return await nativeFetch(input, init); } finally { finish(); init?.signal?.removeEventListener("abort", finish); }
    };
  });
  await page.route("**/api/sessions/*/logs?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue().catch(() => {});
  });
  await startQaFixture(page, "fixture:qa-auth-once");
  for (let i = 0; i < 3; i++) {
    await expect.poll(() => page.evaluate(() => (window as any).__studioProbe.activeLogs)).toBe(1);
    await page.getByRole("button", { name: "CLI 연결", exact: false }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__studioProbe.activeLogs)).toBe(0);
    await page.getByRole("button", { name: "실행 기록", exact: false }).click();
  }
  const probe = await page.evaluate(() => (window as any).__studioProbe);
  expect(probe.streams).toBe(1); expect(probe.createdStreams).toBe(1); expect(probe.maxLogs).toBe(1);
});

test("a failed lazy view reports the error and reload recovers", async ({ page }) => {
  await page.route("**/assets/ConnectionsView-*.js", route => route.abort());
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await page.getByRole("button", { name: "CLI 연결", exact: false }).click();
  await expect(page.getByRole("heading", { name: "화면을 불러오지 못했습니다" })).toBeVisible();
  await page.unroute("**/assets/ConnectionsView-*.js");
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await page.getByRole("button", { name: "CLI 연결", exact: false }).click();
  await expect(page.getByLabel("연결 이름")).toBeVisible();
});

test("initial graph JavaScript stays under 500 kB and defers other screens and Markdown", async ({ page }) => {
  const scripts = new Map<string, Promise<number>>();
  page.on("response", response => {
    if (/\/assets\/[^?]+\.js$/.test(response.url())) scripts.set(response.url(), response.body().then(body => body.length));
  });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  const bytes = (await Promise.all(scripts.values())).reduce((sum, value) => sum + value, 0);
  expect(bytes).toBeGreaterThan(0); expect(bytes).toBeLessThanOrEqual(500_000);
  expect([...scripts.keys()].some(url => /Markdown-|RunsView-|ConnectionsView-/.test(url))).toBe(false);
  await fs.mkdir("artifacts/verification", { recursive: true });
  await fs.writeFile("artifacts/verification/browser-bundle.json", JSON.stringify({ decodedJavaScriptBytes: bytes, limit: 500_000, assets: [...scripts.keys()].map(url => new URL(url).pathname) }, null, 2));
});
