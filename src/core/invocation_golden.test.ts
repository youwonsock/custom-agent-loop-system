import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createAutonomousGraph } from "./graph";
import { buildInvocation } from "./invocation";
import programIo = require("./program_io");
import { LocalConnection, NODE_TYPES } from "../shared/domain";

// Golden invocations pin each CLI's argv and the environment the app adds,
// before invocation.ts is split per service. Windows differs (PowerShell hint,
// pipe transport), so goldens are kept per platform family.
// Regenerate only for an intended change: UPDATE_GOLDEN=1 npm test
const family = process.platform === "win32" ? "win32" : "posix";
const goldenDir = path.resolve(
  __dirname,
  "../../../test/golden/invocation",
  family,
);
const update = process.env.UPDATE_GOLDEN === "1";
const fixture = path.resolve(__dirname, "../../../test/fixture_cli.cjs");
const plugin = pathToFileURL(
  path.join(__dirname, "kilo_protocol_plugin.js"),
).href;
const appPath = [path.dirname(process.execPath), process.env.PATH ?? ""]
  .filter(Boolean)
  .join(path.delimiter);
const graph = createAutonomousGraph();
const parsedEnv = new Set([
  "KILO_CONFIG_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
  "AGENT_GRAPH_KILO_CHECKS",
  "AGENT_GRAPH_PROGRAM_IO",
]);
// Set by the app for some variants; a developer's own values would hide them from the diff.
const inheritedConfig =
  /^(?:XDG_|KILO_|OPENCODE_CONFIG|GIT_|DYLD_|LD_)|^(?:SHELL|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH)$/;
function normalizer(root: string, target: string, extra: string) {
  const tokens: Array<[string, string]> = [
    [appPath, "<PATH>"],
    [plugin, "<PLUGIN_URL>"],
    [fixture, "<FIXTURE>"],
    [process.execPath, "<NODE>"],
    [__dirname, "<DIST_CORE>"],
    [target, "<TARGET>"],
    [extra, "<EXTRA>"],
    [root, "<ROOT>"],
    [fs.realpathSync(root), "<ROOT>"],
    [os.homedir(), "<USER_HOME>"],
  ];
  const forms = tokens
    .flatMap(([value, token]) => {
      const slashed = value.replace(/\\/g, "/");
      return [
        value,
        slashed,
        JSON.stringify(value).slice(1, -1),
        JSON.stringify(slashed).slice(1, -1),
      ].map((v) => [v, token] as const);
    })
    .sort((a, b) => b[0].length - a[0].length); // Longest first: the app PATH may be just the node directory, a prefix of <NODE>.
  const text = (s: string) =>
    forms.reduce((out, [value, token]) => out.split(value).join(token), s);
  const walk = (value: unknown): unknown =>
    typeof value === "string"
      ? text(value)
      : Array.isArray(value)
        ? value.map(walk)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [text(k), walk(v)]),
            )
          : value;
  return walk;
}
// Only what the app adds, changes or removes relative to the inherited environment.
// Windows names are case-insensitive, so "Path" -> "PATH" is a change, not a removal.
const envKey = (key: string) =>
  process.platform === "win32" ? key.toUpperCase() : key;
const byKey = (env: Record<string, string | undefined>) =>
  new Map(
    Object.entries(env)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([k, v]) => [envKey(k), v]),
  );
function envDiff(env: Record<string, string>): Record<string, unknown> {
  const before = byKey(process.env),
    after = byKey(env),
    diff: Record<string, unknown> = {};
  for (const key of [...after.keys()].sort())
    if (before.get(key) !== after.get(key))
      diff[key] = parsedEnv.has(key)
        ? JSON.parse(after.get(key)!)
        : after.get(key);
  for (const key of [...before.keys()].sort())
    if (!after.has(key)) diff[key] = null;
  return diff;
}
function matchGolden(name: string, actual: unknown): void {
  const file = path.join(goldenDir, name),
    text = JSON.stringify(actual, null, 2) + "\n";
  if (update) {
    fs.mkdirSync(goldenDir, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(
    fs.existsSync(file),
    `missing golden ${family}/${name}; run UPDATE_GOLDEN=1 npm test`,
  );
  assert.equal(
    text,
    fs.readFileSync(file, "utf8"),
    `${family}/${name} changed; update goldens only for an intended invocation change`,
  );
}
type Options = Parameters<typeof buildInvocation>[3];
const variants: Array<{
  name: string;
  services: LocalConnection["type"][];
  variant?: string;
  posixOnly?: boolean;
  env?: Record<string, string>;
  opts: (target: string, extra: string, root: string) => Partial<Options>;
}> = [
  {
    name: "base",
    services: ["codex", "claude", "opencode", "kilo"],
    opts: () => ({}),
  },
  {
    name: "scoped-resume",
    services: ["codex", "claude", "opencode", "kilo"],
    variant: "high",
    opts: (_t, extra) => ({ allowedPaths: [extra], resumeId: "resume-1" }),
  },
  {
    name: "full-access",
    services: ["codex", "claude", "opencode", "kilo"],
    opts: () => ({ fullAccess: true }),
  },
  {
    name: "native-http",
    services: ["codex"],
    opts: () => ({ nativeApprovalReview: true, localHttpAccess: true }),
  },
  {
    name: "guarded",
    services: ["kilo"],
    opts: (target, extra) => ({
      verificationCommands: ["npm test"],
      guardOwnedProcesses: true,
      testSourcesReadOnly: true,
      scopeRoots: [target, extra],
      verificationAliases: { "npm test": "node --test" },
    }),
  },
  {
    name: "disable-write",
    services: ["kilo"],
    opts: () => ({ disableWrite: true }),
  },
  {
    // The argv and config around program isolation. prepareProgramIo is replaced,
    // so no VM is needed; the VM itself is covered by program_io.test.ts on macOS.
    name: "program-io",
    services: ["kilo"],
    posixOnly: true,
    env: {
      KILO_CONFIG_CONTENT: JSON.stringify({
        model: "native-model",
        provider: { native: {} },
        mcp: { dropped: {} },
        plugin: ["dropped"],
      }),
    },
    opts: (target, _extra, root) => ({
      scopeRoots: [target],
      verificationCommands: ["npm test"],
      guardOwnedProcesses: true,
      testSourcesReadOnly: true,
      programIoGuard: {
        directory: path.join(root, "program-io"),
        protectedFiles: ["verification/contract.json"],
        expiresAt: 1,
      },
    }),
  },
];

test(
  "invocation goldens: argv and added environment per service, role and option set",
  {
    skip:
      !update && !fs.existsSync(goldenDir)
        ? `no ${family} invocation goldens yet; generate them on this platform with UPDATE_GOLDEN=1`
        : false,
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "invocation-golden-")),
      target = path.join(root, "project"),
      extra = path.join(root, "shared");
    fs.mkdirSync(target);
    fs.mkdirSync(extra);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // A developer's own native CLI config would otherwise leak into the merged config goldens.
    for (const key of Object.keys(process.env))
      if (parsedEnv.has(key) || inheritedConfig.test(key)) {
        const saved = process.env[key]!;
        delete process.env[key];
        t.after(() => {
          process.env[key] = saved;
        });
      }
    t.mock.method(programIo, "prepareProgramIo", ((options) => {
      fs.mkdirSync(options.directory, { recursive: true });
      return {
        version: 1,
        id: "golden-policy",
        cwd: options.cwd,
        directory: options.directory,
        node: "/golden/node",
        runner: "/golden/program_io_runner.js",
        bootstrap: "/golden/program_io_bootstrap.js",
        profile: "{}",
        profileDigest: "golden-digest",
        publicKey: "golden-public-key",
        privateKey: "golden-private-key",
        expiresAt: options.expiresAt,
        writableRoots: [options.cwd],
        runtimeReadRoots: [],
        scratch: path.join(options.directory, "scratch"),
        preflightPassed: true,
        browserPath: "/ms-playwright",
        backend: "apple-container-vm",
      };
    }) as typeof programIo.prepareProgramIo);
    const normalize = normalizer(root, target, extra);
    for (const v of variants) {
      if (v.posixOnly && family !== "posix") continue;
      for (const [key, value] of Object.entries(v.env ?? {}))
        process.env[key] = value;
      for (const type of v.services) {
        const connection: LocalConnection = {
          id: "conn",
          label: "Golden CLI",
          type,
          binary: fixture,
        };
        const binding = {
          connectionId: "conn",
          modelId: "golden-model",
          ...(v.variant ? { variant: v.variant } : {}),
        };
        const byRole: Record<string, unknown> = {};
        for (const node of NODE_TYPES.map((n) =>
          graph.nodes.find((g) => g.type === n)!,
        )) {
          const invocation = await buildInvocation(connection, binding, node, {
            prompt: "GOLDEN PROMPT",
            cwd: target,
            fullAccess: false,
            allowedPaths: [],
            ...v.opts(target, extra, root),
          });
          byRole[node.type] = normalize({
            binary: invocation.binary,
            args: invocation.args,
            env: envDiff(invocation.env),
            transport: invocation.transport ?? null,
          });
        }
        matchGolden(`${type}-${v.name}.json`, byRole);
      }
      for (const key of Object.keys(v.env ?? {})) delete process.env[key];
    }
  },
);
