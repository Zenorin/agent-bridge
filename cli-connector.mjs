import {spawn,spawnSync} from 'node:child_process';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {buildPrompt} from './codex-runner.mjs';
import {hashFile,pathKey,snapshotHashes} from './store.mjs';
import {loadProfiles,resolveProfile,taskPacket,replyPacket} from './profiles.mjs';
import {normalizeUsage,zeroUsage,callTracker,claudeCallInput,geminiStepCall} from './usage.mjs';
import {verifyWire} from './contracts.mjs';
import {claudeQuota} from './failures.mjs';
import {verifyCommunication,observePermissionDenial} from './communication.mjs';

export function createCliConnector(claimed, options) {
  const task=claimed.body, id=claimed.message_id;
  let proc,exited,exitCode,spawnError,streamError,result,sessionId=task.thread_id ?? randomUUID(),stopping;
  let response='',stderr='',before,profile,receipt,previousTotal=null;
  let rejectInterrupted;
  // Only clients that report per-request usage in their stream (Claude, Gemini) get a call count; others stay null.
  const calls=callTracker();
  let callsUnmeasured=false;
  const interruptFailed=new Promise((_,reject)=>{rejectInterrupted=reject;});
  interruptFailed.catch(()=>{});
  const usage=()=>{
    if(options.agent==='program')return zeroUsage('program');
    const raw=result?.usage ?? result?.stats;
    if(!raw)return null;
    const normalized=normalizeUsage(options.agent,raw),{turn}=normalized;
    return {...normalized,thread_total:Object.fromEntries(Object.entries(turn).map(([key,value])=>[key,value===null?null:value+(previousTotal?.[key] ?? 0)])),calls:callsUnmeasured?null:calls.summary(),model:task.model ?? null};
  };
  const stop=()=>stopping ??= (async()=>{
    if(!proc || exitCode!==undefined || spawnError) return;
    let treeError;
    if(process.platform==='win32') {
      const killed=spawnSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'pipe'});
      if(killed.error || (killed.status!==0 && proc.exitCode===null)) {
        proc.kill('SIGKILL');
        treeError=new Error(`${options.agent} process tree termination failed`);
      }
    } else {try{process.kill(-proc.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
    let timer;
    try {await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${options.agent} exit was not confirmed`)),3000);})]);}
    finally{clearTimeout(timer);}
    if(treeError)throw treeError;
  })();
  const execute=async({store,ready})=>{
    profile=resolveProfile(loadProfiles(options.profilesPath),task.profile ?? options.profile ?? 'standard');
    previousTotal=task.thread_id?store.lastThreadTotal(task.thread_id,task.recipient):null;
    before=Object.fromEntries(task.write_files.map(f=>[f,hashFile(task.cwd,f)]));
    const command=options.command;
    if(!path.isAbsolute(command) || /\.(cmd|bat)$/i.test(command))throw new Error('CLI executable must be an absolute native path');
    const args=options.buildArgs(task,{args:options.args,sessionId});
    receipt={agent:options.agent,auth:options.agent==='gemini'?'google-account':null,tool_log:[],hook_events:[],config_verified:false,...options.receipt};
    store.saveRuntime(id,receipt,claimed);
    proc=spawn(command,args,{cwd:task.cwd,env:options.getEnv?.({...process.env,...options.env}) ?? {...process.env,...options.env},
      shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    exited=new Promise(resolve=>{proc.once('error',e=>{spawnError=e;});proc.once('close',code=>{exitCode=code;resolve();});});
    proc.stderr.on('data',c=>{stderr=(stderr+c).slice(-2000);});
    proc.stdin.on('error',e=>{streamError ??= e;});
    const lines=readline.createInterface({input:proc.stdout});
    lines.on('line',line=>{
      if(!line.trim())return;
      if(line==='Client.listTools() called but server does not advertise tools capability - returning empty list') {
        (receipt.warnings ??= []).push(line); return;
      }
      try{
        const event=JSON.parse(line);
        observePermissionDenial(event,receipt);
        if(options.agent==='claude-code'){const quota=claudeQuota(event);if(quota)receipt.provider_failure=quota;}
        if(options.agent==='program')result={structured_output:event};
        if(event.conversation_id)sessionId=event.conversation_id;
        if(event.event==='step_update' && event.step_update?.tool_name)receipt.tool_log.push({name:event.step_update.tool_name});
        const denial=event.step_update?.tool_info?.error?.message;
        if(typeof denial==='string' && /permission check failed|permission denied|user denied permission/i.test(denial)){
          receipt.permission_denials ??= [];
          if(!receipt.permission_denials.includes(denial))receipt.permission_denials.push(denial);
        }
        if(options.agent==='gemini' && event.event==='step_update') {
          // A finished request without usage would make the count too low, so the whole count is dropped instead.
          const call=geminiStepCall({...event.step_update,conversation_id:event.step_update.conversation_id ?? event.conversation_id});
          if(call?.unmeasured)callsUnmeasured=true; else if(call)calls.record(call.id,call.input);
        }
        if(event.event==='result')result={...event.result,result:event.result.response,stats:event.result.usage};
        if(options.agent==='gemini' && ['tool_use','tool_result'].includes(event.type))response='';
        if(event.session_id)sessionId=event.session_id;
        if(event.type==='message' && event.role==='assistant')response+=event.content ?? '';
        if(event.type==='assistant' && event.message?.id)calls.record(event.message.id,claudeCallInput(event.message.usage));
        if(event.type==='assistant')for(const block of event.message?.content ?? []) {
          if(block.type==='text')response+=block.text;
          if(block.type==='tool_use')receipt.tool_log.push({name:block.name});
        }
        if(event.type==='tool_use')receipt.tool_log.push({name:event.tool_name});
        if(event.type==='system' && ['hook_started','hook_response'].includes(event.subtype))receipt.hook_events.push({
          subtype:event.subtype,hook_name:event.hook_name,exit_code:event.exit_code,outcome:event.outcome});
        if(event.type==='result')result=event;
        if(event.type==='error')streamError ??= new Error(event.error?.message ?? event.message ?? 'CLI error');
        store.saveRuntime(id,receipt,claimed);
      }catch(e){streamError ??= e;}
    });
    store.setTurn(id,sessionId,`${options.agent}:${claimed.attempt}`,claimed); ready();
    const packet=taskPacket(task,profile);
    const prompt=buildPrompt({file_refs:[],...packet,task_id:task.task_id,message_id:id});
    const input=options.buildInput?options.buildInput(task,packet):prompt;
    if(task.communication)store.saveRuntime(id,{communication_delivery:verifyCommunication(task,input)},claimed);
    if(task.contract)store.saveRuntime(id,{contract_delivery:verifyWire(task,input)},claimed);
    proc.stdin.end(options.inputFormat==='stream-json'?JSON.stringify({event:'user',message:{content:input}})+'\n':input);
    await Promise.race([exited,interruptFailed]); lines.close();
    store.setTurn(id,sessionId,`${options.agent}:${claimed.attempt}`,claimed);
    return result;
  };
  // A line that could not be read may have been a tool call, so the count is then unknown.
  const activity=()=>({tool_calls:streamError?null:receipt?.tool_log.length ?? 0});
  return {communication:true,execute,resume:execute,usage,activity,async interrupt(){try{await stop();}catch(error){rejectInterrupted(error);throw error;}},close:stop,
    parse(output,{store}) {
      if(store.isCancelRequested(id))return {status:'cancelled',reason:'interrupted on request'};
      if(spawnError)throw spawnError;
      const denial=receipt?.permission_denials?.at(-1);
      const permissionError=denial?`${options.agent} permission denied: ${denial}`:null;
      if(streamError)throw new Error(permissionError ?? `invalid ${options.agent} stream: ${streamError.message}`);
      if(receipt.provider_failure?.kind==='quota')throw new Error(`${options.agent} quota exceeded`);
      if(exitCode!==0)throw new Error(permissionError ?? `${options.agent} exited (${exitCode}): ${[stderr.trim(),...(output?.errors ?? []),output?.is_error?output.result:null].filter(Boolean).join('; ')}`);
      if(!output || output.is_error || ['ERROR','error','CANCELLED','cancelled'].includes(output.status) || output.error || (output.subtype && output.subtype!=='success'))throw new Error(permissionError ?? `${options.agent} result was not successful: ${output?.error ?? output?.status ?? ''}`);
      if(output.permission_denials?.length)throw new Error(permissionError ?? `${options.agent} permission denied`);
      if(options.inputFormat==='stream-json' && output.status!=='SUCCESS')throw new Error(permissionError ?? `${options.agent} did not complete: ${output.status}`);
      const required=options.agent==='claude-code' ? loadProfiles(options.profilesPath).claude_required_hooks ?? [] : [];
      if(required.some(name=>!receipt.hook_events.some(e=>e.subtype==='hook_response' && e.hook_name===name && e.exit_code===0 && e.outcome==='success')))throw new Error('required hook not observed');
      const text=output.result ?? response;
      if(task.contract)store.saveRuntime(id,{contract_raw_reply:output.structured_output ?? text},claimed);
      if(!output.structured_output && !text.trim())throw new Error(permissionError ?? `${options.agent} returned an empty reply`);
      let parsed;
      try{parsed=output.structured_output ?? JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,''));}
      catch(error){throw new Error(permissionError ?? error.message);}
      if(!parsed || !['done','question','failed'].includes(parsed.status) || typeof parsed.summary!=='string'
        || !Array.isArray(parsed.changed_files) || parsed.changed_files.some(f=>typeof f!=='string') || !Array.isArray(parsed.acceptance)
        || parsed.acceptance.some(c=>typeof c.criterion!=='string' || !['pass','fail','unverified'].includes(c.result) || typeof c.evidence!=='string')
        || (parsed.status==='question' && (typeof parsed.question!=='string' || !parsed.question.trim())))throw new Error('invalid agent reply');
      if(permissionError && parsed.status==='failed')throw new Error(permissionError);
      const keys=task.write_files.map(f=>pathKey(f,task.cwd));
      const outside=parsed.changed_files.filter(f=>{const key=pathKey(f,task.cwd);return !keys.some(s=>key===s || key.startsWith(s+'/'));});
      if(outside.length)throw new Error('agent reported writes outside task scope: '+outside.join(', '));
      const reply={...parsed,thread_id:sessionId,cwd:task.cwd,input_hashes:snapshotHashes(task),
        changed_files:{reported:parsed.changed_files,observed:task.write_files.filter(f=>hashFile(task.cwd,f)!==before[f]),outside_scope:outside}};
      reply.delivery=replyPacket(reply,profile);
      reply.projection={profile:profile.id};
      return {outcome:parsed.status==='question'?'question':'result',reply,usage:usage()};
    }};
}
