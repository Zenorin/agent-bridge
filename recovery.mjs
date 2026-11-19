// Decides whether a blocked task may go back to the queue by itself. Pure: the store applies the decision.
// Rules approved by the user on 2026-11-11 (② only): see README "자동 복구".
import {existsSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AGENTS} from './store.mjs';
import {classifyFailure} from './failures.mjs';

// Failures that can pass if the same request is simply sent again later. Auth, timeouts and our own checks never qualify.
export const RETRY_KINDS=['quota','outage','process_exit'];
export const MAX_RETRIES=2;
export const BACKOFF_MS=[5*60_000,30*60_000];
export const MAX_WAIT_MS=6*60*60_000;

export function defaultRecoveryFile() {
  return path.join(os.homedir(),'.agent-bridge','recovery.json');
}

function fallbackEntry(entry) {
  if(!entry || typeof entry!=='object')throw new Error('each fallback must be an object');
  const {from,to,on,profiles,model=null,effort=null}=entry;
  if(!AGENTS.includes(from) || !AGENTS.includes(to) || from===to)throw new Error('fallback from and to must be two different agents');
  if(!Array.isArray(on) || !on.length || on.some(kind=>!RETRY_KINDS.includes(kind)))throw new Error(`fallback on must list only ${RETRY_KINDS.join(', ')}`);
  if(!Array.isArray(profiles) || !profiles.length || profiles.some(name=>typeof name!=='string' || !name.trim()))throw new Error('fallback profiles must name at least one profile');
  for(const value of [model,effort])if(value!==null && (typeof value!=='string' || !value.trim()))throw new Error('fallback model and effort must be text or null');
  return {from,to,on,profiles,model,effort};
}

/** The user's allowlist of agent handovers. A missing file means none; an unreadable one is ignored as a whole. */
export function loadFallbacks(file=defaultRecoveryFile()) {
  if(!existsSync(file))return {entries:[]};
  try {
    const raw=JSON.parse(readFileSync(file,'utf8'));
    if(!Array.isArray(raw?.fallback))throw new Error('fallback list is missing');
    return {entries:raw.fallback.map(fallbackEntry)};
  } catch(error) {
    return {entries:[],error:`recovery.json ignored: ${error.message}`};
  }
}

const UNIT_MS={s:1_000,m:60_000,h:3_600_000};

/** Wait the provider asked for, when its message says so in relative terms; clock times are not guessed. */
export function resetDelay(reason) {
  const text=String(reason ?? '');
  const relative=/(?:try again|retry|resets?|available again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
  if(relative)return Math.max(60_000,Math.ceil(Number(relative[1])*UNIT_MS[relative[2][0].toLowerCase()]));
  const header=/retry-after:?\s*(\d+)\b/i.exec(text);
  return header?Math.max(60_000,Number(header[1])*1_000):null;
}

/** Why the attempt cannot be shown to have left nothing behind, or null when it provably did nothing. */
function missingEvidence(row,receipt) {
  if(row.cleanup_pending)return 'cleanup';
  const tools=receipt?.activity?.tool_calls;
  if(!Number.isSafeInteger(tools))return 'tools_unmeasured';
  if(tools>0){
    const readOnlyQuota=row.recipient==='claude-code' && receipt.provider_failure?.kind==='quota'
      && row.body.sandbox==='read-only' && row.body.write_files?.length===0
      && receipt.tool_log?.length===tools && receipt.tool_log.every(tool=>['Read','Grep','Glob','StructuredOutput'].includes(tool.name));
    if(!readOnlyQuota)return 'tools_ran';
  }
  const observation=receipt?.change_observation;
  if(!observation?.complete)return 'observation_missing';
  if(observation.observed.length)return 'workspace_changed';
  return null;
}

function excluded(row,profile) {
  const task=row.body;
  if(task.recovery===false)return 'off';
  if(row.root_id)return 'chain';
  if(task.contract)return 'contract';
  if(task.execution?.adapter)return 'program';
  if(profile==='image')return 'image';
  if(row.cancel_requested)return 'cancel';
  return null;
}

/**
 * `row` is the blocked task as stored, `receipt` its runtime record for the attempt that stopped.
 * Returns null when the failure is not one recovery handles; otherwise retry, fallback or stay, with the reason.
 */
export function decideRecovery({row,receipt,profile='standard',fallbacks={entries:[]},now=Date.now()}) {
  const failure=classifyFailure(row.status,row.status_reason);
  if(!failure || !RETRY_KINDS.includes(failure.kind))return null;
  const kind=failure.kind,history=row.recovery ?? [];
  const asked=resetDelay(row.status_reason);
  // Other tasks for an agent at its usage limit wait with this one; a misread wait never holds an agent past the cap.
  const holdFor=wait=>kind==='quota'?new Date(now+Math.min(wait,MAX_WAIT_MS)).toISOString():null;
  const stay=code=>({action:'stay',kind,code,hold:holdFor(asked ?? BACKOFF_MS[0]),...(fallbacks.error?{fallback_error:fallbacks.error}:{})});
  const code=excluded(row,profile) ?? missingEvidence(row,receipt);
  if(code)return stay(code);
  // Claude quota waiting is independent of the bounded retry policy for execution failures.
  if(kind==='quota' && row.recipient==='claude-code'){
    const retries=history.filter(entry=>entry.action==='retry' && entry.kind==='quota').length;
    const reset=Date.parse(receipt?.provider_failure?.reset_at);
    const wait=Number.isFinite(reset) && reset>now?reset-now:asked ?? BACKOFF_MS[Math.min(retries,BACKOFF_MS.length-1)];
    const retryAt=new Date(now+wait).toISOString();
    return {action:'retry',kind,retry:retries+1,max:null,retry_at:retryAt,hold:retryAt};
  }
  if(!row.body.thread_id && !history.some(entry=>entry.action==='fallback')) {
    const entry=fallbacks.entries.find(item=>item.from===row.recipient && item.to!==row.sender && item.on.includes(kind) && item.profiles.includes(profile));
    if(entry)return {action:'fallback',kind,from:row.recipient,to:entry.to,hold:holdFor(asked ?? BACKOFF_MS[0]),
      model:{before:row.body.model ?? null,after:entry.model},effort:{before:row.body.effort ?? null,after:entry.effort}};
  }
  const retries=history.filter(entry=>entry.action==='retry').length;
  if(retries>=MAX_RETRIES)return stay('retries_used');
  const wait=asked ?? BACKOFF_MS[retries];
  if(wait>MAX_WAIT_MS)return stay('wait_too_long');
  const retryAt=new Date(now+wait).toISOString();
  return {action:'retry',kind,retry:retries+1,max:MAX_RETRIES,retry_at:retryAt,hold:kind==='quota'?retryAt:null,
    ...(fallbacks.error?{fallback_error:fallbacks.error}:{})};
}
