#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';

export async function portableMain(argv=process.argv.slice(2)) {
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major<22 || (major===22&&minor<13))throw new Error('Agent Bridge needs Node.js 22.13 or newer; use the bundled agent-bridge.cmd');
 const {discoverClients}=await import('./clients.mjs');
 const found=discoverClients();
 if(argv[0]==='claude-session'){
  if(!found.workers.claude)throw new Error('Agent unavailable: claude-code; run doctor');
  const {startClaudeSession}=await import('./claude-session.mjs');
  return startClaudeSession(argv.slice(1),found.workers.claude);
 }
 if(argv[0]==='doctor'){
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,...found},null,2));
  return 0;
 }
 if(argv[0]==='check-connections'){
  const {checkConnections}=await import('./connection-check.mjs');
  const copy=JSON.parse(readFileSync(new URL('./distribution-text.ko.json',import.meta.url),'utf8')).connectionCheck;
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{
   console.log(copy.title);console.log(copy.note);
   const report=await checkConnections(found,{signal:controller.signal});
   for(const [agent,row] of Object.entries(report.agents)){
    console.log(agent+': '+copy.call[row.call]+' / '+copy.authentication[row.authentication]);
    if(row.reason)console.log('  '+(copy.reasons[row.reason] ?? row.reason));
    if(row.provider_error)console.log('  '+row.provider_error);
    if(row.usage)console.log('  '+copy.usage+': '+JSON.stringify(row.usage.turn));
   }
   return controller.signal.aborted?130:report.ok?0:1;
  }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
 }
 const direct={'run-codex':'codex','run-claude':'claude-code','run-gemini':'gemini'};
 if(argv[0]==='run'&&!found.agents.length)throw new Error('No available agents; run doctor and install/sign in to a supported CLI');
 if(direct[argv[0]]&&!found.agents.includes(direct[argv[0]]))throw new Error('Agent unavailable: '+direct[argv[0]]+'; run doctor');
 const options={...found.workers,agents:found.agents};
 const selected=found.workers[{codex:'codex','claude-code':'claude',gemini:'gemini'}[direct[argv[0]]]];
 if(selected)Object.assign(options,selected);
 if(argv[0]==='run-gemini')options.cliPath=found.workers.gemini.cliPath;
 process.env.PATH=path.dirname(process.execPath)+path.delimiter+(process.env.PATH ?? '');
 const {main}=await import('./cli.mjs');
 return main(argv.length?argv:['serve'],options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 portableMain().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
