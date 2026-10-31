import { AgentNode, NodeVisit, SessionState } from "../shared/domain";
import { isVerifierRole } from "../shared/node_roles";
import { PROMPT_SECTIONS } from "./prompt_sections";

export { buildRecoveryMessage } from "./prompt_recovery";
export function buildNodePrompt(
  state: SessionState,
  node: AgentNode,
  visit: NodeVisit,
  recovery?: string,
): string {
  const structured =
    state.verificationContract?.status === "locked" &&
    isVerifierRole(node.type);
  const nativeBrowserReview =
    node.type === "test" &&
    !!state.graph.automation?.nativeApprovalReview &&
    !!state.graph.automation.browserVerification &&
    state.connections?.find(
      (c) => c.id === state.bindings?.[node.id]?.connectionId,
    )?.type === "codex";
  const context = {
    state,
    node,
    visit,
    ...(recovery === undefined ? {} : { recovery }),
    structured,
    nativeBrowserReview,
  };
  return PROMPT_SECTIONS.flatMap((section) => section(context)).join("\n\n");
}
