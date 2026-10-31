#!/usr/bin/env node
// Runs the fixed scenario in test/real-cli through a real CLI and a real model.
// This costs model usage, so it is never part of npm test or CI.
//   node scripts/real-cli-regression.js claude [--model <text in the model ID>]
//   node scripts/real-cli-regression.js kilo   [--model <text in the model ID>]
// Results stay in artifacts/real-cli/. Pass criteria are in docs/STATUS.md (G4).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const repository = path.resolve(__dirname, "..");
const dist = (file) => path.join(repository, "dist/src", file);
const { StudioStore } = require(dist("core/store.js"));
const { queryModels } = require(dist("core/catalog.js"));
const { createAutonomousGraph } = require(dist("core/graph.js"));
const { SessionCoordinator } = require(dist("server/coordinator.js"));

const GOAL = [
  "Implement slugify(text) in slug.mjs as a named export that lowercases text, replaces each run of non-alphanumeric characters with one hyphen and trims leading and trailing hyphens.",
  "Document the function with one usage example in README.md.",
].join("\n");
const SESSION_LIMIT_MS = 30 * 60 * 1000;
const SETTLED = [
  "SUCCESS",
  "PAUSED",
  "WAITING_USER",
  "BLOCKED",
  "STOPPED",
  "FAILED",
];
const PROFILES = {
  claude: {
    binary: "claude",
    pick: (m) => /haiku/i.test(m.id),
    automation: {},
    // Headless Claude asks for nothing, so the target allows exactly what this scenario needs.
    claudeSettings: {
      permissions: {
        allow: [
          "Edit",
          "Write",
          "Bash(npm test)",
          "Bash(npm test:*)",
          "Bash(node --test:*)",
          "Bash(ls:*)",
          "Bash(cat:*)",
        ],
      },
    },
  },
  kilo: {
    binary: "kilo",
    pick: (m) => m.pricing?.status === "free",
    automation: { targetScopeGuard: true, programIoGuard: true },
  },
};

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
function summarize(state) {
  const audits = state.visits
    .flatMap((v) => v.attempts)
    .map((a) => a.programIoAudit)
    .filter(Boolean);
  const total = (key) => audits.reduce((sum, a) => sum + a[key], 0);
  const node = (id) => state.graph.nodes.find((n) => n.id === id)?.type ?? id;
  return {
    status: state.status,
    reason: state.statusReason,
    visits: state.visits.map((v) => ({
      node: node(v.nodeId),
      status: v.status,
      verdict: v.verdict,
      attempts: v.attempts.map((a) => ({
        status: a.status,
        failureKind: a.failureKind,
        model: a.actualModelId ?? a.requestedModelId,
        accepted: a.completionAccepted ?? null,
        fileMutation: a.fileMutation ?? null,
        commands: (a.commands ?? []).map((c) => `${c.exitCode} ${c.command}`),
      })),
    })),
    vm: audits.length
      ? {
          attemptsWithAudit: audits.length,
          nativeCommands: total("nativeCommands"),
          completedCommands: total("completedCommands"),
          unwrappedCommands: total("unwrappedCommands"),
          unresolvedCommands: total("unresolvedCommands"),
          invalidReceipts: total("invalidReceipts"),
          containersRemoved: audits
            .flatMap((a) => a.commands)
            .every((c) => c.containerRemoved),
        }
      : null,
  };
}
function passed(profile, summary) {
  if (profile === "claude") return summary.status === "SUCCESS";
  const vm = summary.vm;
  return (
    !!vm &&
    vm.nativeCommands > 0 &&
    vm.completedCommands === vm.nativeCommands &&
    vm.unwrappedCommands === 0 &&
    vm.unresolvedCommands === 0 &&
    vm.invalidReceipts === 0 &&
    vm.containersRemoved &&
    summary.status !== "BLOCKED"
  );
}
async function main() {
  const profile = process.argv[2],
    config = PROFILES[profile];
  if (!config)
    throw new Error("Usage: real-cli-regression.js claude|kilo [--model text]");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"),
    output = path.join(repository, "artifacts/real-cli", `${profile}-${stamp}`),
    // Outside the repository: the VM mounts this checkout read-only, so a target
    // nested inside it cannot be mounted and the run stops before any model call.
    target = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-real-cli-")),
      "target",
    );
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(repository, "test/real-cli/slugify"), target, {
    recursive: true,
  });
  if (config.claudeSettings) {
    fs.mkdirSync(path.join(target, ".claude"));
    fs.writeFileSync(
      path.join(target, ".claude/settings.json"),
      JSON.stringify(config.claudeSettings, null, 2),
    );
  }
  const store = new StudioStore(path.join(output, "root"));
  await store.init();
  const binary = execFileSync("/usr/bin/which", [config.binary], {
    encoding: "utf8",
  }).trim();
  const connection = await store.saveConnection({
    id: profile,
    label: `Regression ${profile}`,
    type: profile,
    binary,
  });
  const catalog = await queryModels(connection, target);
  const wanted = option("model");
  const model = catalog.models.find((m) =>
    wanted ? m.id.includes(wanted) : config.pick(m),
  );
  if (!model)
    throw new Error(
      `No matching ${profile} model (${catalog.status}): ${catalog.error ?? catalog.models.map((m) => m.id).join(", ")}`,
    );
  const document = createAutonomousGraph(`Regression ${profile}`);
  document.defaultBinding = { connectionId: profile, modelId: model.id };
  document.automation = {
    maxRepairCycles: 3,
    nativeApprovalReview: false,
    browserVerification: false,
    verificationContract: true,
    authoredNodeTests: false,
    testSourceGuard: true,
    reserveFinalizationBudget: true,
    guardOwnedProcesses: true,
    targetScopeGuard: false,
    programIoGuard: false,
    ...config.automation,
  };
  const graph = await store.createGraph({ document });
  const manager = new SessionCoordinator(store);
  const started = Date.now();
  process.stdout.write(`${profile}: model ${model.id}, output ${output}\n`);
  let state = await manager.start({
    requestId: crypto.randomUUID(),
    graphId: graph.id,
    expectedRevision: graph.revision,
    goal: GOAL,
    targetProjectPath: target,
    accessMode: "ask",
    settings: { sessionTimeoutMs: SESSION_LIMIT_MS, maxSessionAttempts: 16 },
  });
  while (!SETTLED.includes(state.status)) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    state = await store.readSession(state.id);
    if (Date.now() - started > SESSION_LIMIT_MS + 5 * 60 * 1000) {
      await manager.action(state.id, {
        type: "stop",
        requestId: crypto.randomUUID(),
      });
      break;
    }
  }
  await manager.close();
  const summary = {
    profile,
    model: model.id,
    pricing: model.pricing ?? null,
    session: state.id,
    target,
    seconds: Math.round((Date.now() - started) / 1000),
    pass: false,
    ...summarize(state),
  };
  summary.pass = passed(profile, summary);
  fs.writeFileSync(
    path.join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exitCode = summary.pass ? 0 : 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
