import { createHash } from "node:crypto";
import * as path from "node:path";
import { canonicalJson, type JsonObject, type JsonValue } from "./json";

/** A command approved by the operator and executed by the core process. */
export interface VerificationCommandSpec {
  id: string;
  label: string;
  executable: string;
  args: string[];
  /** Relative to the approved project root. */
  cwd: string;
  timeoutMs: number;
  requirementIds: string[];
}

export interface VerificationContractDraft {
  commands: VerificationCommandSpec[];
  totalTimeoutMs: number;
  protectedPaths: string[];
  testRoots: string[];
  allowedNewTestRoots: string[];
  generatedOutputPaths: string[];
}

function relativePolicyPath(value: string): string {
  const raw = value.replace(/\\/gu, "/").trim();
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//u.test(raw) || raw.split("/").some((part) => part === "..")) {
    throw new Error(`Verification policy path must be project-relative: ${value}`);
  }
  const normalized = raw.replace(/^\.\//u, "").replace(/\/+$/u, "");
  return normalized || ".";
}

/** Validate the operator-visible verification contract before it is persisted. */
export function validateVerificationContractDraft(
  draft: Readonly<VerificationContractDraft>,
  requirementIds?: ReadonlySet<string>
): void {
  if (!Array.isArray(draft.commands) || draft.commands.length < 1 || draft.commands.length > 10) {
    throw new Error("Verification contract must contain between 1 and 10 commands.");
  }
  if (!Number.isSafeInteger(draft.totalTimeoutMs) || draft.totalTimeoutMs < 1 || draft.totalTimeoutMs > 24 * 60 * 60 * 1000) {
    throw new Error("Verification contract total timeout is invalid.");
  }
  const ids = new Set<string>();
  for (const command of draft.commands) {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error("Verification contract contains an invalid command.");
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(command.id) || ids.has(command.id)) {
      throw new Error(`Verification command id is duplicated or unsafe: ${command.id}.`);
    }
    ids.add(command.id);
    if (!command.label.trim() || !command.executable.trim()) throw new Error(`Verification command ${command.id} requires a label and executable.`);
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 24 * 60 * 60 * 1000) throw new Error(`Verification command ${command.id} timeout is invalid.`);
    if (typeof command.cwd !== "string") throw new Error(`Verification command ${command.id} cwd must be a string.`);
    relativePolicyPath(command.cwd);
    if (!Array.isArray(command.requirementIds) || command.requirementIds.length === 0 || new Set(command.requirementIds).size !== command.requirementIds.length) {
      throw new Error(`Verification command ${command.id} must reference at least one unique requirement.`);
    }
    if (requirementIds && command.requirementIds.some((id) => !requirementIds.has(id))) {
      throw new Error(`Verification command ${command.id} references an unknown requirement.`);
    }
  }
  const policyFields: Array<"protectedPaths" | "testRoots" | "allowedNewTestRoots" | "generatedOutputPaths"> = [
    "protectedPaths", "testRoots", "allowedNewTestRoots", "generatedOutputPaths",
  ];
  const normalized = new Map<keyof VerificationContractDraft, string[]>();
  for (const field of policyFields) {
    const values = draft[field];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new Error(`Verification ${field} must be a unique array.`);
    const normalizedValues = values.map(relativePolicyPath);
    if (new Set(normalizedValues).size !== normalizedValues.length) throw new Error(`Verification ${field} must be a unique array.`);
    normalized.set(field, normalizedValues);
  }
  const testRoots = normalized.get("testRoots") ?? [];
  const allowedNew = normalized.get("allowedNewTestRoots") ?? [];
  const within = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);
  if (allowedNew.some((child) => !testRoots.some((parent) => within(child, parent)))) {
    throw new Error("Allowed new test roots must be contained by a test root.");
  }
  const generated = normalized.get("generatedOutputPaths") ?? [];
  const protectedPaths = normalized.get("protectedPaths") ?? [];
  // Excluding `.` would remove the entire project from the baseline and make
  // a proof independent of every file the agent changed.  Root spelling is
  // valid for protected/test roots, but generated output must always name a
  // concrete descendant directory or file.
  if (generated.some((output) => output === ".")) {
    throw new Error("Generated output paths must not exclude the project root.");
  }
  if (protectedPaths.some((protectedPath) => generated.some((output) => within(protectedPath, output) || within(output, protectedPath)))) {
    throw new Error("Protected paths cannot be excluded as generated output.");
  }
}

export interface VerificationContract extends VerificationContractDraft {
  revision: number;
  contractHash: string;
  approvedRequestId: string;
  approvedAt: string;
  baselineArtifactId: string;
  baselineFingerprint: string;
  /** Snapshot metadata retained so a later candidate can classify changes. */
  baselinePaths?: string[];
  baselineFileHashes?: Record<string, string>;
  baselineFileModes?: Record<string, number>;
}

export type VerificationCommandStatus = "reserved" | "running" | "completed" | "not_run";

export interface VerificationCommandRecord {
  verificationId: string;
  commandId: string;
  status: VerificationCommandStatus;
  executable: string;
  args: string[];
  cwd: string;
  /** Approved contract values retained when the runtime wraps the command. */
  approvedExecutable?: string;
  approvedArgs?: string[];
  approvedCwd?: string;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  processTreeClean: boolean | null;
  logArtifactId: string | null;
  summary: string;
  /** Wall-clock time consumed by this command, including cleanup. */
  elapsedMs?: number;
  /** Whether stdout/stderr was truncated by the bounded collector. */
  outputTruncated?: boolean;
}

export interface VerificationProof {
  proofId: string;
  verificationId: string;
  contractRevision: number;
  contractHash: string;
  baselineFingerprint: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  implementationActivationId: string | null;
  testActivationId: string | null;
  commands: VerificationCommandRecord[];
  passed: boolean;
  verifiedAt: string;
  watcherReliable: boolean;
  /** Wall-clock milliseconds consumed by this verification contract. */
  elapsedMs?: number;
  /** True when the core could not obtain a trustworthy process result. */
  executionError?: boolean;
  /** A bounded diagnostic for an execution or integrity failure. */
  failureReason?: string;
  /** Durable core-generated result artifact. */
  resultArtifactId?: string;
}

export interface VerificationApprovalCandidate {
  candidateHash: string;
  baseRevision: number;
  commands: VerificationCommandSpec[];
  /** Fingerprint observed while constructing the candidate. */
  baselineFingerprint?: string;
  changedPaths: string[];
  addedPaths: string[];
  modifiedPaths: string[];
  deletedPaths: string[];
  diffArtifactId: string | null;
  /** Fingerprint artifact captured at the same approval boundary. */
  baselineArtifactId?: string | null;
  /** New baseline metadata captured at the approval boundary. */
  baselinePaths?: string[];
  baselineFileHashes?: Record<string, string>;
  baselineFileModes?: Record<string, number>;
  /** Proposed execution policy; present when a plan changes more than files. */
  totalTimeoutMs?: number;
  protectedPaths?: string[];
  testRoots?: string[];
  allowedNewTestRoots?: string[];
  generatedOutputPaths?: string[];
}

function normalizedRelative(value: string, projectRoot?: string): string | null {
  let normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (projectRoot && (path.isAbsolute(value) || /^[A-Za-z]:\//u.test(value))) {
    const relative = path.relative(path.resolve(projectRoot), path.resolve(value)).replace(/\\/gu, "/");
    if (!relative || relative === "." || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      return null;
    }
    normalized = relative;
  }
  return normalized.replace(/\/$/u, "");
}

function underPolicyRoot(value: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const normalizedRoot = root.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    if (!normalizedRoot || normalizedRoot === ".") return true;
    return value === normalizedRoot || value.startsWith(`${normalizedRoot}/`);
  });
}

function isLikelyTestPath(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  return /(?:^|\/)(?:tests?|__tests__|specs?|fixtures)(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)(?:tests?|specs?)(?:[._-][^/]*)?$/iu.test(normalized) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/iu.test(normalized) ||
    /(?:^|\/)[^/]+_test\.[^/]+$/iu.test(normalized);
}

/**
 * Files that can change what an approved command executes are part of the
 * verification surface even when they are outside an explicitly protected
 * directory. Keep this list conservative: a changed runner, compiler,
 * package-manager, or toolchain setting requires a fresh approval.
 */
function isVerificationExecutionConfigPath(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const basename = normalized.split("/").pop()?.toLowerCase() ?? "";
  const fixedNames = new Set([
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock",
    "pnpm-lock.yaml", "bun.lockb", "tsconfig.json", "jsconfig.json",
    "pyproject.toml", "setup.cfg", "tox.ini", "pytest.ini", "cargo.toml",
    "cargo.lock", "go.mod", "go.sum", "gemfile", "gemfile.lock",
    "composer.json", "composer.lock", "makefile", "justfile", ".nvmrc",
    ".node-version", ".tool-versions", "requirements.txt", "poetry.lock",
  ]);
  if (fixedNames.has(basename)) return true;
  // Common test/build configuration conventions (jest, vitest, webpack,
  // eslint, and similar) are execution settings regardless of extension.
  if (/(?:^|[./_-])(?:jest|vitest|uvu|mocha|ava|playwright|cypress|pytest|tox|karma|webpack|vite|rollup|esbuild|babel|swc|tsup|eslint|prettier|stylelint|nyc|c8|coverage|test|build|compile|lint)[._-]?config(?:\.[^/]*)?$/iu.test(basename)) {
    return true;
  }
  if (/(?:^|\/)(?:\.github\/workflows|\.circleci|\.buildkite|buildscripts?|scripts?)(?:\/|$)/iu.test(normalized) &&
      /\.(?:json|ya?ml|toml|ini|cfg|js|cjs|mjs|ts|mts|cts|ps1|sh|cmd|bat)$/iu.test(basename)) {
    return true;
  }
  return false;
}

/**
 * Resolve file-like command arguments into the project-relative execution
 * surface.  A plan can invoke an entrypoint that does not use one of the
 * conventional `scripts/` or `*config.*` names; that entrypoint is still part
 * of the approved verification procedure and must trigger re-approval when it
 * changes.  Flags such as `--config=path/to/file` are handled as well, while
 * package-manager subcommands (`run`, `test`, `-m`, etc.) are deliberately
 * ignored because their implementation is governed by the package manifest.
 */
function commandExecutionPaths(
  contract: Readonly<VerificationContract>,
  projectRoot?: string
): string[] {
  const result = new Set<string>();
  const scriptExtension = /\.(?:cjs|cts|go|h|hpp|js|jsx|mjs|mts|py|rb|rs|sh|ts|tsx|vue|ps1|cmd|bat)$/iu;
  const normalize = (value: string): string => value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const root = projectRoot ? path.resolve(projectRoot) : null;
  for (const command of contract.commands) {
    const cwd = normalize(command.cwd);
    for (const original of [command.executable, ...command.args]) {
      if (typeof original !== "string") continue;
      let token = original.trim().replace(/^['"]|['"]$/gu, "");
      const equals = token.indexOf("=");
      if (token.startsWith("-") && equals >= 0) token = token.slice(equals + 1);
      if (!token || token.startsWith("-") || /^(?:https?|file):\/\//iu.test(token)) continue;
      const absolute = path.isAbsolute(token) || /^[A-Za-z]:[\\/]/u.test(token);
      const fileLike = absolute || token.includes("/") || token.includes("\\") || scriptExtension.test(token);
      if (!fileLike) continue;
      const candidate = absolute
        ? path.resolve(token)
        : path.resolve(root ?? process.cwd(), cwd || ".", token);
      if (root) {
        const relative = path.relative(root, candidate).replace(/\\/gu, "/");
        if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
        result.add(relative);
      } else {
        result.add(normalize(token));
      }
    }
  }
  return [...result].filter(Boolean);
}

function policyChanged(
  contract: Readonly<VerificationContract>,
  candidate: Readonly<VerificationApprovalCandidate>
): boolean {
  return JSON.stringify(candidate.commands) !== JSON.stringify(contract.commands) ||
    (candidate.totalTimeoutMs !== undefined && candidate.totalTimeoutMs !== contract.totalTimeoutMs) ||
    (candidate.protectedPaths !== undefined && JSON.stringify(candidate.protectedPaths) !== JSON.stringify(contract.protectedPaths)) ||
    (candidate.testRoots !== undefined && JSON.stringify(candidate.testRoots) !== JSON.stringify(contract.testRoots)) ||
    (candidate.allowedNewTestRoots !== undefined && JSON.stringify(candidate.allowedNewTestRoots) !== JSON.stringify(contract.allowedNewTestRoots)) ||
    (candidate.generatedOutputPaths !== undefined && JSON.stringify(candidate.generatedOutputPaths) !== JSON.stringify(contract.generatedOutputPaths));
}

/**
 * Return only changes that can alter the approved verification procedure.
 * Implementation source is intentionally outside this set: a failed cycle
 * is expected to edit source before the next VERIFY. Protected scripts,
 * package manifests/lockfiles, and test roots remain approval controlled.
 */
function relevantChangedPaths(
  contract: Readonly<VerificationContract>,
  candidate: Readonly<VerificationApprovalCandidate>,
  projectRoot?: string
): { added: string[]; modified: string[]; deleted: string[] } {
  const protectedRoots = [
    ...contract.protectedPaths,
    ...contract.testRoots,
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
  ];
  const commandPaths = commandExecutionPaths(contract, projectRoot);
  const isRelevant = (value: string): boolean => {
    const relative = normalizedRelative(value, projectRoot);
    // An additional root is outside the project-relative policy namespace;
    // conservatively require review for changes there.
    if (relative === null) return true;
    // Existing tests are part of the approved verification surface even when
    // a legacy/initial contract did not declare an explicit testRoot.  A
    // modified or deleted test must therefore trigger reapproval just like a
    // protected script or lockfile.
    return isLikelyTestPath(relative) ||
      isVerificationExecutionConfigPath(relative) ||
      underPolicyRoot(relative, protectedRoots) ||
      commandPaths.some((commandPath) => relative === commandPath || relative.startsWith(`${commandPath}/`));
  };
  return {
    added: candidate.addedPaths.filter(isRelevant),
    modified: candidate.modifiedPaths.filter(isRelevant),
    deleted: candidate.deletedPaths.filter(isRelevant),
  };
}

/** Whether a candidate contains a change that needs a new operator approval. */
export function candidateNeedsVerificationApproval(
  contract: Readonly<VerificationContract>,
  candidate: Readonly<VerificationApprovalCandidate>,
  projectRoot?: string
): boolean {
  if (policyChanged(contract, candidate)) return true;
  if (!contract.baselinePaths || !contract.baselineFileHashes) return true;
  const relevant = relevantChangedPaths(contract, candidate, projectRoot);
  const roots = contract.allowedNewTestRoots
    .map((root) => root.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter(Boolean);
  const allowedNewTest = (value: string): boolean => {
    let normalized = value.replace(/\\/gu, "/");
    if (projectRoot && (path.isAbsolute(value) || /^[A-Za-z]:\//u.test(value))) {
      const relative = path.relative(path.resolve(projectRoot), path.resolve(value)).replace(/\\/gu, "/");
      if (!relative || relative === "." || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
        return false;
      }
      normalized = relative;
    }
    // The contract grants an automatic exception only to *new test files* in
    // the approved test roots. A new source/configuration file under a broad
    // test directory is still a verification-scope change and requires a
    // fresh operator decision.
    return isLikelyTestPath(normalized) && roots.some((root) =>
      !root || root === "." || normalized === root || normalized.startsWith(`${root}/`)
    );
  };
  // A digest mismatch without a classified path represents a metadata or
  // scan-policy change. Treat it conservatively as requiring approval.
  if (candidate.changedPaths.length === 0) return true;
  if (relevant.deleted.length > 0 || relevant.modified.length > 0) return true;
  return relevant.added.some((value) => !allowedNewTest(value));
}

export type ReviewApprovalStage = "qa" | "master";

export interface ReviewApprovalRecord {
  stage: ReviewApprovalStage;
  activationId: string;
  proofId: string;
  contractRevision: number;
  requirementIds: string[];
  resolvedFindingIds: string[];
  rationale: string;
  recordedAt: string;
}

export interface VerificationFeedback {
  verificationId: string;
  proofId: string | null;
  passed: boolean;
  failedCommandIds: string[];
  diagnostics: string[];
  requirementIds: string[];
  sourceActivationId: string | null;
  cycleNumber?: number | null;
  /** Content-addressed evidence references supplied with the feedback. */
  artifactIds?: string[];
}

export interface FindingRecord {
  id: string;
  text: string;
  status: "open" | "resolved";
  source: "test" | "qa" | "master" | "verification";
  artifactIds: string[];
  firstSeenAt: string;
  resolvedAt: string | null;
}

export function hashVerificationCandidate(
  candidate: Pick<VerificationApprovalCandidate, "baseRevision" | "commands" | "changedPaths" | "addedPaths" | "modifiedPaths" | "deletedPaths"> & {
    baselineFingerprint?: string;
    baselinePaths?: string[];
    baselineFileHashes?: Record<string, string>;
    baselineFileModes?: Record<string, number>;
    totalTimeoutMs?: number;
    protectedPaths?: string[];
    testRoots?: string[];
    allowedNewTestRoots?: string[];
    generatedOutputPaths?: string[];
    diffArtifactId?: string | null;
    baselineArtifactId?: string | null;
  }
): string {
  return createHash("sha256")
    .update(canonicalJson({
      baseRevision: candidate.baseRevision,
      commands: candidate.commands,
      baselineFingerprint: candidate.baselineFingerprint ?? null,
      baselinePaths: candidate.baselinePaths ? [...candidate.baselinePaths].sort() : null,
      baselineFileHashes: candidate.baselineFileHashes
        ? Object.fromEntries(Object.entries(candidate.baselineFileHashes).sort(([left], [right]) => left.localeCompare(right)))
        : null,
      baselineFileModes: candidate.baselineFileModes ? { ...candidate.baselineFileModes } : null,
      totalTimeoutMs: candidate.totalTimeoutMs ?? null,
      protectedPaths: candidate.protectedPaths ? [...candidate.protectedPaths] : null,
      testRoots: candidate.testRoots ? [...candidate.testRoots] : null,
      allowedNewTestRoots: candidate.allowedNewTestRoots ? [...candidate.allowedNewTestRoots] : null,
      generatedOutputPaths: candidate.generatedOutputPaths ? [...candidate.generatedOutputPaths] : null,
      // Artifact ids are content-addressed. Including them in the candidate
      // digest binds the operator response to the exact diff/baseline bytes
      // that were displayed and prevents swapping a reference at approval.
      diffArtifactId: candidate.diffArtifactId ?? null,
      baselineArtifactId: candidate.baselineArtifactId ?? null,
      changedPaths: [...candidate.changedPaths].sort(),
      addedPaths: [...candidate.addedPaths].sort(),
      modifiedPaths: [...candidate.modifiedPaths].sort(),
      deletedPaths: [...candidate.deletedPaths].sort(),
    } as unknown as JsonValue))
    .digest("hex");
}

export interface VerificationStatusProjection {
  contractRevision: number | null;
  contractHash: string | null;
  currentVerificationId: string | null;
  currentCommandId: string | null;
  completedCommands: number;
  commandCount: number;
  proofId: string | null;
  proofValid: boolean;
  pendingApproval: VerificationApprovalCandidate | null;
  invalidationReason: string | null;
}

export function verificationCommandJson(command: VerificationCommandSpec): JsonObject {
  return {
    id: command.id,
    label: command.label,
    executable: command.executable,
    args: [...command.args],
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    requirementIds: [...command.requirementIds],
  };
}

export function verificationStatusJson(status: VerificationStatusProjection): JsonValue {
  return JSON.parse(JSON.stringify(status)) as JsonValue;
}
