import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  createGraph,
  createAutonomousGraph,
  validateGraphDocument,
  graphDiagnostics,
} from "./graph";
import { validateCompletion } from "./completion";
import { deriveRequirementLedger } from "./requirement_ledger";
import { emptyEvidence, MutationTracker } from "./event_evidence";
import { emptyCliDiagnostics } from "./cli_diagnostics";
import { SupervisorResult } from "./process_supervisor";
import { buildInvocation } from "./invocation";
import { browserVerificationCommand } from "./browser_command";
import {
  isBrowserVerificationCommand,
  isVerificationCommand,
} from "./verification_evidence";
import { buildNodePrompt } from "./prompt";
import { NodeVisit, SessionState } from "../shared/domain";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  runBrowserVerification,
  validateBrowserSpec,
} from "./browser_verification";
const result = (text: string): SupervisorResult => ({
  pid: 1,
  outcome: "succeeded",
  failureKind: null,
  failureMessage: null,
  exitCode: 0,
  output: text,
  assistantText: text,
  events: [],
  cliSessionId: null,
  startedAt: "",
  endedAt: "",
  timedOut: false,
  cancelled: false,
  rawLogPath: "",
  controlRequest: null,
  autoInjected: [],
  evidence: emptyEvidence(),
  diagnostics: emptyCliDiagnostics(),
});
const g = createAutonomousGraph();
// Existing policy cases exercise the backwards-compatible legacy report profile.
g.automation!.verificationContract = false;
const requirements = deriveRequirementLedger("Build the complete app").items;
const report = (status = "SATISFIED", verdict = "PASS", extra = "") =>
  `[REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001\nSTATUS: ${status}\nEVIDENCE: actual check\nCHECK_COMMAND: npm test\n[/REQUIREMENT_EVIDENCE]\n${extra}\nVERDICT: ${verdict}\n[PHASE_DONE]`;
const receipt = {
  id: "native",
  command: "npm test",
  exitCode: 0,
  environmentError: null,
};
test("autonomous preset is opt-in, persisted, bounded and still requires tests/final approval", () => {
  assert.equal(createGraph().automation, undefined);
  assert.equal(createAutonomousGraph().automation!.verificationContract,true);
  assert.equal(createAutonomousGraph().automation!.authoredNodeTests,true);
  assert.equal(createAutonomousGraph().automation!.testSourceGuard,true);
  assert.equal(createAutonomousGraph().automation!.reserveFinalizationBudget,true);
  assert.equal(createAutonomousGraph().automation!.targetScopeGuard,true);
  assert.equal(createGraph().nodes[0]!.planning!.requiresApproval, true);
  const copy = validateGraphDocument(g);
  assert.deepEqual(copy.automation, g.automation);
  assert.equal(copy.nodes[0]!.planning!.requiresApproval, false);
  assert.equal(copy.nodes[0]!.planning!.optionsCount, 1);
  assert.deepEqual(graphDiagnostics(copy, false), []);
  assert.throws(
    () =>
      validateGraphDocument({
        ...g,
        automation: { ...g.automation, maxRepairCycles: 0 },
      }),
    /자동 수정/,
  );
  assert.equal(
    copy.edges.find((e) => e.source === "approval" && e.outcome === "success")!
      .target,
    "SUCCESS",
  );
});
test("repairable BLOCKED follows FAIL while permission and explicit external evidence still wait", () => {
  const node = g.nodes.find((n) => n.type === "test")!,
    r = result(report("BLOCKED", "BLOCKED", "BLOCKED_KIND: product"));
  assert.equal(
    validateCompletion(node, r, "goal", requirements, [], [], g.automation)
      .verdict,
    "FAIL",
  );
  assert.equal(
    validateCompletion(node, r, "goal", requirements).verdict,
    "BLOCKED",
    "legacy manual behavior remains",
  );
  const permission = {
    ...receipt,
    exitCode: 1,
    environmentError: "listen EPERM",
  };
  assert.match(
    validateCompletion(
      node,
      r,
      "goal",
      requirements,
      [permission],
      [],
      g.automation,
    ).environmentBlocked!,
    /EPERM/,
  );
  assert.equal(
    validateCompletion(
      node,
      result(report("BLOCKED", "BLOCKED", "BLOCKED_KIND: external")),
      "goal",
      requirements,
      [],
      [],
      g.automation,
    ).verdict,
    "BLOCKED",
  );
  assert.equal(
    validateCompletion(
      node,
      result(
        report("BLOCKED", "BLOCKED", "BLOCKED_KIND: product").replace(
          "[PHASE_DONE]",
          "",
        ),
      ),
      "goal",
      requirements,
      [],
      [],
      g.automation,
    ).valid,
    false,
  );
});
test("browser evidence requires the exact installed helper's actual successful receipt", () => {
  const node = g.nodes.find((n) => n.type === "test")!,
    r = result(report());
  assert.equal(
    validateCompletion(
      node,
      r,
      "goal",
      requirements,
      [receipt],
      [],
      g.automation,
    ).valid,
    false,
  );
  const browser = {
    ...receipt,
    id: "browser",
    command: browserVerificationCommand(),
  };
  assert.equal(
    validateCompletion(
      node,
      r,
      "goal",
      requirements,
      [receipt, browser],
      [],
      g.automation,
    ).verdict,
    "PASS",
  );
  assert.equal(isVerificationCommand(browser.command), true);
  for (const command of [
    "node ./fake/cli.js verify-browser --spec .agent-graph/browser.json",
    browser.command + " --help",
    browser.command + "; echo 0",
    browser.command + " &",
  ])
    assert.equal(isBrowserVerificationCommand(command), false, command);
  assert.equal(
    validateCompletion(
      node,
      r,
      "goal",
      requirements,
      [receipt, { ...browser, exitCode: 1 }],
      [],
      g.automation,
    ).verdict,
    "FAIL",
  );
});
test("test production edits are rejected and changed-file evidence survives event retention", () => {
  const tracker = new MutationTracker();
  tracker.observe({
    type: "tool_use",
    part: {
      id: "read",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/project/styles.css" },
      },
    },
  });
  assert.deepEqual(tracker.changedFiles, []);
  tracker.observe({
    type: "tool_use",
    part: {
      id: "edit",
      tool: "edit",
      state: {
        status: "completed",
        input: { filePath: "/project/styles.css" },
      },
    },
  });
  assert.deepEqual(tracker.changedFiles, ["/project/styles.css"]);
  for (let i = 0; i < 1000; i++)
    tracker.observe({ type: "text", part: { text: "later noise" } });
  assert.deepEqual(tracker.changedFiles, ["/project/styles.css"]);
  const r = result(report());
  r.evidence.changedFiles = ["styles.css"];
  const verdict = validateCompletion(
    g.nodes.find((n) => n.type === "test")!,
    r,
    "goal",
    requirements,
    [receipt],
    [],
    g.automation,
  );
  assert.equal(verdict.verdict, "FAIL");
  assert.match(verdict.reason!, /제품 파일 변경/);
  r.evidence.changedFiles = ["tests/game.test.mjs"];
  assert.equal(
    validateCompletion(
      g.nodes.find((n) => n.type === "test")!,
      r,
      "goal",
      requirements,
      [receipt],
      [],
      { ...g.automation!, browserVerification: false },
    ).verdict,
    "PASS",
  );
});
test("native automatic review selects workspace-write without conflicting sandbox flags and never affects read-only roles", async () => {
  const c = {
      id: "fixture",
      label: "fixture",
      type: "codex" as const,
      binary: path.resolve(__dirname, "../../../test/fixture_cli.cjs"),
    },
    b = { connectionId: c.id, modelId: "fixture-model" };
  for (const node of g.nodes) {
    const invocation = await buildInvocation(c, b, node, {
      prompt: "goal",
      cwd: process.cwd(),
      fullAccess: false,
      allowedPaths: [],
      nativeApprovalReview: true,
    });
    const writable = ["implementation", "test"].includes(node.type);
    assert.equal(invocation.args.includes("--approve-for-me"), writable);
    assert.equal(invocation.args.includes("--sandbox"), !writable);
    if (!writable)
      assert.equal(
        invocation.args[invocation.args.indexOf("--sandbox") + 1],
        "read-only",
      );
  }
});
test("Codex local HTTP access pairs networking with a loopback-only proxy and never changes read-only/full-access roles",async()=>{
 const c={id:"fixture",label:"fixture",type:"codex"as const,binary:path.resolve(__dirname,"../../../test/fixture_cli.cjs")},b={connectionId:c.id,modelId:"fixture-model"};
 for(const node of g.nodes){const invocation=await buildInvocation(c,b,node,{prompt:"goal",cwd:process.cwd(),fullAccess:false,allowedPaths:[],nativeApprovalReview:true,localHttpAccess:true});const writable=["implementation","test"].includes(node.type);assert.equal(invocation.args.includes("sandbox_workspace_write.network_access=true"),writable);assert.equal(invocation.args.includes("features.network_proxy.enabled=true"),writable);if(writable){assert.ok(invocation.args.includes('features.network_proxy.domains={"localhost"="allow","127.0.0.1"="allow","::1"="allow"}'));assert.ok(invocation.args.includes("features.network_proxy.allow_local_binding=true"));assert.ok(invocation.args.includes("--approve-for-me"));}}
 const plain=await buildInvocation(c,b,g.nodes.find(n=>n.type==="implementation")!,{prompt:"goal",cwd:process.cwd(),fullAccess:false,allowedPaths:[]});assert.ok(!plain.args.some(a=>a.includes("network_access")));
});
test("an unverified Codex cannot enable local HTTP without known proxy support",async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"codex-network-version-"));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));await fs.writeFile(path.join(cwd,".fixture-codex-version"),"0.100.0");
 await assert.rejects(buildInvocation({id:"fixture",label:"fixture",type:"codex",binary:path.resolve(__dirname,"../../../test/fixture_cli.cjs")},{connectionId:"fixture",modelId:"fixture-model"},g.nodes.find(n=>n.type==="test")!,{prompt:"goal",cwd,fullAccess:false,allowedPaths:[],localHttpAccess:true}),/IO_UNAVAILABLE.*0\.162\.1/);
 await assert.rejects(fs.access(path.join(cwd,"artifact.txt")));
});
test("frozen Codex tests request scoped automatic Chromium review before launch without contradicting first product failure policy",()=>{
 const graph=createAutonomousGraph(),node=graph.nodes.find(n=>n.type==="test")!,visit={id:"native-review",nodeId:node.id,attempts:[],verifiedCommands:[]}as unknown as NodeVisit;
 const state={id:"session",graph,goal:"Verify the game",requirements:deriveRequirementLedger("Verify the game"),visits:[visit],accessMode:"ask",additionalAllowedPaths:[],targetProjectPath:"/work",connections:[{id:"native",type:"codex"}],bindings:{[node.id]:{connectionId:"native",modelId:"gpt-6-luna"}}}as unknown as SessionState;
 const prompt=buildNodePrompt(state,node,visit);assert.match(prompt,/NATIVE CHROMIUM APPROVAL PROCEDURE/);assert.match(prompt,/BEFORE launching that verifier/);assert.match(prompt,/One approval request per exact verifier/);assert.match(prompt,/first failed product check/);assert.doesNotMatch(prompt,/first failed check stops/);
 state.connections[0]!.type="kilo";assert.doesNotMatch(buildNodePrompt(state,node,visit),/NATIVE CHROMIUM APPROVAL PROCEDURE/);
});
test("browser specs reject skipped/empty assertions and invalid bounds before any server starts", () => {
  const spec = {
    version: 1,
    server: { command: ["node", "server.mjs"] },
    steps: [{ id: "bounds", type: "noOverflow" }],
  };
  assert.equal(validateBrowserSpec(spec).steps.length, 1);
  for (const steps of [
    [],
    [{ id: "a", type: "reload" }],
    [{ id: "a", type: "count", selector: ".cell", equals: 0 }],
    [
      { id: "a", type: "noOverflow" },
      { id: "a", type: "noOverflow" },
    ],
    [{ id: "a", type: "http", path: "http://external/", status: 200 }],
  ])
    assert.throws(() => validateBrowserSpec({ ...spec, steps }));
});

test("completion recovery distinguishes absent, failed and reusable native proof", () => {
  const node = g.nodes.find((n) => n.type === "test")!;
  const visit = {
    id: "visit",
    nodeId: node.id,
    attempts: [],
    verifiedCommands: [],
  } as unknown as NodeVisit;
  const state = {
    id: "session",
    graph: g,
    goal: "Build app",
    requirements: deriveRequirementLedger("Build app"),
    visits: [visit],
    accessMode: "ask",
    additionalAllowedPaths: [],
    targetProjectPath: "/work",
  } as unknown as SessionState;
  assert.match(
    buildNodePrompt(state, node, visit, "missing proof"),
    /No current accepted native verification receipt/,
  );
  visit.verifiedCommands = [
    { ...receipt, command: "cd '/work space' && npm test" },
  ];
  assert.match(
    buildNodePrompt(state, node, visit, "format only"),
    /CHECK_COMMAND: cd '\/work space' && npm test/,
  );
  visit.verifiedCommands = [{ ...receipt, exitCode: 1 }];
  assert.match(
    buildNodePrompt(state, node, visit, "format"),
    /formatting cannot turn it into PASS/,
  );
});

test("native shell wrappers preserve the exact installed browser helper including quoted paths", () => {
  const command = browserVerificationCommand();
  const quoted = "'" + command.split("'").join(`'"'"'`) + "'";
  assert.equal(isBrowserVerificationCommand("/bin/zsh -lc " + quoted), true);
  assert.equal(isVerificationCommand("/bin/zsh -lc " + quoted), true);
  assert.equal(isVerificationCommand("/bin/zsh -lc 'npm test; echo 0'"), false);
  assert.equal(isVerificationCommand("/bin/zsh -lc 'npm test | cat'"), false);
});

test("actual shell substitutions never become receipts through Markdown report normalization", () => {
  assert.equal(isVerificationCommand("`npm test`"), false);
  assert.equal(
    isBrowserVerificationCommand("`" + browserVerificationCommand() + "`"),
    false,
  );
});

test("a cancelled verification creates no browser or server and can never report success", async (t) => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "cancelled-browser-"));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort(new Error("cancelled before start"));
  const report = await runBrowserVerification({
    target,
    spec: "missing.json",
    signal: controller.signal,
  });
  assert.equal(report.allPassed, false);
  assert.equal(report.serverPid, null);
  assert.equal(report.serverStopped, true);
  assert.match(report.error!, /cancelled before start/);
  assert.equal(report.steps.length, 0);
});


test("partial native receipts request missing execution instead of report-only recovery", () => {
 const node=g.nodes.find(n=>n.type==="test")!;
 const visit={id:"partial",nodeId:node.id,attempts:[],output:report(),verifiedCommands:[{...receipt,command:browserVerificationCommand()}]} as unknown as NodeVisit;
 const state={id:"session",graph:g,goal:"Build app",requirements:deriveRequirementLedger("Build app"),visits:[visit],accessMode:"ask",additionalAllowedPaths:[],targetProjectPath:"/work"} as unknown as SessionState;
 const partial=buildNodePrompt(state,node,visit,"missing npm receipt");
 assert.match(partial,/Only SOME checks have accepted native receipts/);
 assert.match(partial,/CHECK_COMMAND: npm test/);
 assert.doesNotMatch(partial,/Repair the report without editing files or rerunning checks/);
 visit.verifiedCommands!.push(receipt);
 assert.match(buildNodePrompt(state,node,visit,"format only"),/Repair the report without editing files or rerunning checks/);
});
test("autonomous browser instructions never direct read-only roles to create specs or execute checks", () => {
 for(const node of g.nodes){
  const visit={id:"v",nodeId:node.id,attempts:[],output:""} as unknown as NodeVisit;
  const state={id:"session",graph:g,goal:"Build app",requirements:deriveRequirementLedger("Build app"),visits:[visit],accessMode:"ask",additionalAllowedPaths:[],targetProjectPath:"/work"} as unknown as SessionState;
  const prompt=buildNodePrompt(state,node,visit);
  const writable=["implementation","test"].includes(node.type);
  assert.equal(prompt.includes("Execute this exact platform-owned command directly"),writable);
  assert.equal(prompt.includes("Create the spec only if absent"),node.type==="implementation"|| (node.type==="test"&&!g.automation!.testSourceGuard));
  if(!writable)assert.match(prompt,/never execute it or create\/edit the spec/);
 }
});
