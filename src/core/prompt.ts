import { AgentNode, NodeVisit, SessionState } from "../shared/domain";
import { requiresResearch } from "./completion";
import { FailureKind } from "./resilience";
export function buildRecoveryMessage(
  kind: FailureKind, message: string, assistantText: string,
  events: Record<string, unknown>[],
): string {
  const lines = [`[${kind}] ${message}`, `Previous observed output:\n${assistantText.slice(-5000)}`];
  if (kind === "tool_arguments") {
    const errors = events.flatMap(event => {
      const part = event.part as Record<string, unknown> | undefined;
      const state = part?.state as Record<string, unknown> | undefined;
      return event.type === "tool_use" && state?.status === "error" && typeof state.error === "string"
        ? [`${String(part?.tool)}: ${state.error.slice(0, 1500)}`] : [];
    }).slice(-3);
    lines.push(
      'The preceding CLI aborted repeated malformed tool input. This is a fresh bounded attempt. Follow the native tool schema, supply all required fields, never submit {} and never repeat the same invalid call. Run existing checks first; add coverage only when missing. The Kilo write tool requires filePath and content. Do not weaken checks or switch models.',
      ...errors,
    );
  }
  return lines.join("\n");
}
const responsibilities: Record<AgentNode["type"], string> = {
  planning:
    "Inspect requirements and existing files without writing files. Propose complete, materially different strategies. Do not implement or invoke native plan approval tools; return the options as assistant text.",
  implementation:
    "Inspect existing work first. Implement cumulatively. Do not weaken, delete or skip tests to make the implementation appear complete. Run focused checks and report observed results.",
  test: "Run existing tests, add missing acceptance coverage and execute it. You may edit tests but never production code. Report blocked, skipped or inconclusive required checks as FAIL.",
  review:
    "Independently inspect the code, original goal and test evidence using read-only tools. Reject missing or contradictory evidence. Never repair files or conceal failing tests.",
  approval:
    "Audit the complete original goal and all requirements using read-only inspection. Approve only when the goal is proved by concrete evidence. Never edit files.",
  interrupt:
    "Explain the verified failure or stagnation, distinguish facts from hypotheses and give the smallest operator recovery action. Do not continue implementation or claim completion.",
};
export function buildNodePrompt(
  state: SessionState,
  node: AgentNode,
  visit: NodeVisit,
  recovery?: string,
): string {
  const ref = state.approvedPlanRef;
  const approved = ref
    ? state.visits
        .find((v) => v.id === ref.visitId)
        ?.plans.find((p) => p.id === ref.choiceId)?.body
    : undefined;
  const evidence = [
    ...new Map(
      state.visits
        .filter((v) => v.completedAt && v.id !== visit.id)
        .map((v) => [v.nodeId, v]),
    ).values(),
  ];
  const lines = [
    `You are ${node.roleName}. Node: ${node.name} (${node.id}). Execution type: ${node.type}.`,
    `Session: ${state.id}. Visit: ${visit.id}. Each revisit is a new task execution.`,
    "=== ORIGINAL USER GOAL (AUTHORITATIVE) ===",
    state.goal,
    "The original goal is the acceptance contract. A plan is a subordinate strategy and may never omit, weaken or replace the goal.",
    "=== FIXED REQUIREMENTS ===",
    ...state.requirements.items.map((r) => `${r.id}: ${r.text}`),
    "=== MOST RECENT APPROVED PLAN ===",
    approved ?? "(none)",
    `=== TARGET PROJECT ===\n${state.targetProjectPath}`,
    state.accessMode === "full_access"
      ? "The operator granted full filesystem access for this session."
      : `Write only inside these approved roots: ${[state.targetProjectPath, ...state.additionalAllowedPaths].join(", ")}. Report exact additional paths if needed.`,
    "=== ROLE CONTRACT ===",
    responsibilities[node.type],
    `=== NODE INSTRUCTIONS ===\n${node.instructions || "(no additional instructions)"}`,
    "Use your CLI configuration for MCP, search, skills and hooks. Do not assume a configured tool succeeded; cite observed evidence.",
    "=== PRIOR OBSERVED EVIDENCE ===",
    ...evidence.map(
      (v) =>
        `[${v.nodeId} / ${v.id}] ${v.verdict ?? v.status}\n${v.output.slice(-6000)}`,
    ),
    "=== REQUIREMENT EVIDENCE FORMAT ===",
    "For each requirement report: [REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-001\nSTATUS: SATISFIED|PARTIAL|FAILED|BLOCKED\nEVIDENCE: concrete observed check or artifact\n[/REQUIREMENT_EVIDENCE]. Never invent a passed check.",
  ];
  if (["test", "review", "approval"].includes(node.type))
    lines.push(
      "The complete final report must contain one correctly formatted block for EVERY ID below. Choose exactly one STATUS and replace the EVIDENCE placeholder with observed facts. Write REQ_ID exactly once per line. A bare PASS or APPROVED without these blocks is incomplete.",
      ...state.requirements.items.map(r => `[REQUIREMENT_EVIDENCE]\nREQ_ID: ${r.id}\nSTATUS: SATISFIED|PARTIAL|FAILED|BLOCKED\nEVIDENCE: concrete observed check or artifact\n[/REQUIREMENT_EVIDENCE]`),
    );
  if (node.type === "planning")
    lines.push(
      `Return exactly ${node.planning?.optionsCount ?? 3} complete options. Use "## OPTION 1: Title" etc. Every option must include each REQ ID, files, ordered implementation steps, verification and risks.`,
    );
  if (node.type === "test")
    lines.push(
      "PASS requires concrete SATISFIED evidence for every REQ. Finish with VERDICT: PASS or VERDICT: FAIL.",
    );
  if (node.type === "review" || node.type === "approval")
    lines.push(
      "APPROVED requires concrete SATISFIED evidence for every REQ. Finish with APPROVED or REJECTED.",
    );
  if (
    requiresResearch(state.goal) &&
    ["planning", "review", "approval"].includes(node.type)
  )
    lines.push(
      "Complete actual web research. Include [RESEARCH_EVIDENCE], SOURCE: https://..., VERIFIED_FACT: ... or LIMITATION: ... . If your CLI cannot perform the required research, state RESEARCH_BLOCKED on its own line and explain the needed operator action.",
    );
  if (state.interruptMessage)
    lines.push(`=== OPERATOR MESSAGE ===\n${state.interruptMessage}`);
  if (recovery)
    lines.push(
      `=== BOUNDED RECOVERY ===\n${recovery}\nInspect existing changes first. Preserve completed work and finish the contract; do not blindly repeat implementation. If only the final report format was incomplete, return the complete corrected report using existing observed checks; do not rewrite production code or rerun already conclusive checks solely to repair formatting.`,
    );
  lines.push("The final assistant line must be [PHASE_DONE] on its own line.");
  return lines.join("\n\n");
}
