import type { AgentGraphDocument, AgentNode } from "./domain";

/** A new node on the three-column layout. Callers keep their own spacing. */
export function defaultNode({
  id,
  type,
  name,
  roleName,
  index,
  left,
  columnWidth,
}: Pick<AgentNode, "id" | "type" | "name" | "roleName"> & {
  index: number;
  left: number;
  columnWidth: number;
}): AgentNode {
  return {
    id,
    name,
    roleName,
    type,
    instructions: "",
    position: {
      x: left + (index % 3) * columnWidth,
      y: 80 + Math.floor(index / 3) * 260,
    },
    ...(type === "planning"
      ? { planning: { requiresApproval: true, optionsCount: 3 } }
      : {}),
  };
}
/** Every safeguard on. Only the approval review differs between its two callers. */
export const autonomousDefaults = (
  nativeApprovalReview: boolean,
): NonNullable<AgentGraphDocument["automation"]> => ({
  maxRepairCycles: 5,
  nativeApprovalReview,
  browserVerification: true,
  verificationContract: true,
  authoredNodeTests: true,
  testSourceGuard: true,
  reserveFinalizationBudget: true,
  guardOwnedProcesses: true,
  targetScopeGuard: true,
  programIoGuard: true,
});
