import { projectCommandKey, verificationSetupParts, checkCommandKey, ownedVerificationCapture } from "./verification_evidence";
import { TEST_POLICY, testCommandAllowed } from "./test_source_guard";
import { broadProcessTermination, UNSCOPED_TERMINATION } from "./process_command_policy";
import { nativeScopeProblem, SCOPE_DENIED } from "./native_scope";
import { normalizeInspectionCommand } from "./inspection_syntax";
import { literalShellWords } from "./verification_evidence";
import { ProgramIoPolicy, wrapProgramCommand, unwrapProgramCommand, programCommandProof, programProofAuthorization, programPromptPolicies, IO_DENIED, IO_VIOLATION } from "./program_io";

export interface KiloCheckProtocol {
  cwd: string;
  commands: string[];
  testSourcesReadOnly?: boolean;
  guardOwnedProcesses?: boolean;
  aliases?: Record<string,string>;
  scopeRoots?: string[];
  programIo?: ProgramIoPolicy;
  readOnlyRole?: boolean;
}

// Only display-only wrappers around an exact registered check are repaired.
// Unknown commands, compound checks and other working directories keep their
// original semantics and remain ineligible as verification evidence.
const filter = String.raw`(?:(?:head|tail)(?:\s+(?:-n\s+\d+|-\d+|\d+))?|grep(?:\s+-[EFivnx]+)*\s+(?:'[^'\r\n]*'|"[^"$\x60\r\n]*"))`;
const displayPipeline = new RegExp(String.raw`^\|\s*${filter}(?:\s*\|\s*${filter})*\s*$`);
const statusEcho = /^;\s*echo\s+(["'])exit:\s*\$\?\1\s*$/;

export function registeredCheckCommand(command: string, protocol: KiloCheckProtocol): string {
  const equivalent=(left:string,right:string)=>{const a=projectCommandKey(left,protocol.cwd),b=projectCommandKey(right,protocol.cwd);if(a===b)return true;const aw=literalShellWords(a),bw=literalShellWords(b);return !!aw&&!!bw&&JSON.stringify(aw)===JSON.stringify(bw);};
  const boundary = command.search(/[|;]/);
  const aliasBase=(boundary<0?command:command.slice(0,boundary)).trim().replace(/\s+2>&1\s*$/,"");
  const alias=Object.entries(protocol.aliases??{}).find(([from,to])=>protocol.commands.includes(to)&&equivalent(from,aliasBase));
  const setup=verificationSetupParts(aliasBase,protocol.cwd);
  const prepared=(check:string)=>setup?.preparation.length?[...setup.preparation,check].join(" && "):check;
  if(setup&&checkCommandKey(setup.body)!==setup.body&&!ownedVerificationCapture(setup.body,protocol.cwd))return command;
  if(alias){if(boundary>=0&&!displayPipeline.test(command.slice(boundary).trim())&&!statusEcho.test(command.slice(boundary).trim()))throw Error("Registered verification aliases require a standalone foreground command.");return prepared(alias[1]);}
  if (boundary < 0) {
    const registered=protocol.commands.find(c=>equivalent(c,command));
    // Preserve only the check's configured output capture, including when the
    // CLI spells that same destination with a quoted/escaped absolute path.
    if(registered&&setup)return prepared(registered);
    return command;
  }
  const base = command.slice(0, boundary).trim().replace(/\s+2>&1\s*$/, "");
  const registered = protocol.commands.find(c => equivalent(c,base));
  if (!registered) return command;
  const suffix = command.slice(boundary).trim();
  if (!displayPipeline.test(suffix) && !statusEcho.test(suffix))
    throw new Error("Registered verification checks require a standalone foreground command; remove shell chaining and read logs separately.");
  return prepared(registered);
}

export function kiloCheckHooks(protocol: KiloCheckProtocol) {
  const promptPolicies=protocol.programIo?programPromptPolicies(protocol.programIo):[];
  return {
    "tool.execute.before": async (input: { tool: string }, output: { args: Record<string, unknown> }) => {
      const nativeCommand=output.args.command;
      if(protocol.programIo&&typeof nativeCommand==="string"&&literalShellWords(nativeCommand)?.[1]===protocol.programIo.runner)throw Error(`${IO_DENIED} Invalid arguments for the "bash" tool: internal authorization wrappers are not product commands. Send the plain target-relative Linux command.`);
      if(protocol.programIo&&!["bash","todowrite"].includes(input.tool))throw Error(`${IO_DENIED} This tool is unavailable in kernel-isolated mode. Use bash for target file inspection and permitted changes; never delegate to another tool/process host.`);
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
      if(protocol.scopeRoots&&input.tool==='bash'&&typeof output.args.command==='string')output.args.command=normalizeInspectionCommand(output.args.command,protocol.cwd);
      if(protocol.testSourcesReadOnly&&input.tool==="bash"&&(!testCommandAllowed(String(output.args.command??""),protocol.cwd,protocol.commands)))
        throw Error(`${TEST_POLICY} Test role permits registered foreground checks, read-only inspection and mkdir verification only. No repair scripts, custom execution or source writes. Use native read for diagnosis and return FAIL for implementation. Command: ${String(output.args.command??"").slice(0,600)}`);
      if(protocol.programIo&&input.tool==='bash'){
        if(typeof output.args.command!=="string")throw Error(`${IO_DENIED} Invalid arguments for the "bash" tool: expected command (string), never an empty input.`);
        if(protocol.readOnlyRole&&(!testCommandAllowed(output.args.command,protocol.cwd,[])||/\bmkdir\b/.test(output.args.command)))throw Error(`${IO_DENIED} Read-only role permits file inspection only; no checks, code execution or writes.`);
        output.args.command=wrapProgramCommand(output.args.command,protocol.programIo,String(nativeCommand));
        output.args.workdir=protocol.cwd;
      }
    },
    ...(protocol.programIo?{"tool.execute.after":async(input:{tool:string;args:Record<string,unknown>},output:{metadata?:Record<string,unknown>})=>{
      if(input.tool==="bash"&&typeof input.args.command==="string"){
        const command=unwrapProgramCommand(input.args.command,protocol.programIo!),proof=programCommandProof(input.args.command,protocol.programIo!);
        if(!command||!proof)throw Error(`${IO_VIOLATION} Invalid internal command proof.`);
        output.metadata={...output.metadata,agentGraphProgramIo:proof};
        input.args.command=command.nativeCommand;
      }
    },"experimental.chat.messages.transform":async(_input:unknown,output:{messages:unknown[]})=>{
      const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"?v as Record<string,unknown>:{};
      for(let i=0;i<output.messages.length;i++){
        const message=object(output.messages[i]);if(!Array.isArray(message.parts))continue;
        // Kilo can persist the wrapped input before the after hook. Rewrite a
        // copy of the model context, preserving raw native evidence in storage.
        output.messages[i]={...message,parts:message.parts.map(raw=>{
          const part=object(raw),state=object(part.state),args=object(state.input),metadata=object(state.metadata);
          if(part.type!=="tool"||part.tool!=="bash"||typeof args.command!=="string")return raw;
          let command:ReturnType<typeof unwrapProgramCommand>=null;
          for(const policy of promptPolicies){
            const direct=unwrapProgramCommand(args.command,policy),recorded=programProofAuthorization(metadata.agentGraphProgramIo,policy);
            if(direct){command=direct;break;}
            if(recorded?.nativeCommand===args.command){command=recorded;break;}
          }
          if(!command)return raw;
          const {agentGraphProgramIo,...publicMetadata}=metadata;
          return{...part,state:{...state,input:{...args,command:command.command},metadata:publicMetadata}};
        })};
      }
    }}:{}),
  };
}
