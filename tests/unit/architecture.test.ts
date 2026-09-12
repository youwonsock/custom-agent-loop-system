import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const root = process.cwd();

function filesBelow(directory: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesBelow(candidate));
    else result.push(candidate);
  }
  return result;
}

test("current production architecture has one model runner and no legacy workflow implementation", () => {
  const sourceFiles = filesBelow(path.join(root, "src"))
    .filter((file) => file.endsWith(".ts"));
  const source = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const legacyFiles = [
    "agent_roles.json",
    "agent_loop.json",
    "loop_state.ts",
    "planning_stage_executor.ts",
    "implementation_stage_executor.ts",
    "test_stage_executor.ts",
    "review_stage_executor.ts",
    "approval_stage_executor.ts",
    "interrupt_stage_executor.ts",
    "stage_outcome.ts",
  ];
  for (const file of legacyFiles) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} must be deleted`);
  }
  assert.equal((source.match(/\.runtime\.execute\(/gu) ?? []).length, 2);
  assert.match(
    fs.readFileSync(path.join(root, "src", "application", "agent-task-runner.ts"), "utf8"),
    /class DefaultAgentTaskRunner/u
  );
  assert.doesNotMatch(source, /commitPhaseResult|applyPipelineTarget|legacy_text/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:langgraph|crewai)[^"']*["']/iu);
});

test("domain and task policies cannot import infrastructure or mutate repositories", () => {
  const domain = filesBelow(path.join(root, "src", "domain"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    domain,
    /from\s+["'][^"']*(?:application|infrastructure|runtime|interfaces)[^"']*["']/u
  );

  for (const directory of [
    path.join(root, "src", "tasks", "guardrails"),
    path.join(root, "src", "tasks", "effects"),
  ]) {
    const policySource = filesBelow(directory)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    assert.doesNotMatch(policySource, /run-repository|transition-router|\.commit\(/u);
  }
});

test("desktop operator consumes a projection and cannot author the aggregate", () => {
  const operatorRoot = path.join(root, "src", "interfaces", "operator");
  const projection = fs.readFileSync(path.join(operatorRoot, "run-projection.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(operatorRoot, "contracts.ts"), "utf8");
  assert.match(projection, /FileRunProjection/u);
  assert.match(contracts, /RunProjectionV2|SessionIndexProjectionV4/u);
  const desktopSources = filesBelow(path.join(root, "desktop-app", "src"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.match(desktopSources, /DesktopBridge|desktop:getSnapshot/u);
  assert.doesNotMatch(desktopSources, /nodeIntegration:\s*true/u);
});
