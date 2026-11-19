import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {normalizeUsage,callTracker,claudeCallInput} from './usage.mjs';

export function recordClaudeSessionUsage(store,project,result,calls=null){
 if(!result?.session_id||!result.usage)throw new Error('Claude session has no measured usage');
 return store.recordExternalUsage({project_id:project,event_id:'claude-session:'+result.session_id,provider:'claude-code',
  source:'native Claude session result',scope:'separate-process',usage:{...normalizeUsage('claude-code',result.usage),calls},model_usage:result.modelUsage??null});
}

// Keep MCP selection per process; never rewrite the user's global configuration.
export function prepareClaudeSessionArgs(args,{bridgeOnly=false}={}) {
 const separator=args.indexOf('--'),options=args.slice(0,separator<0?args.length:separator),prompt=separator<0?[]:args.slice(separator);
 if(bridgeOnly){
  if(options.some(arg=>arg==='--mcp-config'||arg.startsWith('--mcp-config=')))throw new Error('Bridge-only mode cannot include another MCP config');
  if(!options.some(arg=>arg==='--tools'||arg.startsWith('--tools=')))options.push('--tools','Bash,Read');
  return [...options,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}',...prompt];
 }
 const withSearch=value=>!value||value==='default'||value.split(',').includes('ToolSearch')?value:value+',ToolSearch';
 for(let i=0;i<options.length;i++){
  if(options[i]==='--tools'&&typeof options[i+1]==='string'){
   i++;options[i]=withSearch(options[i]);
  }
  else if(options[i].startsWith('--tools='))options[i]='--tools='+withSearch(options[i].slice(8));
 }
 return [...options,...prompt];
}

export async function startClaudeSession(argv,{command}={}) {
 if(typeof command!=='string'||!path.isAbsolute(command)||/\.(cmd|bat|ps1)$/i.test(command))throw new Error('Claude executable must be an absolute native path');
 const separator=argv.indexOf('--'),end=separator<0?argv.length:separator;
 const bridgeOnly=argv.slice(0,end).includes('--bridge-only');
 const projectIndex=argv.slice(0,end).indexOf('--project'),project=projectIndex<0?null:argv[projectIndex+1];
 if(projectIndex>=0&&(!project||project.startsWith('-')))throw new Error('--project needs a project ID');
 const args=prepareClaudeSessionArgs(argv.filter((arg,i)=>!(i<end&&arg==='--bridge-only')&&!(projectIndex>=0&&(i===projectIndex||i===projectIndex+1))),{bridgeOnly});
 if(project){
  if(!args.includes('-p')&&!args.includes('--print'))throw new Error('--project usage capture requires print mode (-p)');
  if(args.some(a=>a.startsWith('--output-format')))throw new Error('--project selects stream-json output for usage capture');
  args.unshift('--output-format','stream-json','--verbose');
 }
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{shell:false,stdio:project?['inherit','pipe','inherit']:'inherit',windowsHide:true});
  let result,invalidStream=false;const calls=callTracker();
  if(project){
   child.stdout.on('data',chunk=>process.stdout.write(chunk));
   readline.createInterface({input:child.stdout}).on('line',line=>{
    try{const event=JSON.parse(line);if(event.type==='result')result=event;
     if(event.type==='assistant'&&event.message?.id)calls.record(event.message.id,claudeCallInput(event.message.usage));
    }catch{invalidStream=true;}
   });
  }
  child.once('error',reject);child.once('close',async(code,signal)=>{
   try{
    if(project){
     if(invalidStream)throw new Error('Claude usage capture received an invalid stream');
     const {BridgeStore}=await import('./store.mjs');const store=new BridgeStore();
     try{recordClaudeSessionUsage(store,project,result,calls.summary());}finally{store.close();}
    }
    resolve(code??(signal==='SIGINT'?130:1));
   }catch(error){reject(error);}
  });
 });
}
