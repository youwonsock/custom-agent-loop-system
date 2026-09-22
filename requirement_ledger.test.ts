import test from "node:test";
import assert from "node:assert/strict";
import { deriveRequirementLedger, parseRequirementEvidence, retainRequirementEvidence, latestRequirementStatuses, RequirementEvidenceRecord } from "./requirement_ledger";

test("every goal requirement and its complete text survive ledger derivation", () => {
  const lines = Array.from({ length: 1001 }, (_, i) => `Constraint ${i + 1}: ${i === 25 ? "x".repeat(1500) : "keep this"}`);
  const ledger = deriveRequirementLedger(lines.join("\n"));
  assert.equal(ledger.items.length, 1001);
  assert.equal(ledger.items[25].text, lines[25]);
  assert.equal(ledger.items[1000].id, "REQ-1001");
  const records = parseRequirementEvidence("[REQUIREMENT_EVIDENCE]\nREQ_ID: REQ-1001\nSTATUS: SATISFIED\nEVIDENCE: verified final condition\n[/REQUIREMENT_EVIDENCE]");
  assert.equal(records[0].requirementId, ledger.items[1000].id);
});

test("evidence history compaction retains the latest verdict for every requirement", () => {
  const ledger = deriveRequirementLedger(Array.from({ length: 250 }, (_, i) => `condition ${i}`).join("\n"));
  const records: RequirementEvidenceRecord[] = ledger.items.map((item) => ({ requirementId: item.id, status: "SATISFIED", stageId: "VERIFY", role: "reviewer", summary: "verified", attemptId: null, recordedAt: "2026-01-01" }));
  records.push({ ...records[0], status: "FAILED" });
  ledger.evidence = retainRequirementEvidence(records);
  const statuses = latestRequirementStatuses(ledger);
  assert.equal(statuses.size, 250);
  assert.equal(statuses.get("REQ-001"), "FAILED");
  assert.equal(statuses.get("REQ-002"), "SATISFIED");
});
