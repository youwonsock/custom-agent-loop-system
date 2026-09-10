import type { RequirementEvidence } from "./task-result";
import type { VerificationContractDraft } from "./verification";

export interface PlanChoiceRecord {
  id: string;
  title: string;
  planArtifactId: string;
  verification?: VerificationContractDraft;
}

export type DomainEffect =
  | { type: "record_plan_choices"; choices: PlanChoiceRecord[] }
  | { type: "set_approved_plan"; choiceId: string; planArtifactId: string }
  | { type: "add_requirement_evidence"; evidence: RequirementEvidence[] }
  | { type: "set_failure_summary"; summary: string }
  | { type: "clear_failure_summary" }
  | {
      type: "update_convergence";
      signature: string;
      improved: boolean;
    }
  | { type: "record_interrupt_briefing"; artifactId: string; summary: string }
  | { type: "record_verification_criteria_changes"; changes: string[]; artifactId: string }
  | {
      type: "record_review_approval";
      stage: "qa" | "master";
      proofId: string;
      contractRevision: number;
      requirementIds: string[];
      resolvedFindingIds: string[];
      rationale: string;
    }
  | {
      type: "record_findings";
      source: "test" | "qa" | "master" | "verification";
      findings: string[];
      artifactIds: string[];
    };
