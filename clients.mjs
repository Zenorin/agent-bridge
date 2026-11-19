import {existsSync,readFileSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AGENTS} from './store.mjs';

const file = value => {try{return statSync(value).isFile();}catch{return false;}};

// Discovery checks local files only; login and protocol compatibility are verified when a task runs.
export function discoverClients({home=os.homedir(),env=process.env,platform=process.platform,config}={}) {
 const settings=path.join(home,'.agent-bridge','clients.json');
 config ??= existsSync(settings)?JSON.parse(readFileSync(settings,'utf8').replace(/^\uFEFF/,'')):{};
 if(!config || typeof config!=='object' || Array.isArray(config))throw new Error('clients.json must contain an object');
 const windows=platform==='win32',suffix=windows?'.exe':'',dirs=(env.PATH ?? env.Path ?? '').split(windows?';':':').filter(Boolean);
 const npmDirs=[...dirs,path.join(home,'AppData','Roaming','npm')];
 const defaults={
  codex:[...dirs.map(dir=>path.join(dir,'codex'+suffix)),...npmDirs.map(dir=>path.join(dir,'node_modules','@openai','codex','bin','codex.js')),path.join(home,'.local','bin','codex'+suffix)],
  'claude-code':[path.join(home,'.local','bin','claude'+suffix),...dirs.map(dir=>path.join(dir,'claude'+suffix))],
  gemini:[path.join(home,'.agent-bridge','runtime','antigravity','agy'+suffix),...(windows?[path.join(home,'AppData','Local','agy','bin','agy.exe')]:[path.join(home,'.local','bin','agy')]),...dirs.map(dir=>path.join(dir,'agy'+suffix))],
 };
 const names={codex:'AGENT_BRIDGE_CODEX_CLI','claude-code':'AGENT_BRIDGE_CLAUDE_CLI',gemini:'AGENT_BRIDGE_GEMINI_CLI'};
 const clients={},workers={};
 for(const agent of AGENTS){
  const override=env[names[agent]] ?? config[agent]?.executable;
  const executable=override ?? defaults[agent].find(file);
  let error=null;
  if(executable && (typeof executable!=='string' || !path.isAbsolute(executable)))error='CLI executable must be an absolute path';
  else if(executable && windows && /\.(cmd|bat|ps1)$/i.test(executable))error='CLI executable must be native; for npm Codex select codex.js';
  else if(!executable || !file(executable))error='CLI executable not found';
  clients[agent]={installed:!error,executable:executable ?? null,error,authentication:'not-checked',model:typeof config[agent]?.model==='string'?config[agent].model:null};
  if(error)continue;
  if(agent==='codex')workers.codex=/\.[cm]?js$/i.test(executable)?{command:process.execPath,args:[executable,'app-server']}:{command:executable,args:['app-server']};
  else if(agent==='claude-code')workers.claude={command:executable};
  else workers.gemini={cliPath:executable};
 }
 const agents=AGENTS.filter(agent=>clients[agent].installed);
 return {agents,clients,workers,review_chain_available:agents.includes('codex')&&agents.includes('claude-code')};
}
