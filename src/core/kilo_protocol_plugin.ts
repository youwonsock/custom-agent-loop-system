import { kiloCheckHooks, KiloCheckProtocol } from "./kilo_protocol";

// Loaded only by this invocation's KILO_CONFIG_CONTENT. The native bash tool
// still performs its own permission review and execution, after this hook.
export = {
  id: "agent-graph-check-protocol",
  server: async () => {
    const protocol: KiloCheckProtocol = JSON.parse(process.env.AGENT_GRAPH_KILO_CHECKS ?? "null");
    if (!protocol || typeof protocol.cwd !== "string" || !Array.isArray(protocol.commands) || !protocol.commands.every(c => typeof c === "string"))
      throw new Error("Agent Graph native check protocol is missing or invalid.");
    return kiloCheckHooks(protocol);
  },
};
