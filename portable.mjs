#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';

const copyText=()=>JSON.parse(readFileSync(new URL('./distribution-text.ko.json',import.meta.url),'utf8'));

/** `settings`: shows or changes which agents take part and how Gemini signs in. */
async function settingsCommand(argv,discoverClients) {
 const {updateSettings,settingsView}=await import('./settings.mjs');
 const {GEMINI_TERMS_URL}=await import('./gemini-auth.mjs');
 const {values}=parseArgs({args:argv,strict:true,options:{enable:{type:'string'},disable:{type:'string'},'gemini-auth':{type:'string'},
  'gemini-default':{type:'string'},'accept-account-risk':{type:'boolean'},'clear-gemini-auth':{type:'boolean'},json:{type:'boolean'}}});
 const copy=copyText(),guide=copy.geminiAuth;
 const list=value=>(value ?? '').split(',').map(s=>s.trim()).filter(Boolean);
 const update={};
 if(values.enable || values.disable){
  update.enabled={};
  for(const agent of list(values.enable))update.enabled[agent]=true;
  for(const agent of list(values.disable))update.enabled[agent]=false;
 }
 if(values['clear-gemini-auth'])update.gemini_auth=null;
 else if(values['gemini-auth'])update.gemini_auth={mode:values['gemini-auth'],...(values['gemini-default']?{default:values['gemini-default']}:{}),accept_account_risk:!!values['accept-account-risk']};
 const wantsAccount=!!update.gemini_auth && update.gemini_auth.mode!=='api-key';
 if(wantsAccount)console.log('주의: '+guide.warning+'\n  '+GEMINI_TERMS_URL+'\n');
 if(Object.keys(update).length){
  try{updateSettings(update);}
  catch(error){
   if(wantsAccount && !values['accept-account-risk']){console.error(error.message+'\n동의한다면 --accept-account-risk 를 붙여 다시 실행하세요.');return 2;}
   throw error;
  }
 }
 const view=settingsView(discoverClients());
 if(values.json){console.log(JSON.stringify(view,null,2));return 0;}
 console.log('사용할 AI');
 for(const [agent,row] of Object.entries(view.agents))console.log('  '+agent+': '+(!row.installed?'설치되지 않음':row.enabled?'사용함':'꺼 둠'));
 const auth=view.gemini_auth;
 console.log('\n'+guide.title);
 if(auth.error)console.log('  설정 오류: '+auth.error);
 if(!auth.mode){
  console.log('  아직 고르지 않았어요. '+guide.intro);
  for(const [mode,option] of Object.entries(guide.options))console.log('  - '+option.label+': agent-bridge settings --gemini-auth '+mode+'\n    '+option.description);
  console.log('  개인 계정 방식(account, both)을 고를 때는 위험 안내를 읽고 --accept-account-risk 를 붙여야 해요.');
  return 0;
 }
 console.log('  방식: '+guide.options[auth.mode].label+(auth.mode==='both'?' / 기본: '+guide.options[auth.default].label:''));
 if(auth.mode!=='account')console.log('  '+(auth.api_key_present?guide.keyPresent:guide.keyMissing));
 if(auth.mode!=='account' && !auth.api_key_present)for(const [i,step] of guide.apiKeySteps.entries())console.log('    '+(i+1)+'. '+step);
 return 0;
}

export async function portableMain(argv=process.argv.slice(2)) {
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major<22 || (major===22&&minor<13))throw new Error('Agent Bridge needs Node.js 22.13 or newer; use the bundled agent-bridge.cmd');
 const {discoverClients}=await import('./clients.mjs');
 if(argv[0]==='settings')return settingsCommand(argv.slice(1),discoverClients);
 const found=discoverClients();
 const unavailable=agent=>new Error(found.clients[agent]?.installed && found.clients[agent]?.enabled===false
  ? copyText().agentDisabled+' ('+agent+')' : 'Agent unavailable: '+agent+'; run doctor');
 if(argv[0]==='claude-session'){
  if(!found.workers.claude)throw unavailable('claude-code');
  const {startClaudeSession}=await import('./claude-session.mjs');
  return startClaudeSession(argv.slice(1),found.workers.claude);
 }
 if(argv[0]==='doctor'){
  const {settingsView}=await import('./settings.mjs');
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,...found,settings:settingsView(found)},null,2));
  return 0;
 }
 if(argv[0]==='check-connections'){
  const {checkConnections}=await import('./connection-check.mjs');
  const copy=copyText().connectionCheck;
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{
   console.log(copy.title);console.log(copy.note);
   const report=await checkConnections(found,{signal:controller.signal});
   for(const [agent,row] of Object.entries(report.agents)){
    console.log(agent+': '+copy.call[row.call]+' / '+copy.authentication[row.authentication]+(row.auth_mode?' ('+copy.authMode[row.auth_mode]+')':''));
    if(row.reason)console.log('  '+(copy.reasons[row.reason] ?? row.reason));
    if(row.provider_error)console.log('  '+row.provider_error);
    if(row.usage)console.log('  '+copy.usageLabel+': '+JSON.stringify(row.usage.turn));
   }
   return controller.signal.aborted?130:report.ok?0:1;
  }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
 }
 const direct={'run-codex':'codex','run-claude':'claude-code','run-gemini':'gemini'};
 if(argv[0]==='run'&&!found.agents.length)throw new Error('No available agents; run doctor and install/sign in to a supported CLI');
 if(direct[argv[0]]&&!found.agents.includes(direct[argv[0]]))throw unavailable(direct[argv[0]]);
 const options={...found.workers,agents:found.agents};
 const selected=found.workers[{codex:'codex','claude-code':'claude',gemini:'gemini'}[direct[argv[0]]]];
 if(selected)Object.assign(options,selected);
 if(argv[0]==='run-gemini')options.cliPath=found.workers.gemini.cliPath;
 // The dashboard reads and saves the same settings; after a save it rediscovers the agents.
 const {settingsView,updateSettings}=await import('./settings.mjs');
 options.settings={view:()=>settingsView(discoverClients()),update:data=>{updateSettings(data);const next=discoverClients();return {found:next,view:settingsView(next)};}};
 process.env.PATH=path.dirname(process.execPath)+path.delimiter+(process.env.PATH ?? '');
 const {main}=await import('./cli.mjs');
 return main(argv.length?argv:['serve'],options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 portableMain().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
