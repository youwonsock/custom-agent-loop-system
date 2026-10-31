import {
  AgentNode,
  CommandReceipt,
  VerificationContract,
} from "../shared/domain";
import { RequirementItem } from "./requirement_ledger";
import { projectCommandKey } from "./verification_evidence";
import { isVerifierRole } from "../shared/node_roles";
import { isObj } from "./values";
/** Model-authored judgments; receipt facts are attached by the engine only. */
export function renderStructuredReport(
  text: string,
  node: AgentNode,
  requirements: RequirementItem[],
  commands: CommandReceipt[],
  contract?: VerificationContract,
  cwd?: string,
): string | null {
  const start = text.lastIndexOf("[AGENT_REPORT]");
  if (start < 0) return null;
  const end = text.indexOf("[/AGENT_REPORT]", start);
  if (end < 0) throw Error("AGENT_REPORT JSON의 닫는 표식이 없습니다.");
  let body = text.slice(start + "[AGENT_REPORT]".length, end).trim();
  if (body.startsWith("```"))
    body = body.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const report: unknown = JSON.parse(body);
  if (
    !isObj(report) ||
    report.version !== 1 ||
    !Array.isArray(report.requirements) ||
    report.requirements.length > requirements.length
  )
    throw Error("보고는 version:1, verdict, requirements JSON이어야 합니다.");
  const verdict = String(report.verdict),
    allowed =
      node.type === "test"
        ? ["PASS", "FAIL", "BLOCKED"]
        : ["APPROVED", "REJECTED", "BLOCKED"];
  if (!allowed.includes(verdict) || !isVerifierRole(node.type))
    throw Error("현재 역할의 JSON verdict가 잘못되었습니다.");
  if (contract?.status !== "locked")
    throw Error("구조화 보고에는 고정된 검증 계약이 필요합니다.");
  if (
    report.blockedKind !== undefined &&
    !["product", "test_setup", "external"].includes(String(report.blockedKind))
  )
    throw Error(
      "blockedKind는 product, test_setup, external 중 하나여야 합니다.",
    );
  const research = text
    .slice(0, start)
    .split("\n")
    .filter((line) =>
      /^(?:SOURCE:\s*https?:\/\/\S+|(?:VERIFIED_FACT|LIMITATION):\s*\S+)/i.test(
        line,
      ),
    );
  const seen = new Set<string>(),
    lines = [
      `[REPORT_PROTOCOL: json-v1]`,
      `CONTRACT_DIGEST: ${contract.digest}`,
      ...research,
    ];
  for (const item of report.requirements) {
    if (
      !isObj(item) ||
      typeof item.id !== "string" ||
      !requirements.some((r) => r.id === item.id) ||
      seen.has(item.id) ||
      !["SATISFIED", "PARTIAL", "FAILED", "BLOCKED"].includes(
        String(item.status),
      ) ||
      typeof item.evidence !== "string" ||
      !item.evidence.trim() ||
      item.evidence.length > 2000
    )
      throw Error(
        "요구사항 JSON의 id/status/evidence를 확인하세요. 중복·알 수 없는 ID·빈 근거는 허용하지 않습니다.",
      );
    seen.add(item.id);
    const checks = contract.manifest!.checks.filter((c) =>
      c.requirements.includes(item.id as string),
    );
    const observed = checks.flatMap((c) => {
      const r = commands.find(
        (r) =>
          projectCommandKey(r.command, cwd) ===
          projectCommandKey(c.command, cwd),
      );
      return r ? [{ check: c.id, receipt: r }] : [];
    });
    const evidence = item.evidence
      .replace(/[\r\n]+/g, " ")
      .replace(
        /\[(\/?(?:REQUIREMENT_EVIDENCE|PHASE_DONE|AGENT_REPORT))\]/gi,
        "〈$1〉",
      );
    const effectiveStatus = observed.some(
      (o) => o.receipt.exitCode !== 0 || o.receipt.environmentError,
    )
      ? "FAILED"
      : item.status;
    lines.push(
      `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${item.id}\nSTATUS: ${effectiveStatus}\nEVIDENCE: ${evidence}${observed.length ? ` | Native receipts: ${observed.map((r) => `${r.check}=${r.receipt.id} (exit ${r.receipt.exitCode ?? "unknown"})`).join(", ")}` : ""}${observed.length ? `\nCHECK_COMMAND: ${observed[0]!.receipt.command}` : ""}\n[/REQUIREMENT_EVIDENCE]`,
    );
  }
  const policy = contract.manifest!.nodeTests;
  if (policy) {
    const audits = report.testScopes;
    if (audits !== undefined && !Array.isArray(audits))
      throw Error("testScopes는 자체 Node 영역 검토 배열이어야 합니다.");
    const scopeSeen = new Set<string>();
    for (const row of Array.isArray(audits) ? audits : []) {
      if (
        !isObj(row) ||
        typeof row.id !== "string" ||
        scopeSeen.has(row.id) ||
        !policy.scopes.some((s) => s.id === row.id) ||
        !["SATISFIED", "PARTIAL", "FAILED", "BLOCKED"].includes(
          String(row.status),
        ) ||
        typeof row.evidence !== "string" ||
        !row.evidence.trim() ||
        row.evidence.length > 2000
      )
        throw Error(
          "자체 Node testScopes의 id/status/evidence가 잘못되었습니다.",
        );
      scopeSeen.add(row.id);
      const evidence = row.evidence
        .replace(/[\r\n]+/g, " ")
        .replace(/[\[\]]/g, " ");
      lines.push(
        `[NODE_TEST_SCOPE]\nSCOPE_ID: ${row.id}\nSTATUS: ${row.status}\nEVIDENCE: ${evidence}\n[/NODE_TEST_SCOPE]`,
      );
    }
    if (
      ["PASS", "APPROVED"].includes(verdict) &&
      policy.scopes.some((s) => !scopeSeen.has(s.id))
    )
      throw Error(
        `자체 Node 영역 전체의 testScopes 판단이 필요합니다: ${policy.scopes.map((s) => s.id).join(", ")}`,
      );
  }
  if (report.blockedKind) lines.push(`BLOCKED_KIND: ${report.blockedKind}`);
  lines.push(
    node.type === "test"
      ? `VERDICT: ${verdict}`
      : verdict === "BLOCKED"
        ? "VERDICT: BLOCKED"
        : verdict,
    "[PHASE_DONE]",
  );
  return lines.join("\n\n");
}
