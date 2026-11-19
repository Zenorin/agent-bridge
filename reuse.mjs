import {loadProfiles,DEFAULT_PROFILES} from './profiles.mjs';
import {hashFile,pathKey} from './store.mjs';
import {digest} from './context.mjs';
import {programConfig} from './program-runner.mjs';
import {lstatSync,readdirSync} from 'node:fs';
import path from 'node:path';

function stable(value){return Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;}
function containsLinks(file){const stat=lstatSync(file);return stat.isSymbolicLink()||(stat.isDirectory()&&readdirSync(file).some(name=>containsLinks(path.join(file,name))));}
// The whole process environment changed with every shell and carried secrets; only variables that can change a pure result count.
const RUNNER_ENV=/^(AGENT_BRIDGE_|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/i;
function reuseEnv(task,options){
  const names=[...Object.keys(options.env ?? {}),...(task.reuse.env ?? []),...Object.keys(process.env).filter(name=>RUNNER_ENV.test(name))];
  return Object.fromEntries([...new Set(names)].map(name=>[name,(Object.hasOwn(options.env ?? {},name)?options.env[name]:process.env[name]) ?? null]));
}

export function reuseKey(task,options={}) {
  if(task.repeat)return null;
  if(!task.reuse)return null;
  if(task.reuse.pure!==true || typeof task.reuse.version!=='string' || !task.reuse.version.trim())throw new Error('reuse requires pure:true and an explicit version');
  // Built-in review chains keep their independent, current-attempt verification.
  if(task.root_id || task.chain || task.role==='review')return null;
  const files=[...new Set([...task.file_refs.map(ref=>ref.path),...(task.reuse.files ?? [])])];
  const inputs=Object.fromEntries(files.map(file=>[file,hashFile(task.cwd,file)]));
  if(Object.values(inputs).some(value=>value===null))return null;
  if(files.some(file=>containsLinks(pathKey(file,task.cwd))))return null;
  const intent={...task,file_refs:task.file_refs.map(({hash,...ref})=>ref)};
  for(const key of ['message_id','task_id','reply_to','followup_key','followup_request_hash','thread_id'])delete intent[key];
  const profiles=loadProfiles(options.profilesPath ?? DEFAULT_PROFILES);
  const execution=task.execution?.adapter?(options.resolvedProgram ?? programConfig(task,options)):{command:options.command ?? null,args:options.args ?? null,env:options.env ?? null};
  return digest(stable({intent,cwd:pathKey(task.cwd),inputs,profiles,execution,env:reuseEnv(task,options)}));
}

export function findReusable(store,key,task) {
  if(!key)return null;
  const entry=store.db.prepare('SELECT * FROM result_reuse WHERE fingerprint=?').get(key);
  if(!entry)return null;
  const source=store.get(entry.message_id),reply=store.get(entry.reply_id);
  if(source?.status!=='ready'||source.cleanup_pending||source.cancel_requested||source.attempt!==reply?.attempt
    ||reply?.body.status!=='done'||reply.body.current===false)return null;
  const hashes=JSON.parse(entry.output_hashes);
  if(Object.entries(hashes).some(([file,hash])=>!hash||hashFile(task.cwd,file)!==hash))return null;
  return {reply:structuredClone(reply.body),source:{message_id:source.message_id,attempt:source.attempt,reply_id:reply.message_id},fingerprint:key};
}

export function rememberResult(store,key,task,claim) {
  if(!key || store.get(claim.message_id)?.status!=='ready')return;
  const replyId=`${claim.message_id}:attempt:${claim.attempt}:result`,reply=store.get(replyId);
  if(!reply || reply.body.status!=='done'||reply.body.reused_from||reply.body.verdict==='reject')return;
  const checks=reply.body.acceptance ?? reply.body.criteria ?? [];
  if(!Array.isArray(checks)||checks.some(check=>!check||typeof check!=='object'))return;
  if(task.acceptance.some(criterion=>!checks.some(check=>check.criterion===criterion&&check.result==='pass'&&typeof check.evidence==='string'&&check.evidence.trim())))return;
  if(checks.some(check=>check.result!=='pass'))return;
  const hashes=Object.fromEntries(task.write_files.map(file=>[file,hashFile(task.cwd,file)]));
  if(Object.values(hashes).some(hash=>hash===null))return;
  store.db.prepare('INSERT OR REPLACE INTO result_reuse VALUES (?,?,?,?)').run(key,claim.message_id,replyId,JSON.stringify(hashes));
}
