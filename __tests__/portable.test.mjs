import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {discoverClients} from '../clients.mjs';
import {BridgeStore,AGENTS} from '../store.mjs';
import {runBridgeWorkers} from '../claude-runner.mjs';

function temp(t){const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-portable-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('without Git, plain folders retain write-scope checks and Git repositories remain blocked',t=>{
 const cwd=temp(t),module=new URL('../changes.mjs',import.meta.url).href;
 const script=`import {observeWorkspace,compareWorkspace} from ${JSON.stringify(module)};import {writeFileSync} from 'node:fs';const task={cwd:process.cwd(),write_files:[]};const before=observeWorkspace(task);writeFileSync('rogue.txt','detect me');const after=observeWorkspace(task);console.log(JSON.stringify({before,delta:compareWorkspace(task,before,after)}));`;
 const run=()=>spawnSync(process.execPath,['--input-type=module','-e',script],{cwd,env:{...process.env,PATH:'',GIT_DIR:'',GIT_WORK_TREE:''},encoding:'utf8',windowsHide:true});
 let result=run();assert.equal(result.status,0,result.stderr);
 let data=JSON.parse(result.stdout);assert.equal(data.before.complete,true);assert.deepEqual(data.delta.outside_scope,['rogue.txt']);
 mkdirSync(path.join(cwd,'.git'));
 result=run();assert.equal(result.status,0,result.stderr);data=JSON.parse(result.stdout);
 assert.equal(data.before.complete,false);assert.match(data.before.reason,/git discovery unavailable/);
});
test('discovery works without agents and finds native clients and npm Codex without executing them',t=>{
 const home=temp(t),bin=path.join(home,'cli files');mkdirSync(bin);
 assert.deepEqual(discoverClients({home,env:{PATH:''}}).agents,[]);
 const script=path.join(bin,'node_modules/@openai/codex/bin/codex.js');mkdirSync(path.dirname(script),{recursive:true});writeFileSync(script,'');
 for(const name of ['claude.exe','agy.exe'])writeFileSync(path.join(bin,name),'');
 const found=discoverClients({home,env:{PATH:bin},platform:'win32'});
 assert.deepEqual(found.agents,AGENTS);
 assert.equal(found.workers.codex.command,process.execPath);
 assert.deepEqual(found.workers.codex.args,[script,'app-server']);
 assert.equal(found.workers.claude.command,path.join(bin,'claude.exe'));
 assert.equal(found.workers.gemini.cliPath,path.join(bin,'agy.exe'));
});
test('explicit native paths are respected; broken overrides and Windows command scripts are not silently replaced',t=>{
 const home=temp(t),bin=path.join(home,'bin');mkdirSync(bin);writeFileSync(path.join(bin,'claude.exe'),'');
 const config={codex:{executable:path.join(bin,'codex.cmd')},'claude-code':{executable:path.join(bin,'missing.exe')}};
 writeFileSync(config.codex.executable,'');
 const found=discoverClients({home,env:{PATH:bin},platform:'win32',config});
 assert.deepEqual(found.agents,[]);assert.match(found.clients.codex.error,/native/);assert.match(found.clients['claude-code'].error,/not found/);
});

for(let bits=1;bits<8;bits++)test(`only installed workers run and every installed pair can return and ACK results: subset ${bits}`,async t=>{
 const cwd=temp(t),store=new BridgeStore(':memory:');t.after(()=>store.close());
 const agents=AGENTS.filter((_,i)=>bits&(1<<i));
 const ids=[];
 for(const recipient of agents)for(const sender of agents.length>1?agents.filter(a=>a!==recipient):[AGENTS.find(a=>a!==recipient)]){
  const message_id=sender+'-'+recipient;ids.push(message_id);
  store.sendTask({message_id,task_id:'subset',sender,recipient,cwd,goal:'Reply with fixture evidence',recovery:false});}
 const fixture=name=>fileURLToPath(new URL('./fixtures/'+name,import.meta.url));
 const missing={command:path.join(cwd,'not-installed.exe')};
 const codex=agents.includes('codex')?{command:process.execPath,args:[fixture('fake-app-server.mjs')]}:missing;
 const general={command:process.execPath,args:[fixture('fake-general-cli.mjs')]};
 await runBridgeWorkers(store,{once:true,agents,codex,claude:agents.includes('claude-code')?general:missing,gemini:agents.includes('gemini')?general:missing});
 for(const id of ids){assert.equal(store.get(id).status,'ready',store.get(id).status_reason);}
 let replies=0;
 for(const recipient of AGENTS){for(const reply of store.takeReplies(recipient)){replies++;assert.equal(reply.body.status,'done');store.ackReplies(recipient,[reply.message_id]);}assert.deepEqual(store.takeReplies(recipient),[]);}
 assert.equal(replies,ids.length);
});
test('no available worker fails clearly without claiming queued work',async t=>{
 const cwd=temp(t),store=new BridgeStore(':memory:');t.after(()=>store.close());
 store.sendTask({message_id:'offline',task_id:'offline',sender:'codex',recipient:'gemini',cwd,goal:'wait'});
 await assert.rejects(runBridgeWorkers(store,{once:true,agents:[]}),/No available agents/);
 assert.equal(store.get('offline').attempt,0);
 await assert.rejects(runBridgeWorkers(store,{once:true,agents:['unknown']}),/invalid agents/);
});

for(const agents of [[],['codex','gemini']])test(`dashboard advertises available agents and rejects missing recipients/review dependencies: ${agents}`,async t=>{
 const {startDashboard}=await import('../server.mjs');
 const cwd=temp(t),store=new BridgeStore(':memory:');
 const app=await startDashboard({store,repo:cwd,workerOptions:{agents}});
 t.after(async()=>{await app.close();store.close();});
 const boot=await(await fetch(app.url+'/api/bootstrap')).json();assert.deepEqual(boot.available_agents,agents);
 assert.equal(!!boot.availability_notice,!agents.length);
 const post=(route,value)=>fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-bridge-token':boot.token},body:JSON.stringify(value)});
 const absent=await post('/api/tasks',{sender:'codex',recipient:'claude-code',goal:'work'});assert.equal(absent.status,400);
 if(agents.length){const chain=await post('/api/tasks',{sender:'gemini',recipient:'codex',goal:'work',chain:{review:true}});assert.equal(chain.status,400);assert.match((await chain.json()).error,/Codex.*Claude/);}
 else assert.equal((await post('/api/runner/start',{})).status,400);
 assert.equal(store.listTasks().length,0);
});
