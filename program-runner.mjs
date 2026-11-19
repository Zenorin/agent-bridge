import path from 'node:path';
import {createCliConnector} from './cli-connector.mjs';
import {loadProfiles,resolveProfile,projectFields} from './profiles.mjs';
import {hashFile} from './store.mjs';
import {existsSync} from 'node:fs';
import {wirePacket} from './contracts.mjs';

export function programConfig(task,options={}) {
  const config=loadProfiles(options.profilesPath),profile=resolveProfile(config,task.profile ?? options.profile ?? 'standard');
  const name=task.execution?.adapter,adapter=config.adapters?.[name];
  if(!adapter || !profile.adapters?.includes(name))throw new Error(`adapter not selected: ${name}`);
  if(task.execution && Object.keys(task.execution).some(key=>key!=='adapter'))throw new Error('program command and arguments belong in external adapter configuration');
  if(task.role==='review')throw new Error('built-in independent review must use its reviewer connector');
  if(!path.isAbsolute(adapter.command)||/\.(cmd|bat)$/i.test(adapter.command))throw new Error('program executable must be an absolute native path');
  if(adapter.code_files && (!Array.isArray(adapter.code_files)||adapter.code_files.some(file=>typeof file!=='string')))throw new Error('invalid adapter code_files');
  const first=adapter.args?.[0];
  const script=first&&/\.(mjs|cjs|js|py|ps1|sh)$/i.test(first)?first:null;
  const files=[adapter.command,...(script?[script]:[]),...(adapter.code_files ?? [])].map(file=>path.resolve(task.cwd,file));
  if(files.some(file=>!existsSync(file)))throw new Error('registered program code file is missing');
  return {name,adapter,profile,code_hashes:Object.fromEntries(files.map(file=>[file,hashFile(task.cwd,file)]))};
}

export function createProgramConnector(claimed,options={}) {
  const {name,adapter,profile,code_hashes}=options.resolvedProgram ?? programConfig(claimed.body,options);
  return createCliConnector(claimed,{...options,agent:'program',command:adapter.command,
    buildArgs:()=>adapter.args ?? [],receipt:{adapter:name,code_hashes,profile_hash:profile.config_hash},
    buildInput:(task,packet)=>JSON.stringify({...projectFields(task,adapter.input_fields),...packet,
      file_refs:task.file_refs,context:task.context,task_id:task.task_id,message_id:task.message_id,cwd:task.cwd,...(task.contract?wirePacket(task):{})})});
}
