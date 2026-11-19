import {existsSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCliConnector} from './cli-connector.mjs';
import {runAgentTask,runAgentWorker} from './runner-core.mjs';
import {RESULT_SCHEMA} from './codex-runner.mjs';
import {responseSchema} from './contracts.mjs';

export function googleAccountEnv(source) {
  const env={...source};
  for(const key of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_GENAI_USE_GCA','GOOGLE_APPLICATION_CREDENTIALS','GEMINI_CLI_AUTH_OVERRIDE'])delete env[key];
  return env;
}
export function buildGeminiArgs(task,{args=[],settings={},model}={}) {
  if(!Array.isArray(args) || args.some(a=>typeof a!=='string' || a.startsWith('-')))throw new Error('invalid Gemini prefix arguments');
  const session={modelProvider:''};
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
  const clients=existsSync(clientsFile)?JSON.parse(readFileSync(clientsFile,'utf8')):{};
  const command=options.command ?? options.cliPath ?? process.env.AGENT_BRIDGE_GEMINI_CLI ?? clients.gemini?.executable
    ?? (process.platform==='win32'?path.join(os.homedir(),'AppData','Local','agy','bin','agy.exe'):path.join(os.homedir(),'.local','bin','agy'));
  return createCliConnector(claimed,{...options,command,agent:'gemini',inputFormat:'stream-json',
    buildArgs:(task,args)=>buildGeminiArgs(task,{...args,settings,model:clients.gemini?.model}),getEnv:googleAccountEnv});
}
export const runGeminiTask=(store,claimed,options={})=>runAgentTask(store,claimed,createGeminiConnector(claimed,options),options);
export const runGeminiWorker=(store,options={})=>runAgentWorker(store,{...options,recipient:'gemini',createConnector:createGeminiConnector});
