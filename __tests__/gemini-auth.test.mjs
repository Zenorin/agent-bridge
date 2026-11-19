import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GeminiAuthError,geminiModelProvider,geminiRunEnv,normaliseGeminiAuth,resolveGeminiAuth} from '../gemini-auth.mjs';
import {clientsPath,readClientsConfig,settingsView,updateSettings} from '../settings.mjs';
import {discoverClients} from '../clients.mjs';
import {BridgeStore} from '../store.mjs';
import {runGeminiWorker} from '../gemini-runner.mjs';
import {checkConnections} from '../connection-check.mjs';
import {startDashboard} from '../server.mjs';

const tempDir=(t,prefix)=>{const dir=mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const generalCli=fileURLToPath(new URL('./fixtures/fake-general-cli.mjs',import.meta.url));
const connectionCli=fileURLToPath(new URL('./fixtures/fake-connection-cli.mjs',import.meta.url));
const sessionSettings=args=>JSON.parse(args[args.indexOf('--settings')+1]);

test('saved Gemini choice is validated and nothing chosen stays null',()=>{
 assert.equal(normaliseGeminiAuth(undefined),null);
 assert.deepEqual(normaliseGeminiAuth({mode:'both'}),{mode:'both',default:'api-key',account_risk_accepted_at:null});
 assert.throws(()=>normaliseGeminiAuth({mode:'browser'}),/mode must be one of/);
 assert.throws(()=>normaliseGeminiAuth({mode:'api-key',default:'account'}),/default must be one of the selected/);
});

test('each run resolves one method and explains what is missing',()=>{
 const code=fn=>{try{fn();}catch(e){assert.ok(e instanceof GeminiAuthError);return e.code;}assert.fail('expected an error');};
 assert.equal(code(()=>resolveGeminiAuth(null)),'not_chosen');
 assert.equal(code(()=>resolveGeminiAuth({mode:'api-key',default:'api-key'},{env:{}})),'api_key_missing');
 assert.equal(code(()=>resolveGeminiAuth({mode:'account',default:'account',account_risk_accepted_at:null},{env:{}})),'risk_not_accepted');
 assert.equal(code(()=>resolveGeminiAuth({mode:'api-key',default:'api-key'},{requested:'account',env:{GEMINI_API_KEY:'k'}})),'not_allowed');
 const both={mode:'both',default:'api-key',account_risk_accepted_at:'t'};
 assert.equal(resolveGeminiAuth(both,{env:{GEMINI_API_KEY:'k'}}),'api-key');
 assert.equal(resolveGeminiAuth(both,{requested:'account',env:{}}),'account');
 assert.match(new GeminiAuthError('not_chosen').message,/settings --gemini-auth/);
});

test('API key mode keeps only GEMINI_API_KEY; account mode removes every Google credential',()=>{
 const source={GEMINI_API_KEY:'k',GOOGLE_API_KEY:'g',GOOGLE_APPLICATION_CREDENTIALS:'c',PATH:'p'};
 assert.deepEqual(geminiRunEnv('api-key',source),{GEMINI_API_KEY:'k',PATH:'p'});
 assert.deepEqual(geminiRunEnv('account',source),{PATH:'p'});
 assert.equal(geminiModelProvider('api-key'),'gemini');
 assert.equal(geminiModelProvider('account'),'');
});

test('settings save agent switches and the Gemini choice without touching other entries',t=>{
 const home=tempDir(t,'bridge-settings-');
 mkdirSync(path.dirname(clientsPath(home)),{recursive:true});
 writeFileSync(clientsPath(home),JSON.stringify({gemini:{executable:'C:/tools/agy.exe',model:'m'},codex:{executable:'C:/tools/codex.exe'}}));
 updateSettings({enabled:{codex:false,'claude-code':true},gemini_auth:{mode:'api-key'}},{home});
 let saved=readClientsConfig(home);
 assert.deepEqual(saved.codex,{executable:'C:/tools/codex.exe',enabled:false});
 assert.equal(saved['claude-code'],undefined);
 assert.deepEqual(saved.gemini,{executable:'C:/tools/agy.exe',model:'m',auth:{mode:'api-key',default:'api-key'}});
 assert.throws(()=>updateSettings({gemini_auth:{mode:'account'}},{home}),/약관 위반/);
 assert.equal(readClientsConfig(home).gemini.auth.mode,'api-key');
 updateSettings({gemini_auth:{mode:'both',default:'account',accept_account_risk:true}},{home,now:()=>'2026-11-19T00:00:00Z'});
 assert.deepEqual(readClientsConfig(home).gemini.auth,{mode:'both',default:'account',account_risk_accepted_at:'2026-11-19T00:00:00Z'});
 updateSettings({gemini_auth:{mode:'account'}},{home});
 assert.equal(readClientsConfig(home).gemini.auth.account_risk_accepted_at,'2026-11-19T00:00:00Z');
 updateSettings({enabled:{codex:true},gemini_auth:null},{home});
 saved=readClientsConfig(home);
 assert.deepEqual(saved.codex,{executable:'C:/tools/codex.exe'});
 assert.deepEqual(saved.gemini,{executable:'C:/tools/agy.exe',model:'m'});
 assert.throws(()=>updateSettings({enabled:{other:true}},{home}),/unknown agent/);
});

test('switched-off agents leave discovery and the Gemini choice reaches its worker without key values',t=>{
 const dir=tempDir(t,'bridge-discover-');
 const exe=name=>{const file=path.join(dir,name+'.exe');writeFileSync(file,'');return file;};
 const env={PATH:'',AGENT_BRIDGE_CODEX_CLI:exe('codex'),AGENT_BRIDGE_CLAUDE_CLI:exe('claude'),AGENT_BRIDGE_GEMINI_CLI:exe('agy'),GEMINI_API_KEY:'secret-value'};
 const found=discoverClients({home:dir,env,platform:'win32',config:{'claude-code':{enabled:false},gemini:{auth:{mode:'api-key'}}}});
 assert.deepEqual(found.agents,['codex','gemini']);
 assert.equal(found.workers.claude,undefined);
 assert.deepEqual(found.workers.gemini.geminiAuth,{mode:'api-key',default:'api-key',account_risk_accepted_at:null});
 const view=settingsView(found,{env});
 assert.equal(view.agents['claude-code'].enabled,false);assert.equal(view.agents['claude-code'].available,false);
 assert.equal(view.gemini_auth.api_key_present,true);
 assert.doesNotMatch(JSON.stringify(view),/secret-value/);
 const broken=discoverClients({home:dir,env,platform:'win32',config:{gemini:{auth:{mode:'browser'}}}});
 assert.equal(broken.clients.gemini.auth,null);assert.match(broken.clients.gemini.auth_error,/mode must be one of/);
});

test('the Gemini runner uses the API key with modelProvider gemini only in API key mode',async t=>{
 // The call log lives outside the task folder; a write inside it would be reported as out of scope.
 const dir=tempDir(t,'bridge-gemini-key-'),log=path.join(tempDir(t,'bridge-gemini-log-'),'calls.jsonl'),store=new BridgeStore(':memory:');
 t.after(()=>store.close());
 store.sendTask({message_id:'key',task_id:'key',sender:'codex',recipient:'gemini',goal:'work',cwd:dir});
 await runGeminiWorker(store,{once:true,geminiAuth:{mode:'api-key',default:'api-key'},command:process.execPath,args:[generalCli],env:{FAKE_GENERAL_LOG:log,GEMINI_API_KEY:'test-key'}});
 assert.equal(store.get('key').status,'ready',store.get('key').status_reason);
 const [call]=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(call.hasApiKey,true);assert.equal(sessionSettings(call.args).modelProvider,'gemini');
 assert.equal(store.listRuntime('key')[0].auth,'gemini-api-key');
 store.sendTask({message_id:'acct',task_id:'acct',sender:'codex',recipient:'gemini',goal:'other work',cwd:dir,gemini_auth:'account'});
 await runGeminiWorker(store,{once:true,geminiAuth:{mode:'both',default:'api-key',account_risk_accepted_at:'t'},command:process.execPath,args:[generalCli],env:{FAKE_GENERAL_LOG:log,GEMINI_API_KEY:'test-key'}});
 const second=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)[1];
 assert.equal(second.hasApiKey,false);assert.equal(sessionSettings(second.args).modelProvider,'');
 assert.equal(store.listRuntime('acct')[0].auth,'google-account');
});

test('a Gemini task without a chosen method stops before the CLI starts and says how to choose',async t=>{
 const dir=tempDir(t,'bridge-gemini-none-'),log=path.join(tempDir(t,'bridge-gemini-log-'),'calls.jsonl'),store=new BridgeStore(':memory:');
 t.after(()=>store.close());
 store.sendTask({message_id:'none',task_id:'none',sender:'codex',recipient:'gemini',goal:'work',cwd:dir,recovery:false});
 await runGeminiWorker(store,{once:true,geminiAuth:null,command:process.execPath,args:[generalCli],env:{FAKE_GENERAL_LOG:log}});
 assert.notEqual(store.get('none').status,'ready');
 assert.match(store.get('none').status_reason,/Gemini 연결 방식을 아직 고르지 않았어요/);
 assert.equal(existsSync(log),false);
});

test('tasks reject an unknown gemini_auth value',()=>{
 const store=new BridgeStore(':memory:');
 try{assert.throws(()=>store.sendTask({message_id:'m',task_id:'t',sender:'codex',recipient:'gemini',goal:'g',cwd:os.tmpdir(),gemini_auth:'browser'}),/gemini_auth must be one of/);}
 finally{store.close();}
});

test('connection check skips Gemini until a method is chosen and probes with the chosen one',async t=>{
 const dir=tempDir(t,'bridge-gemini-check-'),log=path.join(dir,'calls.jsonl');
 const env={...process.env,CONNECTION_FIXTURE_MODE:'pass',CONNECTION_FIXTURE_LOG:log,GEMINI_API_KEY:'test-key'};
 const found=auth=>({agents:['gemini'],clients:{gemini:{installed:true,enabled:true,auth}},workers:{gemini:{command:process.execPath,args:[connectionCli]}}});
 const none=await checkConnections(found(null),{env});
 assert.equal(none.agents.gemini.reason,'gemini_not_chosen');assert.equal(none.agents.gemini.probe_invocations,0);assert.equal(existsSync(log),false);
 const keyed=await checkConnections(found({mode:'api-key',default:'api-key'}),{env});
 assert.equal(keyed.agents.gemini.call,'passed');assert.equal(keyed.agents.gemini.auth_mode,'api-key');
 const [call]=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(call.hasGeminiKey,true);assert.equal(sessionSettings(call.args).modelProvider,'gemini');
 const off=await checkConnections({...found(null),agents:[],clients:{gemini:{installed:true,enabled:false}}},{env});
 assert.equal(off.agents.gemini.reason,'disabled');assert.equal(off.ok,false);
 // A switched-off agent does not fail the check when another agent passed.
 const mixed=await checkConnections({agents:['gemini'],clients:{codex:{installed:true,enabled:false},gemini:{installed:true,enabled:true,auth:{mode:'api-key',default:'api-key'}}},
  workers:{gemini:{command:process.execPath,args:[connectionCli]}}},{env});
 assert.equal(mixed.agents.codex.reason,'disabled');assert.equal(mixed.ok,true);
});

test('dashboard settings API saves through the provider and updates available agents',async t=>{
 const store=new BridgeStore(':memory:');
 let current={agents:{codex:{installed:true,enabled:true,available:true}},gemini_auth:{mode:null},links:{}};
 const calls=[];
 const settings={view:()=>current,update:data=>{
  calls.push(data);
  if(data.gemini_auth?.mode==='account' && !data.gemini_auth.accept_account_risk)throw new Error('risk acceptance required');
  current={...current,gemini_auth:{mode:data.gemini_auth?.mode ?? null}};
  return {found:{agents:['codex','gemini'],workers:{gemini:{cliPath:'x'}}},view:current};
 }};
 const app=await startDashboard({store,port:0,workerOptions:{agents:['codex'],settings}});
 t.after(async()=>{await app.close();store.close();});
 const boot=await (await fetch(app.url+'/api/bootstrap')).json();
 const post=body=>fetch(app.url+'/api/settings',{method:'POST',headers:{'content-type':'application/json','x-bridge-token':boot.token},body:JSON.stringify(body)});
 const view=await (await fetch(app.url+'/api/settings')).json();
 assert.match(view.guide.warning,/약관 위반/);assert.equal(view.runner_running,false);
 assert.equal((await post({gemini_auth:{mode:'account'}})).status,400);
 const saved=await post({gemini_auth:{mode:'api-key'}});
 assert.equal(saved.status,200);assert.equal((await saved.json()).gemini_auth.mode,'api-key');
 assert.deepEqual((await (await fetch(app.url+'/api/state')).json()).available_agents,['codex','gemini']);
 assert.equal((await fetch(app.url+'/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 assert.equal(calls.length,2);
});
