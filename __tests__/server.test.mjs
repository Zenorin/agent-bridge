import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BridgeStore,hashFile } from '../store.mjs';
import { DEFAULT_PROFILES, loadProfiles } from '../profiles.mjs';
import { startDashboard } from '../server.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const gitInit=(dir)=>execFileSync('git',['init','-q',dir],{windowsHide:true});

test('AB02: dashboard answers a rework question without forwarding internal fields',async(t)=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-answer-'));gitInit(dir);
 const store=new BridgeStore(path.join(dir,'queue.db'));
 const app=await startDashboard({store,repo:dir});
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
 store.sendTask({message_id:'root',task_id:'AB02',sender:'claude-code',recipient:'codex',goal:'implement',cwd:dir,
   sandbox:'workspace-write',write_files:['a.txt'],chain:{review:true}});
 const implementation=store.claimTask('codex','fixture');
 store.setTurn('root','codex-session','turn-1',implementation);
 store.finishTask('root',{claim:implementation,outcome:'result',reply:{status:'done',summary:'fixture'}});
 const review=store.claimTask('claude-code','fixture');
 store.finishTask(review.message_id,{claim:review,outcome:'result',reply:{status:'done',verdict:'reject',summary:'fix',criteria:[],
   findings:[{criterion:'c',problem:'p',required_change:'fix',files:['a.txt']}],
   boundary_review:{paths:'unchanged',exec:'unchanged',auth_permissions:'unchanged',notes:''}}});
 const rework=store.claimTask('codex','fixture');
 assert.ok(rework.body.findings.length);
 const question=store.finishTask(rework.message_id,{claim:rework,outcome:'question',reply:{status:'question',question:'which case?'}});
 const boot=await (await fetch(app.url+'/api/bootstrap')).json();
 const response=await fetch(app.url+`/api/tasks/${encodeURIComponent(rework.message_id)}/answer`,{
   method:'POST',headers:{'content-type':'application/json','x-bridge-token':boot.token},body:JSON.stringify({answer:'empty input'})});
 const result=await response.json();
 assert.equal(response.status,200,JSON.stringify(result));
 const answer=result.message;
 assert.equal(answer.body.goal,'empty input');assert.equal(answer.root_id,'root');assert.equal(answer.round,2);
 assert.equal(answer.body.thread_id,'codex-session');assert.deepEqual(answer.write_files,['a.txt']);
 for(const key of ['pending_review','findings','implementation','current']) assert.equal(Object.hasOwn(answer.body,key),false);
 assert.ok(store.get(question.message_id).delivered_at);
 const claim=store.claimTask('codex','fixture');assert.equal(claim.message_id,answer.message_id);
 store.finishTask(claim.message_id,{claim,outcome:'result',reply:{status:'done',summary:'answered'}});
 assert.equal(store.get('root:review:2').status,'queued');
});

for(const kind of ['file','dotdot-directory']) test(`작업 cwd는 ${kind==='file'?'일반 파일을 거절한다':'..로 시작하는 내부 폴더를 허용한다'}`,async(t)=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-cwd-'));gitInit(dir);
 const store=new BridgeStore(path.join(dir,'queue.db'));
 const app=await startDashboard({store,repo:dir});
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const cwd=path.join(dir,kind==='file'?'input.txt':'..cache');
 if(kind==='file')writeFileSync(cwd,'not a directory');else mkdirSync(cwd);
 const boot=await (await fetch(app.url+'/api/bootstrap')).json();
 const response=await fetch(app.url+'/api/tasks',{method:'POST',headers:{'content-type':'application/json','x-bridge-token':boot.token},body:JSON.stringify({message_id:kind,sender:'claude-code',recipient:'codex',goal:'cwd validation',cwd})});
 assert.equal(response.status,kind==='file'?400:200);
 assert.equal(store.get(kind)?.status ?? null,kind==='file'?null:'queued');
});

test('화면 실행기는 여러 작업을 병렬로 맡고 중단 시 진행 중인 턴을 정리한다',async(t)=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-pool-'));gitInit(dir);const store=new BridgeStore(path.join(dir,'queue.db'));
 const app=await startDashboard({store,repo:dir,workers:2,workerOptions:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/fake-app-server.mjs',import.meta.url))],env:{FAKE_MODE:'slow'},pollMs:10,cancelPollMs:10}});
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const boot=await (await fetch(app.url+'/api/bootstrap')).json();
 const post=(url,data={})=>fetch(app.url+url,{method:'POST',headers:{'content-type':'application/json','x-bridge-token':boot.token},body:JSON.stringify(data)});
 for(let n=0;n<2;n++) await post('/api/tasks',{message_id:`pool-${n}`,repeat:true,sender:'claude-code',recipient:'codex',goal:'check',cwd:dir});
 await post('/api/runner/start');
 for(let n=0;n<200 && store.listTasks().some(task=>!task.turn_id);n++) await sleep(25);
 assert.ok(store.listTasks().every(task=>task.status==='working' && task.turn_id));
 assert.notEqual(store.get('pool-0').claimed_by,store.get('pool-1').claimed_by);
 await post('/api/runner/stop');
 for(let n=0;n<200 && store.listTasks().some(task=>task.status==='working');n++) await sleep(25);
 assert.ok(store.listTasks().every(task=>task.status==='cancelled'));
});

test('현황 API는 작업 제출·취소·ACK를 처리하고 교차 출처 변경과 잘못된 프로필을 거절한다',async(t)=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-web-'));gitInit(dir); const store=new BridgeStore(path.join(dir,'queue.db'));
 // The default file requires no plugins; give this copy one so the "keep required plugins" rule is exercised.
 const profiles=path.join(dir,'profiles.json'); writeFileSync(profiles,JSON.stringify({...loadProfiles(DEFAULT_PROFILES),required_plugins:['required@test']}));
 const app=await startDashboard({store,repo:dir,profilesPath:profiles,port:0});
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const boot=await (await fetch(app.url+'/api/bootstrap')).json();
 const post=(url,body={},extra={})=>fetch(app.url+url,{method:'POST',headers:{'content-type':'application/json','x-bridge-token':boot.token,...extra},body:JSON.stringify(body)});
 assert.equal((await post('/api/tasks',{}, {origin:'https://bad.invalid'})).status,403);
 assert.equal((await fetch(app.url+'/api/runner/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 const task={message_id:'web-1',task_id:'W',sender:'claude-code',recipient:'codex',goal:'review',cwd:dir,profile:'review'};
 assert.equal((await post('/api/tasks',{...task,profile:'invalid'})).status,400);
 assert.equal((await post('/api/tasks',task)).status,200);
 const outside=mkdtempSync(path.join(os.tmpdir(),'bridge-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
 assert.equal((await post('/api/tasks',{...task,message_id:'out-1',cwd:outside})).status,400);
 assert.equal((await post('/api/tasks',{...task,message_id:'out-2',cwd:path.join(dir,'..')})).status,400);
 assert.equal(store.get('out-1'),null);
 assert.equal((await (await fetch(app.url+'/api/state')).json()).tasks[0].message_id,'web-1');
 assert.equal((await post('/api/tasks/web-1/cancel')).status,200);
 assert.equal(store.get('web-1').status,'cancelled');
 store.sendTask({...task,message_id:'reply'}); const claim=store.claimTask('codex','runner:test');
 const reply=store.finishTask('reply',{claim,outcome:'result',reply:{status:'done',summary:'<script>bad()</script>'}});
 assert.equal((await post('/api/ack',{message_id:reply.message_id,recipient:'claude-code'})).status,200);
 assert.equal(store.takeReplies('claude-code').length,0);
 const config=boot.profiles.config; config.required_plugins=[];
 assert.equal((await post('/api/profiles',{config,hash:boot.profiles.hash})).status,400);
 const withAdapter=structuredClone(boot.profiles.config);withAdapter.adapters={x:{command:'calc.exe',input_fields:['goal'],output_fields:['summary']}};
 assert.equal((await post('/api/profiles',{config:withAdapter,hash:boot.profiles.hash})).status,400);
 assert.equal((await fetch(app.url+'/../../store.mjs')).status,404);
 writeFileSync(path.join(dir,'input.txt'),'before');
 store.sendTask({...task,message_id:'retry',task_id:'retry'});const retryClaim=store.claimTask('codex','runner:test');
 store.finishTask('retry',{claim:retryClaim,outcome:'result',reply:{status:'failed',cwd:dir,input_hashes:{'input.txt':hashFile(dir,'input.txt')}}});
 writeFileSync(path.join(dir,'input.txt'),'after');
 const detail=await (await fetch(app.url+'/api/tasks/retry')).json();
 assert.equal(detail.replies[0].current,true);assert.deepEqual(detail.replies[0].stale_inputs,['input.txt']);
 await post('/api/tasks/retry/requeue');
 const requeued=await (await fetch(app.url+'/api/tasks/retry')).json();
 assert.equal(requeued.replies.length,1);assert.equal(requeued.replies[0].current,false);
});
