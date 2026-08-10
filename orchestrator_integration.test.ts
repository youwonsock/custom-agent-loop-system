import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { PipelineDefinition } from "./pipeline";

function minimalImplementationPipeline(): PipelineDefinition {
  return {
    version: 1,
    name: "minimal-recovery-pipeline",
    startStageId: "BUILD",
    interruptStageId: "INTERRUPT",
    reentryStageId: "BUILD",
    iterationCompletionStageId: "BUILD",
    roles: [
      { id: "builder", modelRole: "implementer", description: "Build", instructions: "" },
      { id: "failure_brief", modelRole: "interrupter", description: "Brief", instructions: "" },
    ],
    stages: [
      {
        id: "BUILD", name: "Build", role: "builder", kind: "implementation",
        instructions: "", onSuccess: "SUCCESS", onFailure: "INTERRUPT",
        countsIteration: true, requiresPlanApproval: false, planOptionsCount: 0,
      },
      {
        id: "INTERRUPT", name: "Interrupt", role: "failure_brief", kind: "interrupt",
        instructions: "", onSuccess: "PAUSED", onFailure: "PAUSED",
        countsIteration: false, requiresPlanApproval: false, planOptionsCount: 0,
      },
    ],
  };
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for integration state.`);
}

function execFileAsync(
  file: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 5 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : undefined,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function prepareProviderTarget(root: string): Promise<string> {
  const target = path.join(root, "target");
  await fsp.mkdir(target, { recursive: true });
  // The provider process runs from the target directory, while each test may
  // replace the root-level fake implementation between run/resume commands.
  await fsp.writeFile(path.join(target, "run"), "require('../run');\n", "utf8");
  return target;
}

async function readArtifactCorpus(root: string): Promise<string> {
  const chunks: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) chunks.push(await fsp.readFile(entryPath, "utf8"));
    }
  };
  await visit(root);
  return chunks.join("\n");
}

test("run rejects an equal mutable root before spawning the provider", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-unsafe-layout-"));
  try {
    await fsp.writeFile(
      path.join(root, "run"),
      "require('node:fs').writeFileSync('provider-spawned.txt', 'unsafe');\n",
      "utf8"
    );
    const pipelinePath = path.join(root, "pipeline.json");
    await fsp.writeFile(
      pipelinePath,
      JSON.stringify(minimalImplementationPipeline(), null, 2),
      "utf8"
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          path.join(__dirname, "loop_orchestrator.js"),
          "run",
          "--goal", "prove layout preflight",
          "--target", root,
          "--root", root,
          "--session", "unsafe-layout-session",
          "--binary", process.execPath,
          "--profile", "opencode",
          "--pipeline", pipelinePath,
        ],
        root
      ),
      /Unsafe Agent Loop layout/
    );
    await assert.rejects(fsp.access(path.join(root, "provider-spawned.txt")));
    await assert.rejects(fsp.access(path.join(root, ".goal")));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("resolved MCP secrets are redacted from every persisted execution artifact", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-mcp-redaction-"));
  const secret = "mcp-secret-sentinel-0123456789";
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(path.join(root, "models"), "console.log('fake/model');\n", "utf8");
    await fsp.writeFile(
      path.join(root, "loop_config.json"),
      JSON.stringify({
        toolAccess: {
          webSearch: { enabled: false, mode: "cached" },
          mcpServers: [{
            id: "echo",
            name: "Echo",
            enabled: true,
            type: "local",
            command: process.execPath,
            environment: { TOKEN: "${env:MCP_ECHO_SECRET}" },
          }],
        },
      }, null, 2),
      "utf8"
    );
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const config = process.env.OPENCODE_CONFIG_CONTENT || '';",
        "const evidence = '[REQUIREMENT_EVIDENCE]\\nREQ_ID: REQ-001\\nSTATUS: SATISFIED\\nEVIDENCE: secret redaction observed\\n[/REQUIREMENT_EVIDENCE]';",
        "const text = 'provider config=' + config + '\\n' + evidence + '\\n[PHASE_DONE]';",
        "console.log(JSON.stringify({type:'text',id:'secret-echo',part:{id:'secret-part',text}}));",
      ].join("\n"),
      "utf8"
    );
    const pipelinePath = path.join(root, "pipeline.json");
    await fsp.writeFile(
      pipelinePath,
      JSON.stringify(minimalImplementationPipeline(), null, 2),
      "utf8"
    );
    const result = await execFileAsync(
      process.execPath,
      [
        path.join(__dirname, "loop_orchestrator.js"),
        "run",
        "--goal", "redact the provider secret",
        "--target", target,
        "--root", root,
        "--session", "mcp-redaction-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--pipeline", pipelinePath,
        "--phase-timeout", "5000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "1000",
        "--phase-recovery-budget", "60000",
      ],
      root,
      { MCP_ECHO_SECRET: secret }
    );
    const corpus = await readArtifactCorpus(root);
    assert.equal(`${result.stdout}\n${result.stderr}\n${corpus}`.includes(secret), false);
    assert.match(corpus, /\[REDACTED\]/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dist CLI composes separate role and loop files to execute a custom pipeline", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-integration-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(path.join(root, "models"), "console.log('fake/model');\n", "utf8");
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const prompt = process.argv[process.argv.length - 1] || '';",
        "const evidence = '[REQUIREMENT_EVIDENCE]\\nREQ_ID: REQ-001\\nSTATUS: SATISFIED\\nEVIDENCE: fake integration observation\\n[/REQUIREMENT_EVIDENCE]';",
        "let text = 'work complete\\n' + evidence + '\\n[PHASE_DONE]';",
        "if (prompt.includes('Phase: TEST')) text = evidence + '\\nVERDICT: PASS\\n[PHASE_DONE]';",
        "if (prompt.includes('Phase: APPROVE')) {",
        "  console.log(JSON.stringify({type:'item.completed',item:{id:'status',type:'agent_message',text:'Inspecting final evidence.'}}));",
        "  console.log(JSON.stringify({type:'item.completed',item:{id:'final',type:'agent_message',text:evidence + '\\nAPPROVED: acceptance passed.\\n[PHASE_DONE]'}}));",
        "} else {",
        "  console.log(JSON.stringify({type:'text',id:'evt-'+Date.now(),part:{id:'part-'+Date.now(),text}}));",
        "}",
      ].join("\n"),
      "utf8"
    );

    const pipeline: PipelineDefinition = {
      version: 1,
      name: "integration-pipeline",
      startStageId: "BUILD",
      interruptStageId: "INTERRUPT",
      reentryStageId: "BUILD",
      iterationCompletionStageId: "APPROVE",
      stageTypes: [
        { id: "build_work", label: "Build work", executor: "implementation", completionContract: "phase_done", description: "Custom implementation type." },
        { id: "quality_gate", label: "Quality gate", executor: "test", completionContract: "verdict", description: "Custom test type." },
        { id: "release_gate", label: "Release gate", executor: "approval", completionContract: "approval", description: "Custom approval type." },
        { id: "failure_stop", label: "Failure stop", executor: "interrupt", completionContract: "phase_done", description: "Custom interrupt type." },
      ],
      roles: [
        { id: "builder", modelRole: "implementer", description: "Build", instructions: "" },
        { id: "test_specialist", modelRole: "tester", description: "Test", instructions: "" },
        { id: "acceptance", modelRole: "master", description: "Accept", instructions: "" },
        { id: "failure_brief", modelRole: "interrupter", description: "Brief", instructions: "" },
      ],
      stages: [
        {
          id: "BUILD", name: "Build", role: "builder", kind: "build_work",
          instructions: "", onSuccess: "TEST", onFailure: "INTERRUPT",
          countsIteration: true, requiresPlanApproval: false, planOptionsCount: 0,
        },
        {
          id: "TEST", name: "Test", role: "test_specialist", kind: "quality_gate",
          instructions: "", onSuccess: "APPROVE", onFailure: "BUILD",
          countsIteration: false, requiresPlanApproval: false, planOptionsCount: 0,
        },
        {
          id: "APPROVE", name: "Approve", role: "acceptance", kind: "release_gate",
          instructions: "", onSuccess: "SUCCESS", onFailure: "BUILD",
          countsIteration: false, requiresPlanApproval: false, planOptionsCount: 0,
        },
        {
          id: "INTERRUPT", name: "Interrupt", role: "failure_brief", kind: "failure_stop",
          instructions: "", onSuccess: "PAUSED", onFailure: "PAUSED",
          countsIteration: false, requiresPlanApproval: false, planOptionsCount: 0,
        },
      ],
    };
    const rolesPath = path.join(root, "custom-roles.json");
    const loopPath = path.join(root, "custom-loop.json");
    const { roles, ...loopDefinition } = pipeline;
    await fsp.writeFile(rolesPath, JSON.stringify({ version: 1, roles }, null, 2), "utf8");
    await fsp.writeFile(loopPath, JSON.stringify(loopDefinition, null, 2), "utf8");

    const cliPath = path.join(__dirname, "loop_orchestrator.js");
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "run",
        "--goal", "exercise configurable pipeline",
        "--target", target,
        "--root", root,
        "--session", "integration-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--roles", rolesPath,
        "--loop", loopPath,
        "--max-iterations", "2",
        "--phase-timeout", "5000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "1000",
        "--phase-recovery-budget", "60000",
      ],
      root
    );

    const state = JSON.parse(
      await fsp.readFile(
        path.join(root, ".goal", "sessions", "integration-session", "loop_state.json"),
        "utf8"
      )
    ) as {
      status: string;
      pipeline: PipelineDefinition;
      completedIterations: number;
      stageResults: Record<string, unknown>;
    };
    assert.equal(state.status, "SUCCESS");
    assert.equal(state.pipeline.name, "integration-pipeline");
    assert.equal(state.completedIterations, 1);
    assert.deepEqual(Object.keys(state.stageResults).sort(), ["APPROVE", "BUILD", "TEST"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("clean incomplete exit gets one fresh bounded completion recovery session", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-completion-recovery-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const countPath = path.join(__dirname, 'attempt-count.txt');",
        "let count = 0; try { count = Number(fs.readFileSync(countPath, 'utf8')); } catch {}",
        "count += 1; fs.writeFileSync(countPath, String(count));",
        "const prompt = process.argv[process.argv.length - 1] || '';",
        "fs.appendFileSync(path.join(__dirname, 'prompts.jsonl'), JSON.stringify({count,prompt,args:process.argv.slice(2)}) + '\\n');",
        "const text = count === 1 ? 'Files were written but finalization was interrupted.' : 'Recovered and verified.\\n[PHASE_DONE]';",
        "console.log(JSON.stringify({type:'text',id:'evt-'+count,sessionID:'cli-'+count,part:{id:'part-'+count,text}}));",
      ].join("\n"),
      "utf8"
    );
    const pipelinePath = path.join(root, "pipeline.json");
    await fsp.writeFile(
      pipelinePath,
      JSON.stringify(minimalImplementationPipeline(), null, 2),
      "utf8"
    );

    const cliPath = path.join(__dirname, "loop_orchestrator.js");
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "run",
        "--goal", "recover a clean incomplete response",
        "--target", target,
        "--root", root,
        "--session", "completion-recovery-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--pipeline", pipelinePath,
        "--phase-timeout", "2000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "1000",
        "--phase-recovery-budget", "10000",
        "--max-agent-attempts", "1",
        "--completion-recovery-attempts", "1",
      ],
      root
    );

    const prompts = (await fsp.readFile(path.join(root, "prompts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { count: number; prompt: string; args: string[] });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1].prompt, /bounded completion recovery/i);
    assert.doesNotMatch(prompts[1].args.join(" "), /--session cli-1/);
    const state = JSON.parse(
      await fsp.readFile(
        path.join(root, ".goal", "sessions", "completion-recovery-session", "loop_state.json"),
        "utf8"
      )
    ) as { status: string; totalAgentAttempts: number; activeAttempt: { mode: string } };
    assert.equal(state.status, "SUCCESS");
    assert.equal(state.totalAgentAttempts, 2);
    assert.equal(state.activeAttempt.mode, "completion_recovery");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("default planning waits for the user with full center-editor Markdown artifacts", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-planning-ui-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const text = `=== PLAN OPTIONS ===",
        "## OPTION 1: Conservative migration",
        "Keep public APIs stable.",
        "## OPTION 2: Modular extraction",
        "Extract the runtime boundary.",
        "## OPTION 3: Focused rewrite",
        "Replace only the coordinator.",
        "[PHASE_DONE]`;",
        "console.log(JSON.stringify({type:'text',id:'planning-event',part:{id:'planning-part',text}}));",
      ].join("\n"),
      "utf8"
    );

    const cliPath = path.join(__dirname, "loop_orchestrator.js");
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "run",
        "--goal", "review plans in the center editor",
        "--target", target,
        "--root", root,
        "--session", "planning-review-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--phase-timeout", "5000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "1000",
        "--max-agent-attempts", "1",
        "--phase-recovery-budget", "60000",
      ],
      root
    );

    const sessionDir = path.join(root, ".goal", "sessions", "planning-review-session");
    const state = JSON.parse(
      await fsp.readFile(path.join(sessionDir, "loop_state.json"), "utf8")
    ) as {
      status: string;
      awaitingPlanApproval: boolean;
      selectedPlanChoiceId: number | null;
      planOverviewPath: string | null;
    };
    const attemptLogNames = await fsp.readdir(path.join(sessionDir, "attempt_logs"));
    const attemptLogs = await Promise.all(
      attemptLogNames.map(async (name) => ({
        name,
        content: await fsp.readFile(path.join(sessionDir, "attempt_logs", name), "utf8"),
      }))
    );
    assert.equal(
      state.status,
      "WAITING_USER",
      `unexpected planning state: ${JSON.stringify(state, null, 2)}`
    );
    assert.equal(
      state.awaitingPlanApproval,
      true,
      `planning did not reach approval: ${JSON.stringify({ state, attemptLogs }, null, 2)}`
    );
    const choices = JSON.parse(
      await fsp.readFile(path.join(sessionDir, "plan_choices.json"), "utf8")
    ) as Array<{ id: number; title: string; markdownPath: string }>;
    const overview = await fsp.readFile(path.join(sessionDir, "plan_options.md"), "utf8");

    assert.equal(state.selectedPlanChoiceId, null);
    assert.equal(state.planOverviewPath, path.join(sessionDir, "plan_options.md"));
    assert.deepEqual(choices.map((choice) => choice.id), [1, 2, 3]);
    assert.match(overview, /## Option 1: Conservative migration/);
    assert.match(overview, /## Option 3: Focused rewrite/);
    await fsp.access(path.join(sessionDir, choices[1].markdownPath));

    const planPath = path.join(sessionDir, "plan.md");
    const originalPlan = "# Approved baseline\n\nKeep this plan.\n";
    await fsp.writeFile(planPath, originalPlan, "utf8");
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "console.log(JSON.stringify({",
        "  type:'text', id:'revised-plan-event',",
        "  part:{id:'revised-plan-part', text:'# Revised Plan\\n\\nUse the safer path.'}",
        "}));",
      ].join("\n"),
      "utf8"
    );
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "revise-plan",
        "--session", "planning-review-session",
        "--root", root,
        "--message", "use the safer path",
      ],
      root
    );
    const committedPlan = "# Revised Plan\n\nUse the safer path.\n";
    assert.equal(await fsp.readFile(planPath, "utf8"), committedPlan);

    await fsp.writeFile(
      path.join(root, "run"),
      "process.stdout.write('partial revision output'); process.exit(7);\n",
      "utf8"
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          cliPath,
          "revise-plan",
          "--session", "planning-review-session",
          "--root", root,
          "--message", "replace the plan",
        ],
        root
      ),
      /Plan revision was not committed/
    );
    assert.equal(await fsp.readFile(planPath, "utf8"), committedPlan);

    const ownedStatePath = path.join(sessionDir, "loop_state.json");
    const ownedState = JSON.parse(await fsp.readFile(ownedStatePath, "utf8"));
    ownedState.planApproved = true;
    await fsp.writeFile(ownedStatePath, JSON.stringify(ownedState, null, 2), "utf8");
    const ownerId = "live-owner-from-integration-test";
    const now = Date.now();
    await fsp.writeFile(
      path.join(sessionDir, "session_owner.lock"),
      JSON.stringify({
        ownerId,
        ownerPid: process.pid,
        createdAt: new Date(now).toISOString(),
      }),
      "utf8"
    );
    await fsp.writeFile(
      path.join(sessionDir, "session_lease.json"),
      JSON.stringify({
        ownerId,
        ownerPid: process.pid,
        childPid: null,
        acquiredAt: new Date(now).toISOString(),
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      }),
      "utf8"
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          cliPath,
          "resume",
          "--session", "planning-review-session",
          "--root", root,
        ],
        root
      ),
      /already running/
    );
    const stateAfterRejectedResume = JSON.parse(
      await fsp.readFile(ownedStatePath, "utf8")
    ) as { status: string; recoveryCount: number };
    assert.equal(stateAfterRejectedResume.status, "WAITING_USER");
    assert.equal(stateAfterRejectedResume.recoveryCount, ownedState.recoveryCount);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("insufficient named-reference research waits for the user after one planning attempt", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-research-blocked-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(
      path.join(root, "loop_config.json"),
      JSON.stringify({
        toolAccess: {
          webSearch: { enabled: true, mode: "live" },
          mcpServers: [],
        },
      }, null, 2),
      "utf8"
    );
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const evidence = `[RESEARCH_EVIDENCE]",
        "SOURCE: https://example.com/store-listing",
        "LIMITATION: The available listing does not establish the named game's core gameplay.",
        "CONFIDENCE: LOW",
        "[/RESEARCH_EVIDENCE]",
        "RESEARCH_BLOCKED",
        "[PHASE_DONE]`;",
        "console.log(JSON.stringify({type:'item.completed',item:{id:'search',type:'web_search',query:'named game gameplay'}}));",
        "console.log(JSON.stringify({type:'text',id:'planning-event',part:{id:'planning-part',text:evidence}}));",
      ].join("\n"),
      "utf8"
    );

    const cliPath = path.join(__dirname, "loop_orchestrator.js");
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "run",
        "--goal", "인터넷을 검색해서 Named Game과 같은 게임을 제작해",
        "--target", target,
        "--root", root,
        "--session", "research-blocked-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--phase-timeout", "5000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "1000",
        "--max-agent-attempts", "3",
        "--phase-recovery-budget", "60000",
      ],
      root
    );

    const sessionDir = path.join(root, ".goal", "sessions", "research-blocked-session");
    const state = JSON.parse(
      await fsp.readFile(path.join(sessionDir, "loop_state.json"), "utf8")
    ) as {
      status: string;
      statusReason: string | null;
      totalAgentAttempts: number;
      awaitingPlanApproval: boolean;
    };
    assert.equal(state.status, "WAITING_USER");
    assert.match(state.statusReason ?? "", /did not establish.*core gameplay/i);
    assert.equal(state.totalAgentAttempts, 1);
    assert.equal(state.awaitingPlanApproval, false);
    await assert.rejects(fsp.access(path.join(sessionDir, "plan_choices.json")));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("network failure reconnects once with the persisted CLI session", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-reconnect-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const countPath = path.join(__dirname, 'attempt-count.txt');",
        "const argsPath = path.join(__dirname, 'attempt-args.jsonl');",
        "let count = 0;",
        "try { count = Number(fs.readFileSync(countPath, 'utf8')); } catch {}",
        "count += 1;",
        "fs.writeFileSync(countPath, String(count));",
        "fs.appendFileSync(argsPath, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "const emit = (text, sessionID) => console.log(JSON.stringify({type:'text',id:'evt-'+count,sessionID,part:{id:'part-'+count,text}}));",
        "if (count === 1) { emit('temporary network connection lost', 'persisted-cli-session'); process.exit(7); }",
        "emit('Recovered work complete\\n[PHASE_DONE]', 'persisted-cli-session');",
      ].join("\n"),
      "utf8"
    );
    const pipelinePath = path.join(root, "pipeline.json");
    await fsp.writeFile(
      pipelinePath,
      JSON.stringify(minimalImplementationPipeline(), null, 2),
      "utf8"
    );

    const cliPath = path.join(__dirname, "loop_orchestrator.js");
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "run",
        "--goal", "recover the implementation transport",
        "--target", target,
        "--root", root,
        "--session", "reconnect-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--pipeline", pipelinePath,
        "--phase-timeout", "1000",
        "--idle-timeout", "500",
        "--tool-timeout", "500",
        "--transport-timeout", "500",
        "--phase-recovery-budget", "10000",
        "--max-agent-attempts", "3",
        "--retry-backoff", "10,20",
      ],
      root
    );

    const invocations = (await fsp.readFile(path.join(root, "attempt-args.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 2);
    const resumeFlag = invocations[1].indexOf("--session");
    assert.ok(resumeFlag >= 0);
    assert.equal(invocations[1][resumeFlag + 1], "persisted-cli-session");

    const state = JSON.parse(
      await fsp.readFile(
        path.join(root, ".goal", "sessions", "reconnect-session", "loop_state.json"),
        "utf8"
      )
    ) as { status: string; totalAgentAttempts: number };
    assert.equal(state.status, "SUCCESS");
    assert.equal(state.totalAgentAttempts, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("model generation timeout keeps its failure kind and reconnects the persisted CLI session", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-transport-reconnect-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const countPath = path.join(__dirname, 'attempt-count.txt');",
        "const argsPath = path.join(__dirname, 'attempt-args.jsonl');",
        "let count = 0;",
        "try { count = Number(fs.readFileSync(countPath, 'utf8')); } catch {}",
        "count += 1;",
        "fs.writeFileSync(countPath, String(count));",
        "fs.appendFileSync(argsPath, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "const emit = (text) => console.log(JSON.stringify({type:'text',id:'evt-'+count,sessionID:'transport-cli-session',part:{id:'part-'+count,text}}));",
        "if (count === 1) {",
        "  emit('starting remote model stream');",
        "  const delivery = setInterval(() => emit('starting remote model stream'), 100);",
        "  setTimeout(() => clearInterval(delivery), 400);",
        "  setInterval(() => {}, 1000);",
        "}",
        "else { emit('Recovered after transport timeout\\n[PHASE_DONE]'); }",
      ].join("\n"),
      "utf8"
    );
    const pipelinePath = path.join(root, "pipeline.json");
    await fsp.writeFile(
      pipelinePath,
      JSON.stringify(minimalImplementationPipeline(), null, 2),
      "utf8"
    );

    const cliPath = path.join(__dirname, "loop_orchestrator.js");
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "run",
        "--goal", "recover a stalled model stream",
        "--target", target,
        "--root", root,
        "--session", "transport-reconnect-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--pipeline", pipelinePath,
        "--phase-timeout", "2000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "200",
        "--phase-recovery-budget", "10000",
        "--max-agent-attempts", "3",
        "--retry-backoff", "10,20",
      ],
      root
    );

    const invocations = (await fsp.readFile(path.join(root, "attempt-args.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 2);
    const resumeFlag = invocations[1].indexOf("--session");
    assert.ok(
      resumeFlag >= 0,
      (await readArtifactCorpus(root)).slice(-20_000)
    );
    assert.equal(invocations[1][resumeFlag + 1], "transport-cli-session");

    const sessionDir = path.join(root, ".goal", "sessions", "transport-reconnect-session");
    const progress = await fsp.readFile(path.join(sessionDir, "progress_notes.txt"), "utf8");
    assert.match(progress, /idle_timeout/);
    assert.match(progress, /using the existing CLI session/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("token-free transient exhaustion schedules recovery without spending interrupter tokens", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-interrupter-evidence-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const prompt = process.argv[process.argv.length - 1] || '';",
        "if (prompt.includes('Phase: INTERRUPT')) {",
        "  fs.writeFileSync(path.join(__dirname, 'interrupter-prompt.txt'), prompt);",
        "  console.log(JSON.stringify({type:'text',id:'brief',part:{id:'brief-part',text:'Evidence-based briefing\\n[PHASE_DONE]'}}));",
        "} else {",
        "  const event = JSON.stringify({type:'tool_use',id:'tool-event',sessionID:'evidence-cli-session',part:{type:'tool',tool:'bash',state:{status:'completed',input:{command:'Write-Output progress'}}}});",
        "  console.log(event);",
        "  const delivery = setInterval(() => console.log(event), 100);",
        "  setTimeout(() => clearInterval(delivery), 400);",
        "  setInterval(() => {}, 1000);",
        "}",
      ].join("\n"),
      "utf8"
    );
    const pipelinePath = path.join(root, "pipeline.json");
    await fsp.writeFile(
      pipelinePath,
      JSON.stringify(minimalImplementationPipeline(), null, 2),
      "utf8"
    );

    const cliPath = path.join(__dirname, "loop_orchestrator.js");
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "run",
        "--goal", "collect evidence for a stalled implementation",
        "--target", target,
        "--root", root,
        "--session", "interrupter-evidence-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--pipeline", pipelinePath,
        "--phase-timeout", "2000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "200",
        "--phase-recovery-budget", "10000",
        "--max-agent-attempts", "1",
        "--automatic-recovery-backoff", "10",
      ],
      root
    );

    await assert.rejects(fsp.access(path.join(root, "interrupter-prompt.txt")));
    const state = JSON.parse(
      await fsp.readFile(
        path.join(root, ".goal", "sessions", "interrupter-evidence-session", "loop_state.json"),
        "utf8"
      )
    ) as {
      status: string;
      interruptBriefing: string;
      automaticRecovery: { cycle: number; failureKind: string } | null;
    };
    assert.equal(state.status, "RECOVERING");
    assert.match(state.interruptBriefing, /0 with observed token usage/);
    assert.match(state.interruptBriefing, /Disposition: recover_transport/);
    assert.equal(state.automaticRecovery?.cycle, 1);
    assert.equal(
      state.automaticRecovery?.failureKind,
      "idle_timeout",
      (await readArtifactCorpus(root)).slice(-20_000)
    );

    await fsp.writeFile(
      path.join(root, "run"),
      "console.log(JSON.stringify({type:'text',id:'recovered',part:{id:'recovered-part',text:'Recovered without manual intervention\\n[PHASE_DONE]'}}));\n",
      "utf8"
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "resume",
        "--session", "interrupter-evidence-session",
        "--root", root,
        "--recovery",
      ],
      root
    );
    const recoveredState = JSON.parse(
      await fsp.readFile(
        path.join(root, ".goal", "sessions", "interrupter-evidence-session", "loop_state.json"),
        "utf8"
      )
    ) as { status: string; automaticRecovery: unknown; recoveryCount: number };
    assert.equal(recoveredState.status, "SUCCESS");
    assert.equal(recoveredState.automaticRecovery, null);
    assert.equal(recoveredState.recoveryCount, 0, "automatic recovery is not a manual recovery cycle");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("implementation preflight waits for approval, then resumes with requested or full access", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-boundary-root-"));
  const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-boundary-outside-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.mkdir(path.join(outsideRoot, "game"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const prompt = process.argv[process.argv.length - 1] || '';",
        "if (prompt.includes('Phase: INTERRUPT')) {",
        "  console.log(JSON.stringify({type:'text',id:'brief',part:{id:'brief-part',text:'Boundary conflict reported\\n[PHASE_DONE]'}}));",
        "} else {",
        "  fs.writeFileSync(path.join(__dirname, 'builder-was-spawned.txt'), 'unexpected');",
        "  console.log(JSON.stringify({type:'text',id:'build',part:{id:'build-part',text:'Unexpected build\\n[PHASE_DONE]'}}));",
        "}",
      ].join("\n"),
      "utf8"
    );
    const pipelinePath = path.join(root, "pipeline.json");
    await fsp.writeFile(
      pipelinePath,
      JSON.stringify(minimalImplementationPipeline(), null, 2),
      "utf8"
    );

    await execFileAsync(
      process.execPath,
      [
        path.join(__dirname, "loop_orchestrator.js"),
        "run",
        "--goal", `Write the game to ${path.join(outsideRoot, "game")}`,
        "--target", target,
        "--root", root,
        "--session", "boundary-preflight-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--pipeline", pipelinePath,
        "--phase-timeout", "2000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "1000",
        "--phase-recovery-budget", "10000",
        "--max-agent-attempts", "1",
      ],
      root
    );

    await assert.rejects(fsp.access(path.join(root, "builder-was-spawned.txt")));
    const state = JSON.parse(
      await fsp.readFile(
        path.join(root, ".goal", "sessions", "boundary-preflight-session", "loop_state.json"),
        "utf8"
      )
    ) as { status: string; lastFailure: { kind: string; message: string } | null; totalAgentAttempts: number };
    assert.equal(state.status, "WAITING_USER");
    assert.equal(state.lastFailure?.kind, "permission");
    assert.match(state.lastFailure?.message ?? "", /outside the configured write-access roots/);
    assert.equal(state.totalAgentAttempts, 0, "no agent should spawn before access approval");
    const accessState = state as typeof state & {
      pendingAccessRequest: { requestedPaths: string[] } | null;
      accessMode: string;
    };
    assert.equal(accessState.accessMode, "ask");
    assert.deepEqual(accessState.pendingAccessRequest?.requestedPaths, [path.join(outsideRoot, "game")]);

    await execFileAsync(
      process.execPath,
      [
        path.join(__dirname, "loop_orchestrator.js"),
        "resume",
        "--session", "boundary-preflight-session",
        "--root", root,
        "--approve-access",
      ],
      root
    );

    await fsp.access(path.join(root, "builder-was-spawned.txt"));
    const resumedState = JSON.parse(
      await fsp.readFile(
        path.join(root, ".goal", "sessions", "boundary-preflight-session", "loop_state.json"),
        "utf8"
      )
    ) as { status: string; additionalAllowedPaths: string[]; totalAgentAttempts: number };
    assert.equal(resumedState.status, "SUCCESS");
    assert.deepEqual(resumedState.additionalAllowedPaths, [path.join(outsideRoot, "game")]);
    assert.equal(resumedState.totalAgentAttempts, 1);

    await execFileAsync(
      process.execPath,
      [
        path.join(__dirname, "loop_orchestrator.js"),
        "run",
        "--goal", `Write another game to ${path.join(outsideRoot, "full-access-game")}`,
        "--target", target,
        "--root", root,
        "--session", "boundary-full-access-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--pipeline", pipelinePath,
        "--phase-timeout", "2000",
        "--idle-timeout", "1000",
        "--tool-timeout", "1000",
        "--transport-timeout", "1000",
        "--phase-recovery-budget", "10000",
        "--max-agent-attempts", "1",
        "--full-access",
      ],
      root
    );
    const fullAccessState = JSON.parse(
      await fsp.readFile(
        path.join(root, ".goal", "sessions", "boundary-full-access-session", "loop_state.json"),
        "utf8"
      )
    ) as { status: string; accessMode: string; pendingAccessRequest: unknown };
    assert.equal(fullAccessState.status, "SUCCESS");
    assert.equal(fullAccessState.accessMode, "full_access");
    assert.equal(fullAccessState.pendingAccessRequest, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outsideRoot, { recursive: true, force: true });
  }
});

test("STOP cancels a persisted retry backoff before another attempt starts", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-backoff-stop-"));
  try {
    const target = await prepareProviderTarget(root);
    await fsp.writeFile(
      path.join(root, "run"),
      [
        "console.log(JSON.stringify({",
        "  type:'text', id:'network-failure', sessionID:'backoff-cli-session',",
        "  part:{id:'network-part', text:'temporary network connection lost'}",
        "}));",
        "process.exit(7);",
      ].join("\n"),
      "utf8"
    );
    const pipelinePath = path.join(root, "pipeline.json");
    await fsp.writeFile(
      pipelinePath,
      JSON.stringify(minimalImplementationPipeline(), null, 2),
      "utf8"
    );
    const cliPath = path.join(__dirname, "loop_orchestrator.js");
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "run",
        "--goal", "stop during retry backoff",
        "--target", target,
        "--root", root,
        "--session", "backoff-stop-session",
        "--binary", process.execPath,
        "--profile", "opencode",
        "--pipeline", pipelinePath,
        "--phase-timeout", "1000",
        "--idle-timeout", "500",
        "--tool-timeout", "500",
        "--transport-timeout", "500",
        "--phase-recovery-budget", "10000",
        "--max-agent-attempts", "3",
        "--retry-backoff", "2000,2000",
      ],
      { cwd: root, windowsHide: true }
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const sessionDir = path.join(root, ".goal", "sessions", "backoff-stop-session");
    await waitFor(async () => {
      try {
        const state = JSON.parse(
          await fsp.readFile(path.join(sessionDir, "loop_state.json"), "utf8")
        ) as {
          activeAttempt: { nextRetryAt: string | null } | null;
          agentStates: Record<string, { status: string }>;
        };
        return state.activeAttempt?.nextRetryAt &&
          state.agentStates.builder?.status === "retry_wait"
          ? state
          : null;
      } catch {
        return null;
      }
    });

    const requestId = "control_migrate_0123456789ab";
    const requestsDir = path.join(sessionDir, "control", "requests");
    await fsp.mkdir(requestsDir, { recursive: true });
    await fsp.writeFile(
      path.join(requestsDir, `${requestId}.json`),
      JSON.stringify({
        requestId,
        type: "STOP",
        createdAt: new Date().toISOString(),
        message: null,
      }),
      "utf8"
    );
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`STOP integration process timed out.\n${stderr}`));
      }, 10_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr);

    const state = JSON.parse(
      await fsp.readFile(path.join(sessionDir, "loop_state.json"), "utf8")
    ) as { status: string; totalAgentAttempts: number };
    const ack = JSON.parse(
      await fsp.readFile(
        path.join(sessionDir, "control", "acks", `${requestId}.json`),
        "utf8"
      )
    ) as { result: string; completedAt: string | null };
    assert.equal(state.status, "STOPPED");
    assert.equal(state.totalAgentAttempts, 1);
    assert.equal(ack.result, "completed");
    assert.ok(ack.completedAt);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
