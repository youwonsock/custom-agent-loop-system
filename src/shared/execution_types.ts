export type AttemptStatus =
  | "starting"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "transport_timeout"
  | "idle_timeout"
  | "tool_timeout"
  | "phase_timeout"
  | "spawn_error"
  | "process_exit"
  | "incomplete_response"
  | "cancelled"
  | "orphaned_process";

export type FailureKind =
  | "transport_timeout"
  | "idle_timeout"
  | "tool_timeout"
  | "phase_timeout"
  | "spawn_error"
  | "process_exit"
  | "incomplete_response"
  | "network"
  | "tool_arguments"
  | "rate_limited"
  | "quota_exhausted"
  | "auth"
  | "model_unavailable"
  | "permission"
  | "role_violation"
  | "cancelled"
  | "orphaned_process"
  | "unknown";

export type NodeVerdict = "PASS" | "FAIL" | "BLOCKED" | "APPROVED" | "REJECTED";
export type Activity =
  "initial_transport" | "model_generation" | "tool_execution";
