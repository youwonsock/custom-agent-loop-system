import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  VerificationManifest,
  NodeVisit,
  SessionState,
} from "../shared/domain";
import { nodeTestVerificationCommand } from "./node_test_command";
import { nodeTestScript, nodeTestProofProblem } from "./node_test_policy";
import {
  runNodeTestVerification,
  readNodeTestProof,
} from "./node_test_verification";
import {
  validateManifest,
  lockContract,
  contractViolation,
  verificationRunnerProblem,
} from "./verification_contract";
import { validateCompletion } from "./completion";
import { createAutonomousGraph } from "./graph";
import { deriveRequirementLedger } from "./requirement_ledger";
import { emptyEvidence } from "./event_evidence";
import { emptyCliDiagnostics } from "./cli_diagnostics";
import { SupervisorResult } from "./process_supervisor";
import { buildNodePrompt } from "./prompt";

const adapter = "probes/value.mjs";
function manifest(): VerificationManifest {
  return {
    version: 1,
    protectedFiles: [adapter],
    checks: [
      { id: "node", command: "npm test", requirements: ["REQ-001"] },
      {
        id: "quality",
        command: nodeTestVerificationCommand(),
        requirements: ["REQ-001"],
      },
    ],
    nodeTests: {
      suiteCheckId: "node",
      checkId: "quality",
      scopes: [
        {
          id: "value",
          file: "test/value.test.mjs",
          requirements: ["REQ-001"],
          cases: ["value:correct"],
          challenges: [{ id: "wrong-value", adapter, targets: ["value.mjs"] }],
        },
      ],
    },
  };
}
async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  source = "import test from 'node:test';import a from 'node:assert/strict';import {value} from '../value.mjs';test('value:correct',()=>a.equal(value,1));",
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-node-quality-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "probes"));
  await fs.mkdir(path.join(root, "test"));
  await fs.mkdir(path.join(root, ".agent-graph"));
  const m = manifest();
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: nodeTestScript(m.nodeTests!) },
    }),
  );
  await fs.writeFile(path.join(root, "value.mjs"), "export const value=1;\n");
  await fs.writeFile(path.join(root, "test/value.test.mjs"), source);
  await fs.writeFile(
    path.join(root, adapter),
    "export async function mutate({enabled}){return {'value.mjs':'export const value='+ (enabled?2:1)+';\\n'}}\n",
  );
  await fs.writeFile(
    path.join(root, ".agent-graph/verification.json"),
    JSON.stringify(m),
  );
  return { root, manifest: m };
}

test("own Node verifier proves authored assertions, no-op control and production-defect detection without editing original tests", async (t) => {
  const s = await setup(t),
    before = await fs.readFile(
      path.join(s.root, "test/value.test.mjs"),
      "utf8",
    );
  const r = await runNodeTestVerification({
    target: s.root,
    manifest: s.manifest,
  });
  assert.equal(r.allPassed, true, r.error ?? JSON.stringify(r.scopes));
  assert.equal(r.processesStopped, true);
  assert.equal(r.workspacesRemoved, true);
  assert.deepEqual(r.scopes[0]!.challenges[0]!.killedBy, ["value:correct"]);
  assert.equal(
    await fs.readFile(path.join(s.root, "test/value.test.mjs"), "utf8"),
    before,
  );
  const proof = await readNodeTestProof(s.root, s.manifest.nodeTests!);
  assert.equal(nodeTestProofProblem(s.manifest.nodeTests, proof), null);
  assert.ok(r.workers.length === 3 && r.workers.every((w) => w.stopped));
  const state = {
    targetProjectPath: s.root,
    verificationContract: await lockContract(
      {
        targetProjectPath: s.root,
        requirements: deriveRequirementLedger("goal"),
        graph: {},
      } as SessionState,
      "supplied",
    ),
  } as SessionState;
  assert.equal(await contractViolation(state), null);
  await fs.appendFile(
    path.join(s.root, "test/value.test.mjs"),
    "\n// new authored test source\n",
  );
  await assert.rejects(
    readNodeTestProof(s.root, s.manifest.nodeTests!),
    /현재 소스\/테스트/,
  );
});

test("names and fake stdout cannot substitute for assertions or missing controller/storage/HTTP scopes", async (t) => {
  const s = await setup(
    t,
    'import test from \'node:test\';test(\'value:correct\',()=>console.log(\'{"type":"test:fail","name":"value:correct","code":"ERR_ASSERTION"}\'));',
  );
  const r = await runNodeTestVerification({
    target: s.root,
    manifest: s.manifest,
  });
  assert.equal(r.allPassed, false);
  assert.match(r.error!, /did not detect/);
  assert.equal(r.scopes[0]!.challenges[0]!.killedBy.length, 0);
  const missing = structuredClone(s.manifest);
  missing.nodeTests!.scopes.push({
    ...missing.nodeTests!.scopes[0]!,
    id: "http",
    file: "test/http.test.mjs",
    cases: ["http:raw-boundary"],
    challenges: [{ id: "http-defect", adapter, targets: ["value.mjs"] }],
  });
  await fs.writeFile(
    path.join(s.root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: nodeTestScript(missing.nodeTests!) },
    }),
  );
  const absent = await runNodeTestVerification({
    target: s.root,
    manifest: missing,
  });
  assert.equal(absent.allPassed, false);
  assert.match(absent.error!, /http\.test\.mjs/);
});

test("skipped authored cases and syntax/import failures never become quality passes or mutation kills", async (t) => {
  const s = await setup(
    t,
    "import test from 'node:test';test('value:correct',{skip:true},()=>{});",
  );
  const skipped = await runNodeTestVerification({
    target: s.root,
    manifest: s.manifest,
  });
  assert.equal(skipped.allPassed, false);
  assert.equal(skipped.scopes[0]!.baseline!.summary!.counts.skipped, 1);
  await fs.writeFile(
    path.join(s.root, "test/value.test.mjs"),
    "import test from 'node:test';import a from 'node:assert/strict';import {value} from '../value.mjs';test('value:correct',()=>a.equal(value,1));",
  );
  await fs.writeFile(
    path.join(s.root, adapter),
    "export async function mutate({enabled}){return {'value.mjs':enabled?'export invalid !!!':'export const value=1;'}}",
  );
  const invalid = await runNodeTestVerification({
    target: s.root,
    manifest: s.manifest,
  });
  assert.equal(invalid.allPassed, false);
  assert.equal(invalid.scopes[0]!.challenges[0]!.killedBy.length, 0);
  assert.equal(invalid.processesStopped, true);
});

test("provided oracle imports, mutation edits to tests and masked npm suites are rejected", async (t) => {
  const s = await setup(
    t,
    "import '../probes/value.mjs';import test from 'node:test';test('value:correct',()=>{});",
  );
  const imported = await runNodeTestVerification({
    target: s.root,
    manifest: s.manifest,
  });
  assert.equal(imported.allPassed, false);
  assert.equal(imported.scopes[0]!.baseline!.summary!.success, false);
  await fs.writeFile(
    path.join(s.root, "package.json"),
    JSON.stringify({
      scripts: { test: "node --test test/value.test.mjs || true" },
    }),
  );
  const state = {
    targetProjectPath: s.root,
    verificationContract: { status: "locked", manifest: s.manifest },
  } as SessionState;
  assert.match((await verificationRunnerProblem(state))!, /모든 영역/);
  const bad = structuredClone(s.manifest);
  bad.nodeTests!.scopes[0]!.challenges[0]!.targets = ["test/value.test.mjs"];
  assert.throws(
    () => validateManifest(bad, ["REQ-001"], false),
    /production-only/,
  );
  const provided = structuredClone(s.manifest);
  provided.protectedFiles.push("test/value.test.mjs");
  assert.throws(
    () => validateManifest(provided, ["REQ-001"], false),
    /acceptance files/,
  );
});

test("deadline cancellation preserves a failed report and terminates owned test processes", async (t) => {
  const s = await setup(
    t,
    "import test from 'node:test';test('value:correct',()=>new Promise(()=>setInterval(()=>{},1000)));",
  );
  const r = await runNodeTestVerification({
    target: s.root,
    manifest: s.manifest,
    timeoutMs: 200,
  });
  assert.equal(r.allPassed, false);
  assert.equal(r.processesStopped, true);
  assert.equal(r.workspacesRemoved, true);
  assert.ok(r.error);
  assert.ok(r.workers.every((w) => w.stopped));
  const saved = JSON.parse(
    await fs.readFile(
      path.join(s.root, "verification/node-tests/report.json"),
      "utf8",
    ),
  );
  assert.equal(saved.allPassed, false);
});

test("JSON PASS and read-only approvals require current own-suite proof and separate per-scope judgments", async (t) => {
  const s = await setup(t),
    graph = createAutonomousGraph();
  graph.automation!.browserVerification = false;
  const requirements = deriveRequirementLedger("goal").items,
    contract = await lockContract(
      {
        targetProjectPath: s.root,
        requirements: deriveRequirementLedger("goal"),
        graph,
      } as SessionState,
      "supplied",
    );
  await runNodeTestVerification({ target: s.root, manifest: s.manifest });
  const proof = await readNodeTestProof(s.root, s.manifest.nodeTests!);
  const text = (audit = true) =>
    `[AGENT_REPORT]\n${JSON.stringify({ version: 1, verdict: "PASS", requirements: [{ id: "REQ-001", status: "SATISFIED", evidence: "authored assertion and mutation observed" }], ...(audit ? { testScopes: [{ id: "value", status: "SATISFIED", evidence: "test/value.test.mjs value:correct killed wrong-value; control passed" }] } : {}) })}\n[/AGENT_REPORT]`;
  const result = (assistantText: string): SupervisorResult =>
    ({
      exitCode: 0,
      outcome: "succeeded",
      assistantText,
      evidence: emptyEvidence(),
      diagnostics: emptyCliDiagnostics(),
    }) as SupervisorResult;
  const receipts = s.manifest.checks.map((c) => ({
    id: c.id,
    command: c.command,
    exitCode: 0,
    environmentError: null,
  }));
  const node = graph.nodes.find((n) => n.type === "test")!;
  assert.equal(
    validateCompletion(node, result(text()), {
      goal: "goal",
      requirements,
      commands: receipts,
      priorTestProof: [],
      automation: graph.automation,
      contract,
      cwd: s.root,
    }).verdict,
    "FAIL",
  );
  assert.equal(
    validateCompletion(node, result(text(false)), {
      goal: "goal",
      requirements,
      commands: receipts,
      priorTestProof: [],
      automation: graph.automation,
      contract,
      cwd: s.root,
      nodeTestProof: proof,
    }).valid,
    false,
  );
  const good = validateCompletion(node, result(text()), {
    goal: "goal",
    requirements,
    commands: receipts,
    priorTestProof: [],
    automation: graph.automation,
    contract,
    cwd: s.root,
    nodeTestProof: proof,
  });
  assert.equal(good.valid, true);
  assert.equal(good.verdict, "PASS");
  assert.match(good.output, /NODE_TEST_SCOPE/);
  const approval = graph.nodes.find((n) => n.type === "approval")!,
    approvalText = text().replace('"PASS"', '"APPROVED"');
  assert.equal(
    validateCompletion(approval, result(approvalText), {
      goal: "goal",
      requirements,
      commands: [],
      priorTestProof: receipts,
      automation: graph.automation,
      contract,
      cwd: s.root,
      nodeTestProof: proof,
    }).valid,
    false,
    "approval prose is not inspection evidence",
  );
  assert.equal(
    validateCompletion(approval, result(approvalText), {
      goal: "goal",
      requirements,
      commands: [],
      priorTestProof: receipts,
      automation: graph.automation,
      contract,
      cwd: s.root,
      nodeTestProof: proof,
      inspectedFiles: [
        "test/value.test.mjs",
        "verification/node-tests/report.json",
      ],
    }).verdict,
    "APPROVED",
  );
  const state = {
    id: "session",
    goal: "goal",
    targetProjectPath: s.root,
    graph,
    requirements: deriveRequirementLedger("goal"),
    visits: [],
    accessMode: "ask",
    additionalAllowedPaths: [],
    verificationContract: contract,
  } as unknown as SessionState;
  const visit = {
    id: "review",
    nodeId: "review",
    attempts: [],
    output: "",
  } as unknown as NodeVisit;
  state.visits = [visit];
  const prompt = buildNodePrompt(
    state,
    graph.nodes.find((n) => n.type === "review")!,
    visit,
  );
  assert.match(prompt, /independently read EACH/);
  assert.match(prompt, /testScopes/);
  assert.match(prompt, /supplied acceptance runners/);
});
test("new autonomous npm contracts require own-suite policy while historical graph policy remains readable", async (t) => {
  const s = await setup(t),
    old = structuredClone(s.manifest);
  delete old.nodeTests;
  old.protectedFiles.push("probes/verify-acceptance.mjs");
  await fs.writeFile(
    path.join(s.root, "probes/verify-acceptance.mjs"),
    "// supplied legacy oracle\n",
  );
  old.checks = [
    old.checks[0]!,
    {
      id: "external",
      command: "node probes/verify-acceptance.mjs",
      requirements: ["REQ-001"],
    },
  ];
  await fs.writeFile(
    path.join(s.root, ".agent-graph/verification.json"),
    JSON.stringify(old),
  );
  const state = {
    targetProjectPath: s.root,
    requirements: deriveRequirementLedger("goal"),
    graph: createAutonomousGraph(),
  } as SessionState;
  state.graph.automation!.browserVerification = false;
  await assert.rejects(lockContract(state, "supplied"), /nodeTests/);
  delete state.graph.automation!.authoredNodeTests;
  assert.equal((await lockContract(state, "supplied")).status, "locked");
});
test("a requirement naming npm test cannot be locked by a contract that never runs it", async (t) => {
  const s = await setup(t),
    old = structuredClone(s.manifest);
  delete old.nodeTests;
  old.protectedFiles.push("probes/verify-acceptance.mjs");
  await fs.writeFile(
    path.join(s.root, "probes/verify-acceptance.mjs"),
    "// supplied acceptance runner\n",
  );
  old.checks = [
    {
      id: "acceptance",
      command: "node probes/verify-acceptance.mjs",
      requirements: ["REQ-001"],
    },
  ];
  await fs.writeFile(
    path.join(s.root, ".agent-graph/verification.json"),
    JSON.stringify(old),
  );
  const state = {
    targetProjectPath: s.root,
    requirements: deriveRequirementLedger(
      "npm test runs the project's own node tests.",
    ),
    graph: createAutonomousGraph(),
  } as SessionState;
  state.graph.automation!.browserVerification = false;
  await assert.rejects(lockContract(state, "supplied"), /REQ-001.*npm test/);
  state.requirements = deriveRequirementLedger("goal");
  assert.equal((await lockContract(state, "supplied")).status, "locked");
});
test("one quality run reports weak assertions across multiple scopes instead of consuming a repair visit per first failure", async (t) => {
  const s = await setup(
    t,
    "import test from 'node:test';test('value:correct',()=>{});",
  );
  s.manifest.nodeTests!.scopes.push({
    ...s.manifest.nodeTests!.scopes[0]!,
    id: "http",
    file: "test/http.test.mjs",
    cases: ["http:boundary"],
    challenges: [{ id: "wrong-http", adapter, targets: ["value.mjs"] }],
  });
  await fs.writeFile(
    path.join(s.root, "test/http.test.mjs"),
    "import test from 'node:test';test('http:boundary',()=>{});",
  );
  await fs.writeFile(
    path.join(s.root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: nodeTestScript(s.manifest.nodeTests!) },
    }),
  );
  const result = await runNodeTestVerification({
    target: s.root,
    manifest: s.manifest,
  });
  assert.equal(result.allPassed, false);
  assert.deepEqual(
    result.scopes.map((x) => x.status),
    ["failed", "failed"],
  );
  assert.match(result.error!, /wrong-value/);
  assert.match(result.error!, /wrong-http/);
  assert.equal(result.workers.length, 6);
  assert.equal(result.processesStopped, true);
  assert.equal(result.workspacesRemoved, true);
});
