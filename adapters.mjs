import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { projectFields, resolveProfile } from './profiles.mjs';

export async function callAdapter(config,profileId,name,input,{signal,cwd}={}) {
  const profile=resolveProfile(config,profileId);
  const adapter=config.adapters?.[name];
  if (!adapter || !profile.adapters?.includes(name)) throw new Error(`adapter not selected: ${name}`);
  const packet=projectFields(input,adapter.input_fields);
  const child=spawn(adapter.command,adapter.args ?? [],{cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
  let stdout='',stderr='';
  child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c);
  child.stdin.on('error',()=>{});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);child.stdin.end(JSON.stringify(packet));});
  const receipt={id:randomUUID(),adapter:name,profile:profileId,created_at:new Date().toISOString(),input_fields:adapter.input_fields,exit_code:code,stderr};
  if(code!==0) return {...receipt,status:'failed',error:`adapter exited (${code})`,output:null,full_output:stdout};
  let full;
  try { full=JSON.parse(stdout); } catch {return {...receipt,status:'failed',error:'adapter output is not JSON',output:null,full_output:stdout};}
  if(!full || typeof full!=='object' || Array.isArray(full)) return {...receipt,status:'failed',error:'adapter output must be an object',output:null,full_output:full};
  const output=projectFields(full,[...new Set(['status','error',...adapter.output_fields])]);
  return {...receipt,status:'completed',output,full_output:full,omitted_output_fields:Object.keys(full).filter(k=>!Object.hasOwn(output,k))};
}
