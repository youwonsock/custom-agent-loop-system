import { projectCommandKey, verificationSetupParts, checkCommandKey, ownedVerificationCapture } from "./verification_evidence";
import { TEST_POLICY, testCommandAllowed } from "./test_source_guard";
import { broadProcessTermination, UNSCOPED_TERMINATION } from "./process_command_policy";
import { nativeScopeProblem, SCOPE_DENIED } from "./native_scope";

export interface KiloCheckProtocol {
  cwd: string;
  commands: string[];
  testSourcesReadOnly?: boolean;
  guardOwnedProcesses?: boolean;
  aliases?: Record<string,string>;
  scopeRoots?: string[];
}

// Only display-only wrappers around an exact registered check are repaired.
// Unknown commands, compound checks and other working directories keep their
// original semantics and remain ineligible as verification evidence.
const filter = String.raw`(?:(?:head|tail)(?:\s+(?:-n\s+\d+|-\d+|\d+))?|grep(?:\s+-[EFivnx]+)*\s+(?:'[^'\r\n]*'|"[^"$\x60\r\n]*"))`;
const displayPipeline = new RegExp(String.raw`^\|\s*${filter}(?:\s*\|\s*${filter})*\s*$`);
const statusEcho = /^;\s*echo\s+(["'])exit:\s*\$\?\1\s*$/;

export function registeredCheckCommand(command: string, protocol: KiloCheckProtocol): string {
  const boundary = command.search(/[|;]/);
  const aliasBase=(boundary<0?command:command.slice(0,boundary)).trim().replace(/\s+2>&1\s*$/,"");
  const alias=Object.entries(protocol.aliases??{}).find(([from,to])=>protocol.commands.includes(to)&&projectCommandKey(from,protocol.cwd)===projectCommandKey(aliasBase,protocol.cwd));
  const setup=verificationSetupParts(aliasBase,protocol.cwd);
  const prepared=(check:string)=>setup?.preparation.length?[...setup.preparation,check].join(" && "):check;
  if(setup&&checkCommandKey(setup.body)!==setup.body&&!ownedVerificationCapture(setup.body,protocol.cwd))return command;
  if(alias){if(boundary>=0&&!displayPipeline.test(command.slice(boundary).trim())&&!statusEcho.test(command.slice(boundary).trim()))throw Error("Registered verification aliases require a standalone foreground command.");return prepared(alias[1]);}
  if (boundary < 0) {
    const registered=protocol.commands.find(c=>projectCommandKey(c,protocol.cwd)===projectCommandKey(command,protocol.cwd));
    // Preserve only the check's configured output capture, including when the
    // CLI spells that same destination with a quoted/escaped absolute path.
    if(registered&&setup&&(setup.preparation.length||checkCommandKey(setup.body)!==setup.body))return prepared(registered);
    return command;
  }
  const base = command.slice(0, boundary).trim().replace(/\s+2>&1\s*$/, "");
  const registered = protocol.commands.find(c => projectCommandKey(c, protocol.cwd) === projectCommandKey(base, protocol.cwd));
  if (!registered) return command;
  const suffix = command.slice(boundary).trim();
  if (!displayPipeline.test(suffix) && !statusEcho.test(suffix))
    throw new Error("Registered verification checks require a standalone foreground command; remove shell chaining and read logs separately.");
  return prepared(registered);
}

export function kiloCheckHooks(protocol: KiloCheckProtocol) {
  return {
    "tool.execute.before": async (input: { tool: string }, output: { args: Record<string, unknown> }) => {
      if(protocol.guardOwnedProcesses&&input.tool==="bash"&&typeof output.args.command==="string"&&broadProcessTermination(output.args.command,protocol.cwd))
        throw Error(`${UNSCOPED_TERMINATION} Broad process-name termination is blocked BEFORE execution. Never use pkill, killall, taskkill /IM, Stop-Process -Name or kill with pgrep. Close server objects or the child processes this task actually started; use recorded owned PIDs only.`);
      if(protocol.testSourcesReadOnly&&/^(?:write|edit|multiedit|apply_patch|delete|move|rename)$/i.test(input.tool))
        throw Error(`${TEST_POLICY} Test role cannot edit product, test, package or frozen files. Return FAIL; implementation owns repairs.`);
      if(protocol.scopeRoots){
        const problem=nativeScopeProblem(input.tool,output.args,protocol.cwd,protocol.scopeRoots);
        if(problem)throw Error(`${SCOPE_DENIED} Blocked BEFORE execution: ${problem}. Use target-relative paths inside ${protocol.cwd}. Do not inspect parent folders, user configuration or session data. Continue with in-target files; no operator approval is needed for this denied query.`);
      }
      if (input.tool === "bash" && typeof output.args.command === "string")
        output.args.command = registeredCheckCommand(output.args.command, protocol);
      if(protocol.testSourcesReadOnly&&input.tool==="bash"&&(!testCommandAllowed(String(output.args.command??""),protocol.cwd,protocol.commands)))
        throw Error(`${TEST_POLICY} Test role permits registered foreground checks, read-only inspection and mkdir verification only. No repair scripts, custom execution or source writes. Use native read for diagnosis and return FAIL for implementation. Command: ${String(output.args.command??"").slice(0,600)}`);
    },
  };
}
