import * as path from "node:path";
import { CommandReceipt, SessionState, NodeVisit } from "../shared/domain";
import { canonicalCommand, checkCommandKey, literalShellWords, projectCommandKey, currentTestProof } from "./verification_evidence";
import { sourceHashes } from "./verification_sources";

export const TEST_POLICY = "[AGENT_GRAPH_TEST_POLICY]";
export const TEST_FAILED = "[AGENT_GRAPH_TEST_FAILED]";
type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>v&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};

/** Test sources are immutable; only registered checks and inspection/preparation are allowed. */
export function testCommandAllowed(command:string,cwd:string,registered:string[]):boolean {
  let text=canonicalCommand(command).trim();
  const segments=text.split(/\s*&&\s*/);
  if(segments.length===2){const cd=literalShellWords(segments[0]!);if(cd?.length!==2||cd[0]!=="cd"||path.resolve(cwd,cd[1]!)!==path.resolve(cwd))return false;text=segments[1]!;}
  else if(segments.length!==1)return false;
  if(registered.some(c=>text===c||text===checkCommandKey(c)))return true;
  const prep=literalShellWords(text);
  if(prep?.[0]==="mkdir")return prep.slice(1).filter(w=>w!=="-p").every(w=>/^verification(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(w))&&prep.some(w=>w==="verification"||w.startsWith("verification/"));
  if(/[\n;`$<>]/.test(text))return false;
  return text.split(/\s*\|\s*/).every(segment=>{
    const words=literalShellWords(segment);if(!words?.length)return false;
    const name=words[0]!.split(/[\\/]/).at(-1)!.toLowerCase();
    if(name==="sed")return words.length===4&&words[1]==="-n"&&/^\d+(?:,\d+)?p$/.test(words[2]!);
    if(!["cat","type","head","tail","pwd","ls","rg","grep","wc","stat","get-content","get-childitem"].includes(name))return false;
    return !words.slice(1).some(w=>/^--pre(?:=|$)|^--files-without-match=/.test(w));
  });
}

export function testPolicyEvent(event:Obj):string|null {
  const part=obj(event.part),state=obj(part.state);
  return event.type==="tool_use"&&state.status==="error"&&typeof state.error==="string"&&state.error.includes(TEST_POLICY)
    ?state.error.slice(0,6000):null;
}
export function failedRegisteredCheck(receipts:CommandReceipt[],cwd:string,registered:string[]):CommandReceipt|undefined {
  return receipts.find(c=>c.exitCode!==0&&!c.environmentError&&registered.some(r=>projectCommandKey(c.command,cwd)===projectCommandKey(r,cwd)));
}
export function sourceDifference(before:Record<string,string>,after:Record<string,string>):string[]{
  return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(f=>before[f]!==after[f]);
}
export function validSourceHashes(v:unknown):v is Record<string,string>{
  return !!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length<=10000&&Object.entries(v).every(([p,h])=>p.length>0&&p.length<2000&&!p.startsWith("/")&&!/[\\\0]/.test(p)&&p.split("/").every(s=>s!==".."&&s!=="."&&!!s)&&typeof h==="string"&&/^[a-f0-9]{64}$/.test(h));
}
export async function testSources(root:string):Promise<Record<string,string>>{
  return sourceHashes(root,path.join(root,"verification"));
}
export function currentVerificationSources(state:SessionState,before:NodeVisit):Record<string,string>|undefined{
  if(!currentTestProof(state,before).length)return undefined;
  return state.visits.slice(0,state.visits.findIndex(v=>v.id===before.id)).reverse().find(v=>state.graph.nodes.find(n=>n.id===v.nodeId)?.type==="test"&&v.verdict==="PASS"&&v.status==="succeeded")?.verificationSourceHashes;
}
