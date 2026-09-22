export type RequirementEvidenceStatus = "SATISFIED" | "PARTIAL" | "FAILED" | "BLOCKED";

export interface RequirementItem {
  id: string;
  text: string;
  category: "deliverable" | "behavior" | "constraint" | "research";
  mandatory: true;
  source: "original_goal";
}

export interface RequirementEvidenceRecord {
  requirementId: string;
  stageId: string;
  role: string;
  status: RequirementEvidenceStatus;
  summary: string;
  attemptId: string | null;
  recordedAt: string;
}

export interface RequirementLedger {
  version: 1;
  derivedAt: string;
  items: RequirementItem[];
  evidence: RequirementEvidenceRecord[];
}

export interface ConvergenceCycle {
  loopCount: number;
  score: number;
  signature: string;
  unresolvedRequirementIds: string[];
  recordedAt: string;
}

export interface ConvergenceState {
  stagnantCycles: number;
  history: ConvergenceCycle[];
}

function requirementCategory(text: string): RequirementItem["category"] {
  if (/(?:\uac80\uc0c9|research|browse|internet|web\s*search)/i.test(text)) return "research";
  if (/(?:\uacbd\ub85c|\ud3f4\ub354|directory|folder|under\b|inside\b|must not|\ud558\uc9c0\s*\uc54a|\ud544\uc694\s*\uc5c6)/i.test(text)) {
    return "constraint";
  }
  if (/(?:\ub9cc\ub4e4|\uc81c\uc791|\uad6c\ud604|create|build|implement|deliver|file)/i.test(text)) return "deliverable";
  return "behavior";
}

/** Create stable requirement IDs from the authoritative goal without model interpretation. */
export function deriveRequirementLedger(
  goal: string,
  derivedAt = new Date().toISOString()
): RequirementLedger {
  const normalized = String(goal ?? "").replace(/\r\n/g, "\n").trim();
  let clauses = normalized
    .split(/\n+|(?<=[.!?\u3002\uff01\uff1f])\s+/)
    .map((clause) => clause.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  if (clauses.length === 1) {
    clauses = clauses[0]
      .split(/\s+(?=(?:\uc774\ub54c|\ucd94\uac00\ub85c|\ub610\ud55c|\uadf8\ub9ac\uace0|\ub2e8,?|\uc81c\uc791\ud558\ub824\ub294|\uac8c\uc784\uc740|UI\ub294|also|additionally|while|the\s+game|the\s+UI)(?:\s|$))/i)
      .map((clause) => clause.trim())
      .filter(Boolean);
  }
  const unique = [...new Set(clauses.map((clause) => clause.replace(/\s+/g, " ")))];
  if (unique.length === 0) unique.push("Complete the original user goal as written.");
  return {
    version: 1,
    derivedAt,
    items: unique.map((text, index) => ({
      id: `REQ-${String(index + 1).padStart(3, "0")}`,
      text,
      category: requirementCategory(text),
      mandatory: true,
      source: "original_goal",
    })),
    evidence: [],
  };
}

/** Parse bounded, machine-checkable evidence emitted by a phase agent. */
export function parseRequirementEvidence(output: string): Array<{
  requirementId: string;
  status: RequirementEvidenceStatus;
  summary: string;
}> {
  const records: Array<{
    requirementId: string;
    status: RequirementEvidenceStatus;
    summary: string;
  }> = [];
  const blockPattern = /\[REQUIREMENT_EVIDENCE\]([\s\S]*?)\[\/REQUIREMENT_EVIDENCE\]/gi;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(output)) !== null) {
    const block = match[1];
    const id = block.match(/^\s*(?:REQ_ID|REQUIREMENT_ID):\s*(REQ-\d{3,})\s*$/im)?.[1]?.toUpperCase();
    const status = block.match(
      /^\s*STATUS:\s*(SATISFIED|PARTIAL|FAILED|BLOCKED)\s*$/im
    )?.[1]?.toUpperCase() as RequirementEvidenceStatus | undefined;
    const summary = block.match(/^\s*EVIDENCE:\s*(.+)$/im)?.[1]?.trim();
    if (id && status && summary) {
      records.push({ requirementId: id, status, summary: summary.slice(0, 2_000) });
    }
  }
  return records;
}

export function evaluateRequirementCoverage(
  output: string,
  items: readonly RequirementItem[]
): { complete: boolean; allSatisfied: boolean; missing: string[]; unresolved: string[] } {
  const latest = new Map<string, RequirementEvidenceStatus>();
  const validIds = new Set(items.map((item) => item.id));
  for (const record of parseRequirementEvidence(output)) {
    if (validIds.has(record.requirementId)) latest.set(record.requirementId, record.status);
  }
  const missing = items.filter((item) => !latest.has(item.id)).map((item) => item.id);
  const unresolved = items
    .filter((item) => latest.get(item.id) !== "SATISFIED")
    .map((item) => item.id);
  return {
    complete: missing.length === 0,
    allSatisfied: missing.length === 0 && unresolved.length === 0,
    missing,
    unresolved,
  };
}

export function latestRequirementStatuses(
  ledger: RequirementLedger
): Map<string, RequirementEvidenceStatus> {
  const statuses = new Map<string, RequirementEvidenceStatus>();
  for (const record of ledger.evidence) statuses.set(record.requirementId, record.status);
  return statuses;
}

/** Keep the latest evidence for every requirement, plus a bounded recent history. */
export function retainRequirementEvidence(
  records: RequirementEvidenceRecord[],
  recentLimit = 200
): RequirementEvidenceRecord[] {
  const latest = new Map<string, number>();
  records.forEach((record, index) => latest.set(record.requirementId, index));
  const keep = new Set(latest.values());
  return records.filter((_, index) => keep.has(index) || index >= records.length - recentLimit);
}

export function advanceConvergence(
  current: ConvergenceState,
  ledger: RequirementLedger,
  loopCount: number,
  recordedAt = new Date().toISOString()
): ConvergenceState {
  const weights: Record<RequirementEvidenceStatus, number> = {
    SATISFIED: 3,
    PARTIAL: 1,
    FAILED: 0,
    BLOCKED: 0,
  };
  const statuses = latestRequirementStatuses(ledger);
  const signature = ledger.items
    .map((item) => `${item.id}:${statuses.get(item.id) ?? "UNKNOWN"}`)
    .join("|");
  const score = ledger.items.reduce(
    (total, item) => total + (weights[statuses.get(item.id)!] ?? 0),
    0
  );
  const unresolvedRequirementIds = ledger.items
    .filter((item) => statuses.get(item.id) !== "SATISFIED")
    .map((item) => item.id);
  const previousHistory = current.history.filter((cycle) => cycle.loopCount !== loopCount);
  const previous = previousHistory[previousHistory.length - 1];
  const stagnantCycles = previous && score <= previous.score
    ? current.stagnantCycles + 1
    : 0;
  return {
    stagnantCycles,
    history: [
      ...previousHistory,
      { loopCount, score, signature, unresolvedRequirementIds, recordedAt },
    ].slice(-10),
  };
}
