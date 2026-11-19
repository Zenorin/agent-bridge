import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import {normalizeUsage} from './usage.mjs';
import {GeminiAuthError,geminiModelProvider,geminiRunEnv,resolveGeminiAuth} from './gemini-auth.mjs';

function failure(text) {
 if(/invalid model selection|conflicts with --effort|unknown model|model .*not found|unrecognized argument|unknown flag/i.test(text))return 'configuration';
 if(/\b401\b|unauthenticated|authentication required|not logged in|login required|invalid.*token|expired.*token/i.test(text))return 'authentication';
 if(/\b429\b|quota|rate.limit|resource.exhausted|usage.limit/i.test(text))return 'quota';
 if(/permission denied|permission check failed|access denied|\b403\b/i.test(text))return 'permission';
 return 'call_failed';
}

function safeError(value) {
 return String(value).replace(/https?:\/\/\S+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[redacted]')
  .replace(/(?:Bearer\s+|sk-|AIza|ya29\.)[^\s"',}]+|[A-Za-z0-9_=-]{32,}/g,'[redacted]')
  .replace(/((?:access_token|refresh_token|api_key|authorization|id_token)["']?\s*[:=]\s*)[^,\n]+/gi,'$1[redacted]').slice(0,1000);
}

// CLI streams stay private: only classifications and numeric usage leave this process.
function runCli(command,args,{cwd,env,input='',timeoutMs,signal,onEvent}={}) {
 return new Promise(resolve=>{
  if(signal?.aborted){resolve({reason:'cancelled',exitCode:null,text:''});return;}
  const child=spawn(command,args,{cwd,env,windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  let text='',reason=null,spawnError;
  const stop=why=>{
   if(reason||child.exitCode!==null)return;
   reason=why;
   if(!child.pid)return;
   if(process.platform==='win32'){
    const killed=spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    if(killed.error||killed.status!==0){child.kill('SIGKILL');reason='cleanup_failed';}
   }else try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')reason='cleanup_failed';}
  };
  const abort=()=>stop('cancelled');signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>stop('timeout'),timeoutMs);
  child.on('error',error=>{spawnError=error;});
  child.stderr.on('data',chunk=>{text=(text+chunk).slice(-8000);});
  child.stdin.on('error',()=>{});
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{text=(text+line+'\n').slice(-8000);try{onEvent?.(JSON.parse(line),stop);}catch{}});
  child.on('close',exitCode=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);lines.close();resolve({reason:reason ?? (spawnError?'call_failed':null),exitCode,text});});
  child.stdin.end(input);
 });
}

export async function checkConnections(found,{env=process.env,timeoutMs=90_000,signal}={}) {
 const tempRoot=path.resolve(os.tmpdir()),cwd=mkdtempSync(path.join(tempRoot,'bridge-connection-'));
 const agents={},report={ok:false,agents,temporary_cleanup:{status:'removed'}};
 try {
  for(const agent of ['codex','gemini']){
   const row=agents[agent]={installed:!!found.clients?.[agent]?.installed,authentication:'not_verified',call:'skipped',reason:null,probe_invocations:0,usage:null};
   if(!row.installed){row.reason='not_installed';continue;}
   if(found.clients[agent].enabled===false){row.reason='disabled';continue;}
   if(signal?.aborted){row.reason='cancelled';continue;}
   // Gemini is probed with the sign-in method chosen in settings; without a usable choice it is not called.
   let geminiMode;
   if(agent==='gemini'){
    try{geminiMode=resolveGeminiAuth(found.clients.gemini.auth ?? null,{env});}
    catch(e){if(!(e instanceof GeminiAuthError))throw e;row.reason='gemini_'+e.code;continue;}
    row.auth_mode=geminiMode;
   }
   const worker=found.workers[agent],prefix=agent==='codex'?(worker.args ?? []).filter((arg,i,all)=>i!==all.length-1||arg!=='app-server'):(worker.args ?? []);
   const command=worker.command ?? worker.cliPath;
   if(agent==='codex'){
    const login=await runCli(command,[...prefix,'login','status'],{cwd,env,timeoutMs:Math.min(timeoutMs,15_000),signal});
    if(login.reason||login.exitCode!==0){row.reason=login.reason ?? (failure(login.text)==='authentication'?'authentication':'login_status_failed');row.authentication=row.reason==='authentication'?'missing':'not_verified';continue;}
    row.authentication='stored';row.login_method=/ChatGPT/i.test(login.text)?'chatgpt':/API key/i.test(login.text)?'api_key':'unknown';
   }
   const nonce='BRIDGE_'+randomBytes(8).toString('hex');
   const schema={type:'object',additionalProperties:false,properties:{echo:{type:'string',const:nonce}},required:['echo']};
   const prompt='Return '+JSON.stringify({echo:nonce})+' only. Do not use tools.';
   let reply='',completed=false,usage,providerError='',responseShape;
   const onEvent=(event,stop)=>{
    const item=event.item;
    if(event.type==='error'||event.type==='turn.failed')providerError=event.error?.message ?? event.message ?? '';
    if(event.step_update?.step_type==='tool'||event.type==='tool_use'||(item&&/command.?execution|file.?change|mcp.?tool|web.?search|function.?call/i.test(item.type ?? ''))){stop('tool_attempt');return;}
    if(item?.type==='agent_message')reply=item.text ?? '';
    if(event.type==='turn.completed'){completed=true;usage=event.usage?{...event.usage,cachedInputTokens:event.usage.cached_input_tokens}:null;}
    if(event.event==='result'){completed=event.result?.status==='SUCCESS';reply=event.result?.structured_output ?? event.result?.response ?? '';usage=event.result?.usage;responseShape={keys:Object.keys(event.result ?? {}),reply_type:typeof reply,reply_length:typeof reply==='string'?reply.length:null};if(!completed)providerError=event.result?.error?.message ?? event.result?.error ?? event.result?.errors?.join('; ') ?? reply;}
   };
   const model=found.clients[agent].model;
   let args;
   if(agent==='codex'){
    const schemaFile=path.join(cwd,'schema.json');writeFileSync(schemaFile,JSON.stringify(schema));
    args=[...prefix,'-a','never','-c','project_doc_max_bytes=0','-c','skills.include_instructions=false','-c','model_reasoning_effort="low"','exec','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--json','--color','never','--output-schema',schemaFile,...(model?['--model',model]:[]),'-'];
   }else{
    const settingsFile=path.join(os.homedir(),'.gemini','antigravity-cli','settings.json');
    let permissions;
    try{permissions=existsSync(settingsFile)?JSON.parse(readFileSync(settingsFile,'utf8').replace(/^\uFEFF/,'' )).permissions ?? {}:{};}catch{row.reason='configuration';continue;}
    if(typeof permissions!=='object'||Array.isArray(permissions)||!Array.isArray(permissions.deny ?? [])){row.reason='configuration';continue;}
    const settings={modelProvider:geminiModelProvider(geminiMode),permissions:{...permissions,deny:[...new Set([...(permissions.deny ?? []),'read_file(*)','write_file(*)','command(*)','mcp(*)','execute_url(*)'])]}};
    args=[...prefix,'--print',prompt,'--output-format','stream-json','--json-schema',JSON.stringify(schema),'--disable-slash-commands','--settings',JSON.stringify(settings),...(model?['--model',model]:['--effort','low'])];
   }
   const started=Date.now();row.probe_invocations=1;
   const result=await runCli(command,args,{cwd,env:agent==='gemini'?geminiRunEnv(geminiMode,env):env,input:agent==='codex'?prompt:'',timeoutMs,signal,onEvent});
   row.elapsed_ms=Date.now()-started;row.exit_code=result.exitCode;
   if(usage){const normalized=normalizeUsage(agent,usage);row.usage={provider:normalized.provider,input_semantics:normalized.input_semantics,turn:normalized.turn};}
   let matched=false;try{matched=(typeof reply==='string'?JSON.parse(reply):reply)?.echo===nonce;}catch{}
   if(!result.reason&&result.exitCode===0&&completed&&matched){row.call='passed';row.authentication='verified';}
   else{row.call='failed';row.reason=result.reason ?? (result.exitCode!==0?failure(providerError||result.text):'unexpected_reply');if(row.reason==='authentication')row.authentication='missing';if(providerError)row.provider_error=safeError(providerError);if(row.reason==='unexpected_reply')row.response_shape=responseShape;}
  }
  report.ok=Object.values(agents).every(row=>row.call==='passed');return report;
 }finally{
  if(path.dirname(path.resolve(cwd))!==tempRoot)throw new Error('Unexpected temporary check path');
  try{rmSync(cwd,{recursive:true,force:true});}catch(error){report.temporary_cleanup={status:'retained',reason:error.code ?? 'cleanup_failed'};}
 }
}
