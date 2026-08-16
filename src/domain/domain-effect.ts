import type { RequirementEvidence } from "./task-result";

export interface PlanChoiceRecord {
  id: string;
  title: string;
  planArtifactId: string;
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
  | { type: "record_interrupt_briefing"; artifactId: string; summary: string };
