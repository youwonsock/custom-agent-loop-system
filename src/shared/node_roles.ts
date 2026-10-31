import type { AgentNode } from "./domain";

type Role = AgentNode["type"];
const oneOf =
  (...roles: Role[]) =>
  (type: Role): boolean =>
    roles.includes(type);

/** Roles that must leave the target's files unchanged. */
export const isReadOnly = oneOf("planning", "review", "approval", "interrupt");
/** Roles whose verdict has to rest on observed verification evidence. */
export const isVerifierRole = oneOf("test", "review", "approval");
/** Verifiers that judge existing evidence and never run checks themselves. */
export const isAuditRole = oneOf("review", "approval");
/** Roles that must show their own research when the goal asks for it. */
export const isResearchRole = oneOf("planning", "review", "approval");
