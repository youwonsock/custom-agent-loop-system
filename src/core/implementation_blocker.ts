type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>!!v&&typeof v==="object"&&!Array.isArray(v);
export interface ImplementationBlocker {kind:"external"|"product"|"test_setup";evidence:string;}
/** Negative handoffs cannot be treated as successful implementation merely
 * because the assistant also emitted PHASE_DONE. Includes the observed bare
 * AGENT_REPORT / blocked_kind spelling; quoted examples are not reports. */
export function implementationBlocker(output:string):ImplementationBlocker|null{
  let fenced=false;const visible:string[]=[];
  for(const line of output.split("\n")){
    if(/^\s*(?:```|~~~)/.test(line)){fenced=!fenced;visible.push(" ".repeat(line.length));}
    else visible.push(fenced?" ".repeat(line.length):line);
  }
  const plain=visible.join("\n");
  if(/^VERDICT:\s*BLOCKED\s*$/m.test(plain)){
    const kind=/^BLOCKED_KIND:\s*(external|product|test_setup)\s*$/m.exec(plain)?.[1]??"external";
    return {kind:kind as ImplementationBlocker["kind"],evidence:plain.slice(-2000)};
  }
  const marker=[...plain.matchAll(/^(?:\[AGENT_REPORT\]|AGENT_REPORT)[\t ]*$/gm)].at(-1);
  if(!marker)return null;
  let body=output.slice(marker.index!+marker[0].length).trim();
  body=body.replace(/\s*\[PHASE_DONE\]\s*$/,"").trim();
  if(marker[0].startsWith("[")){
    if(!body.endsWith("[/AGENT_REPORT]"))throw Error("구현 blocker JSON의 닫는 표식이 없습니다.");
    body=body.slice(0,-"[/AGENT_REPORT]".length).trim();
  }
  if(body.startsWith("```"))body=body.replace(/^```(?:json)?\s*/,"").replace(/\s*```$/,"");
  const report:unknown=JSON.parse(body);
  if(!object(report)||report.verdict!=="BLOCKED")return null;
  if(report.role!==undefined&&report.role!=="implementation")throw Error("구현 blocker의 역할이 잘못되었습니다.");
  if(report.version!==undefined&&report.version!==1)throw Error("구현 blocker version이 잘못되었습니다.");
  if(report.blockedKind!==undefined&&report.blocked_kind!==undefined&&report.blockedKind!==report.blocked_kind)throw Error("구현 blocker 종류가 서로 다릅니다.");
  const kind=report.blockedKind??report.blocked_kind??"external";
  if(!["external","product","test_setup"].includes(String(kind)))throw Error("구현 blocker 종류가 잘못되었습니다.");
  const evidence=typeof report.handoff==="string"?report.handoff:JSON.stringify(report.requirements??report);
  return {kind:kind as ImplementationBlocker["kind"],evidence:evidence.slice(0,2000)};
}
