import * as path from "node:path";
import { canonicalCommand, literalShellWords } from "./verification_evidence";
type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>v&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};
/** Keep completed native reads outside the bounded recent-event ring. */
export class InspectionTracker {
  private readonly seen=new Set<string>();
  private readonly pending=new Map<string,unknown>();
  constructor(private readonly cwd:string){}
  get files():string[]{return [...this.seen];}
  private add(file:unknown):void{
    if(typeof file!=="string"||!file||file.length>2000||this.seen.size>=1000)return;
    const relative=path.relative(this.cwd,path.resolve(this.cwd,file));
    if(relative&&!path.isAbsolute(relative)&&relative!==".."&&!relative.startsWith(".."+path.sep))this.seen.add(relative.split(path.sep).join("/"));
  }
  private command(text:unknown):void{
    if(typeof text!=="string")return;
    const segments=canonicalCommand(text).split(/\s*&&\s*/);
    if(segments.length>2)return;
    if(segments.length===2){const prefix=literalShellWords(segments[0]!);if(prefix?.length!==2||prefix[0]!=="cd"||path.resolve(this.cwd,prefix[1]!)!==path.resolve(this.cwd))return;}
    const words=literalShellWords(segments.at(-1)!);if(!words?.length)return;
    const name=words.shift()!.split(/[\\/]/).at(-1)!.toLowerCase();
    if(!["cat","type","get-content"].includes(name))return;
    const files=words.filter(w=>!['--','-Path','-LiteralPath','-Raw'].includes(w));
    if(files.some(w=>w.startsWith('-')))return;
    for(const file of files)this.add(file);
  }
  observe(event:Obj):void{
    const part=obj(event.part),state=obj(part.state),item=obj(event.item);
    if(event.type==="tool_use"&&String(part.tool).toLowerCase()==="read"&&state.status==="completed")this.add(obj(state.input).filePath??obj(state.input).file_path);
    if(event.type==="item.completed"&&item.type==="command_execution"&&item.exit_code===0&&item.status!=="failed")this.command(item.command);
    const content=obj(event.message).content;
    if(Array.isArray(content))for(const value of content){const b=obj(value);
      if(event.type==="assistant"&&b.type==="tool_use"&&b.name==="Read"&&typeof b.id==="string"){this.pending.set(b.id,obj(b.input).file_path);if(this.pending.size>128)this.pending.delete(this.pending.keys().next().value!);}
      if(event.type==="user"&&b.type==="tool_result"&&typeof b.tool_use_id==="string"){if(b.is_error!==true)this.add(this.pending.get(b.tool_use_id));this.pending.delete(b.tool_use_id);}
    }
  }
}
