import {
  NodeTestPolicy,
  NodeTestProof,
  VerificationManifest,
} from "../shared/domain";
import { nodeTestVerificationCommand } from "./node_test_command";
import { createHash } from "node:crypto";

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max = 200): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= max &&
  v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 500) &&
  new Set(v).size === v.length;
const relative = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-zA-Z0-9_./-]+$/.test(v) &&
  v.length < 500 &&
  !v.startsWith("/") &&
  v.split("/").every((s) => s !== ".." && s !== "." && s !== "");
const hashPath = (v: string): boolean =>
  v.length > 0 &&
  v.length < 2000 &&
  !v.startsWith("/") &&
  !/[\\\0]/.test(v) &&
  v.split("/").every((s) => s !== ".." && s !== "." && s !== "");
export const nodeTestScript = (policy: NodeTestPolicy): string =>
  `node --test --test-concurrency=1 ${policy.scopes.map((s) => s.file).join(" ")}`;
export function nodeTestPolicyDigest(policy: NodeTestPolicy): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : object(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(policy)))
    .digest("hex");
}

/** Optional for historical contracts; once supplied every scope is mandatory. */
export function validateNodeTestPolicy(
  value: unknown,
  manifest: VerificationManifest,
): NodeTestPolicy {
  if (
    !object(value) ||
    typeof value.checkId !== "string" ||
    typeof value.suiteCheckId !== "string" ||
    value.checkId === value.suiteCheckId ||
    !Array.isArray(value.scopes) ||
    !value.scopes.length ||
    value.scopes.length > 12
  )
    throw Error(
      "nodeTests requires distinct checkId/suiteCheckId and bounded scopes.",
    );
  const check = manifest.checks.find((c) => c.id === value.checkId),
    suite = manifest.checks.find((c) => c.id === value.suiteCheckId);
  if (
    !check ||
    check.command !== nodeTestVerificationCommand() ||
    !suite ||
    !/^npm test(?: > [a-zA-Z0-9_./-]+ 2>&1)?$/.test(suite.command)
  )
    throw Error(
      "nodeTests requires the exact installed verify-node-tests command and a separate npm test check.",
    );
  const ids = new Set<string>(),
    files = new Set<string>(),
    challenges = new Set<string>();
  const scopes = value.scopes.map((raw) => {
    if (
      !object(raw) ||
      typeof raw.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.id) ||
      ids.has(raw.id) ||
      !relative(raw.file) ||
      !/^(?:test|tests)\/.+\.test\.[cm]?js$/.test(raw.file) ||
      files.has(raw.file) ||
      manifest.protectedFiles.includes(raw.file) ||
      !strings(raw.requirements) ||
      !raw.requirements.every(
        (id) =>
          check.requirements.includes(id) && suite.requirements.includes(id),
      ) ||
      !strings(raw.cases, 100) ||
      !raw.cases.every((name) => name.startsWith(raw.id + ":")) ||
      !Array.isArray(raw.challenges) ||
      !raw.challenges.length ||
      raw.challenges.length > 20
    )
      throw Error(
        "Invalid own Node scope/file/requirements/cases; supplied acceptance files cannot count as authored tests.",
      );
    ids.add(raw.id);
    files.add(raw.file);
    const probes = raw.challenges.map((probe) => {
      if (
        !object(probe) ||
        typeof probe.id !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(probe.id) ||
        challenges.has(probe.id) ||
        !relative(probe.adapter) ||
        !probe.adapter.endsWith(".mjs") ||
        !manifest.protectedFiles.includes(probe.adapter) ||
        !strings(probe.targets, 10) ||
        !probe.targets.every(
          (file) =>
            relative(file) &&
            !/^(?:test|tests|verification|artifacts|node_modules|\.git|\.agent-graph)(?:\/|$)/.test(
              file,
            ) &&
            file !== "package.json" &&
            !manifest.protectedFiles.includes(file),
        )
      )
        throw Error(
          "Every Node challenge needs a unique ID, protected adapter and production-only replacement targets.",
        );
      challenges.add(probe.id);
      return {
        id: probe.id,
        adapter: probe.adapter,
        targets: [...probe.targets],
      };
    });
    return {
      id: raw.id,
      file: raw.file,
      requirements: [...raw.requirements],
      cases: [...raw.cases],
      challenges: probes,
    };
  });
  return { checkId: value.checkId, suiteCheckId: value.suiteCheckId, scopes };
}

export function validNodeTestProof(v: unknown): v is NodeTestProof {
  if (
    !object(v) ||
    v.version !== 1 ||
    typeof v.runId !== "string" ||
    !v.runId ||
    v.runId.length > 100 ||
    typeof v.reportDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.reportDigest) ||
    !object(v.sourceHashes) ||
    !Object.keys(v.sourceHashes).length ||
    Object.keys(v.sourceHashes).length > 10000 ||
    !Object.entries(v.sourceHashes).every(
      ([p, h]) =>
        hashPath(p) && typeof h === "string" && /^[a-f0-9]{64}$/.test(h),
    ) ||
    !Array.isArray(v.scopes) ||
    !v.scopes.length ||
    v.scopes.length > 12
  )
    return false;
  return (
    v.scopes.every(
      (s) =>
        object(s) &&
        typeof s.id === "string" &&
        relative(s.file) &&
        strings(s.cases, 100) &&
        strings(s.challenges, 20),
    ) &&
    new Set(v.scopes.map((s) => (s as { id: string }).id)).size ===
      v.scopes.length
  );
}
export function nodeTestProofProblem(
  policy: NodeTestPolicy | undefined,
  proof: NodeTestProof | undefined,
): string | null {
  if (!policy) return null;
  if (!validNodeTestProof(proof))
    return "현재 자체 Node 테스트의 영역별 실행·결함 탐지 증거가 없습니다.";
  for (const scope of policy.scopes) {
    const actual = proof.scopes.find((s) => s.id === scope.id);
    if (
      !actual ||
      actual.file !== scope.file ||
      JSON.stringify([...actual.cases].sort()) !==
        JSON.stringify([...scope.cases].sort()) ||
      JSON.stringify([...actual.challenges].sort()) !==
        JSON.stringify(scope.challenges.map((c) => c.id).sort())
    )
      return `자체 Node 테스트 영역 ${scope.id}의 실제 case/challenge 증거가 부족합니다.`;
  }
  return proof.scopes.length === policy.scopes.length
    ? null
    : "자체 Node 테스트 증거의 영역 목록이 계약과 다릅니다.";
}
export function nodeScopeAuditProblem(
  policy: NodeTestPolicy | undefined,
  output: string,
): string | null {
  if (!policy) return null;
  const blocks = [
    ...output.matchAll(
      /\[NODE_TEST_SCOPE\]\n([\s\S]*?)\n\[\/NODE_TEST_SCOPE\]/g,
    ),
  ];
  for (const scope of policy.scopes) {
    const found = blocks.filter((b) =>
      new RegExp(`^SCOPE_ID: ${scope.id}$`, "m").test(b[1]!),
    );
    if (found.length !== 1 || !/^STATUS: SATISFIED$/m.test(found[0]![1]!))
      return `자체 Node 영역 ${scope.id}의 독립 검토 증거가 충족되지 않았습니다.`;
  }
  return blocks.length === policy.scopes.length
    ? null
    : "자체 Node 영역 검토 목록이 계약과 다릅니다.";
}
export function nodeInspectionProblem(
  policy: NodeTestPolicy | undefined,
  files: string[],
): string | null {
  if (!policy) return null;
  const missing = [
    ...policy.scopes.map((s) => s.file),
    "verification/node-tests/report.json",
  ].filter((f) => !files.includes(f));
  return missing.length
    ? `독립 검토의 완료된 네이티브 파일 읽기가 필요합니다: ${missing.join(", ")}. Use read(filePath) or cat/Get-Content; several reads may be chained with && or ;, without pipes or redirection. Inspect authored assertions and the actual quality report before judging. Do not run checks in a read-only role.`
    : null;
}
