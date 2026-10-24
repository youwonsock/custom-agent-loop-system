import { projectCommandKey } from "./verification_evidence";

export interface KiloCheckProtocol {
  cwd: string;
  commands: string[];
}

// Only display-only wrappers around an exact registered check are repaired.
// Unknown commands, compound checks and other working directories keep their
// original semantics and remain ineligible as verification evidence.
const filter = String.raw`(?:(?:head|tail)(?:\s+(?:-n\s+\d+|-\d+|\d+))?|grep(?:\s+-[EFivnx]+)*\s+(?:'[^'\r\n]*'|"[^"$\x60\r\n]*"))`;
const displayPipeline = new RegExp(String.raw`^\|\s*${filter}(?:\s*\|\s*${filter})*\s*$`);
const statusEcho = /^;\s*echo\s+(["'])exit:\s*\$\?\1\s*$/;

export function registeredCheckCommand(command: string, protocol: KiloCheckProtocol): string {
  const boundary = command.search(/[|;]/);
  if (boundary < 0) return command;
  const base = command.slice(0, boundary).trim().replace(/\s+2>&1\s*$/, "");
  const registered = protocol.commands.find(c => projectCommandKey(c, protocol.cwd) === projectCommandKey(base, protocol.cwd));
  if (!registered) return command;
  const suffix = command.slice(boundary).trim();
  if (!displayPipeline.test(suffix) && !statusEcho.test(suffix))
    throw new Error("Registered verification checks require a standalone foreground command; remove shell chaining and read logs separately.");
  return registered;
}

export function kiloCheckHooks(protocol: KiloCheckProtocol) {
  return {
    "tool.execute.before": async (input: { tool: string }, output: { args: Record<string, unknown> }) => {
      if (input.tool === "bash" && typeof output.args.command === "string")
        output.args.command = registeredCheckCommand(output.args.command, protocol);
    },
  };
}
