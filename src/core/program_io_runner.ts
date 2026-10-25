import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ProgramIoPolicy, ioDigest, ioSign, ioVerify, programEnvironment, IO_UNAVAILABLE } from "./program_io";
import { imageDigest, vmCommandArguments, vmArgumentsDigest, removeVm, containerHostEnvironment } from "./program_io_vm";

/** Trusted host broker. Model text executes only in the selected confined child. */
async function main():Promise<void> {
  const policy=JSON.parse(process.env.AGENT_GRAPH_PROGRAM_IO??"null") as ProgramIoPolicy|null;
  if(!policy||policy.version!==1||!policy.preflightPassed||Date.now()>policy.expiresAt||ioDigest(policy.profile)!==policy.profileDigest||process.platform!=="darwin")throw Error(`${IO_UNAVAILABLE} Missing/expired trusted program policy.`);
  const payload=JSON.parse(Buffer.from(process.argv[2]??"","base64url").toString());
  if(payload.policyId!==policy.id||typeof payload.id!=="string"||typeof payload.command!=="string"||!ioVerify(payload,process.argv[3],policy))throw Error(`${IO_UNAVAILABLE} Invalid command authorization.`);
  const record=(data:Record<string,unknown>)=>{const full={...data,policyId:policy.id,profileDigest:policy.profileDigest};fs.appendFileSync(path.join(policy.directory,"receipts.jsonl"),JSON.stringify({data:full,signature:ioSign(full,policy)})+"\n",{mode:0o600});};
  const name=`agio-${policy.id.slice(0,16)}-${payload.id.slice(0,16)}`,lock=path.join(policy.directory,"command.lock");
  for(;;){
    try{fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,"owner.json"),JSON.stringify({pid:process.pid,containerName:name,policyId:policy.id}));break;}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      try{
        const owner=JSON.parse(fs.readFileSync(path.join(lock,"owner.json"),"utf8"));let dead=false;
        try{process.kill(owner.pid,0);}catch(e){dead=(e as NodeJS.ErrnoException).code==="ESRCH";}
        if(dead&&owner.policyId===policy.id){if(policy.vm&&!removeVm(policy.vm,owner.containerName))throw Error(`${IO_UNAVAILABLE} Orphan VM cleanup failed.`);fs.rmSync(lock,{recursive:true});continue;}
      }catch(error){if(String(error).includes(IO_UNAVAILABLE))throw error;}
      if(Date.now()>policy.expiresAt)throw Error(`${IO_UNAVAILABLE} Command initialization lock expired.`);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  let code=125,started=false,removed=false;
  try{
    const inner={command:payload.command,scratch:path.join(policy.scratch,payload.id)};
    if(policy.vm&&imageDigest(policy.vm.binary,policy.vm.image,policy.vm.controlHome)!==policy.vm.imageDigest)throw Error(`${IO_UNAVAILABLE} Runtime image identity changed.`);
    const args=policy.vm?vmCommandArguments(policy.vm,policy.cwd,policy.scratch,policy.bootstrap,inner,name,programEnvironment(policy,payload.id),policy.id):["-p",policy.profile,policy.node,policy.bootstrap,Buffer.from(JSON.stringify(inner)).toString("base64url")];
    const child=spawn(policy.vm?.binary??"/usr/bin/sandbox-exec",args,{cwd:policy.cwd,env:policy.vm?containerHostEnvironment(policy.vm):programEnvironment(policy,payload.id),stdio:["inherit","inherit","inherit"],detached:!policy.vm});
    started=true;
    record({type:"start",id:payload.id,command:payload.command,pid:child.pid??-1,at:new Date().toISOString(),backend:policy.backend,...(policy.vm?{containerName:name,imageDigest:policy.vm.imageDigest,argumentsDigest:vmArgumentsDigest(args),network:"none"}:{})});
    const forward=(signal:NodeJS.Signals)=>{if(policy.vm)removeVm(policy.vm,name);else if(child.pid)try{process.kill(-child.pid,signal);}catch{}};
    const term=()=>forward("SIGTERM"),interrupt=()=>forward("SIGINT");process.on("SIGTERM",term);process.on("SIGINT",interrupt);
    try{code=await new Promise<number>(resolve=>{child.once("error",()=>resolve(125));child.once("close",exit=>resolve(exit??128));});}
    finally{process.off("SIGTERM",term);process.off("SIGINT",interrupt);}
    if(!policy.vm){
      const alive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch{return false;}};
      for(let i=0;i<60&&alive();i++){forward(i<5?"SIGTERM":"SIGKILL");await new Promise(resolve=>setTimeout(resolve,10));}removed=!alive();
    }
  }finally{
    if(policy.vm)removed=removeVm(policy.vm,name);
    if(started)record({type:"end",id:payload.id,command:payload.command,exitCode:code,at:new Date().toISOString(),backend:policy.backend,processGroupStopped:removed,...(policy.vm?{containerRemoved:removed}:{})});
    fs.rmSync(lock,{recursive:true});
  }
  process.exitCode=removed?code:125;
}
if(require.main===module)void main().catch(error=>{console.error(String(error));process.exitCode=125;});
