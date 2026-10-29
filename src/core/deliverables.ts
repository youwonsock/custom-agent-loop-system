import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionState, VerificationManifest } from "../shared/domain";
import { CONTRACT_FILE, validateManifest } from "./verification_contract";
import { inside } from "./verification_sources";

export const DELIVERABLES_FAILED = "[AGENT_GRAPH_DELIVERABLES]";

export function deliverableInspectionProblem(
  manifest: VerificationManifest | undefined,
  files: string[],
): string | null {
  const missing =
    manifest?.requiredFiles
      ?.filter((f) => !files.includes(f.path))
      .map((f) => f.path) ?? [];
  return missing.length
    ? `독립 검토의 필수 산출물 읽기 증거가 없습니다: ${missing.join(", ")}. Inspect each with native read or standalone cat/Get-Content, then judge its actual content against the linked requirements. README must describe the actual launch, rules, controls and test commands when requested. Never repair files or rerun checks in this role.`
    : null;
}

/** Presence is a handoff gate, never a substitute for behavioral tests or review. */
export async function deliverableProblem(
  state: SessionState,
): Promise<string | null> {
  if (!state.graph.automation?.verificationContract) return null;
  try {
    const root = await fs.realpath(state.targetProjectPath);
    let manifest = state.verificationContract?.manifest;
    if (state.verificationContract?.status !== "locked") {
      // A missing, not-yet-frozen contract retains the existing test-boundary
      // contract preparation failure/repair path.
      try {
        await fs.access(path.join(root, CONTRACT_FILE));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const file = await inside(root, CONTRACT_FILE);
      if ((await fs.stat(file)).size > 1024 * 1024)
        throw Error("검증 계약이 너무 큽니다.");
      manifest = validateManifest(
        JSON.parse(await fs.readFile(file, "utf8")),
        state.requirements.items.map((r) => r.id),
        !!state.graph.automation.browserVerification,
      );
    }
    const problems: string[] = [];
    for (const file of manifest?.requiredFiles ?? []) {
      try {
        const resolved = await inside(root, file.path);
        const stat = await fs.lstat(path.join(root, file.path));
        if (
          stat.isSymbolicLink() ||
          !stat.isFile() ||
          stat.size === 0 ||
          !(await fs.stat(resolved)).isFile()
        )
          throw Error();
      } catch {
        problems.push(
          `${file.path} (${file.requirements.join(", ")}): missing, empty, non-regular or outside target`,
        );
      }
    }
    return problems.length
      ? `${DELIVERABLES_FAILED}\n${problems.join("\n")}\nImplementation must create/repair these deliverables. Test/review/approval must report failure without writing them. After any repair, run the entire registered test cycle again; old receipts cannot approve repaired sources.`
      : null;
  } catch (error) {
    return `${DELIVERABLES_FAILED} Required-file contract cannot be checked: ${error instanceof Error ? error.message : String(error)}. Implementation must prepare the contract before handing off.`;
  }
}
