import {existsSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCliConnector} from './cli-connector.mjs';
import {runAgentTask,runAgentWorker} from './runner-core.mjs';
import {RESULT_SCHEMA} from './codex-runner.mjs';
import {responseSchema} from './contracts.mjs';
import {geminiModelProvider,geminiRunEnv,normaliseGeminiAuth,resolveGeminiAuth} from './gemini-auth.mjs';

/** Environment for personal-account sign-in: every Google credential variable is removed. */
export const googleAccountEnv = source => geminiRunEnv('account', source);

export function buildGeminiArgs(task,{args=[],settings={},model,authMode='account'}={}) {
  if(!Array.isArray(args) || args.some(a=>typeof a!=='string' || a.startsWith('-')))throw new Error('invalid Gemini prefix arguments');
  const session={modelProvider:geminiModelProvider(authMode)};
  if(task.sandbox==='read-only')session.permissions={...settings.permissions,
    deny:[...new Set([...(settings.permissions?.deny ?? []),'write_file(*)','command(*)','mcp(*)','execute_url(*)'])]};
  return [...args,'--input-format','stream-json','--output-format','stream-json','--json-schema',JSON.stringify(responseSchema(RESULT_SCHEMA,task)),
    '--settings',JSON.stringify(session),...(task.sandbox==='workspace-write'?['--mode','auto','--sandbox']:[]),
    ...(task.model ?? model?['--model',task.model ?? model]:[]),...(task.thread_id?['--conversation',task.thread_id]:[])];
}
export function createGeminiConnector(claimed,options={}) {
  const settingsPath=path.join(os.homedir(),'.gemini','antigravity-cli','settings.json');
  const settings=existsSync(settingsPath)?JSON.parse(readFileSync(settingsPath,'utf8')):{};
  const clientsFile=path.join(os.homedir(),'.agent-bridge','clients.json');
  const clients=existsSync(clientsFile)?JSON.parse(readFileSync(clientsFile,'utf8').replace(/^﻿/,'')):{};
  const command=options.command ?? options.cliPath ?? process.env.AGENT_BRIDGE_GEMINI_CLI ?? clients.gemini?.executable
    ?? (process.platform==='win32'?path.join(os.homedir(),'AppData','Local','agy','bin','agy.exe'):path.join(os.homedir(),'.local','bin','agy'));
  // The saved choice comes from discovery; read the file only when a caller did not pass it.
  const auth=options.geminiAuth!==undefined ? options.geminiAuth : (()=>{try{return normaliseGeminiAuth(clients.gemini?.auth ?? null);}catch{return null;}})();
  let mode;
  return createCliConnector(claimed,{...options,command,agent:'gemini',inputFormat:'stream-json',
    // Resolved when the task starts, so a missing choice or key fails that task with a readable reason.
    buildArgs:(task,args)=>{
      mode=resolveGeminiAuth(auth,{requested:task.gemini_auth,env:{...process.env,...options.env}});
      return buildGeminiArgs(task,{...args,settings,model:clients.gemini?.model,authMode:mode});
    },
    getEnv:env=>geminiRunEnv(mode,env),
    receipt:()=>({auth:mode==='api-key'?'gemini-api-key':'google-account'})});
}
export const runGeminiTask=(store,claimed,options={})=>runAgentTask(store,claimed,createGeminiConnector(claimed,options),options);
export const runGeminiWorker=(store,options={})=>runAgentWorker(store,{...options,recipient:'gemini',createConnector:createGeminiConnector});
