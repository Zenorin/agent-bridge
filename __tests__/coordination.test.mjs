import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,mkdirSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {BridgeStore,snapshotHashes,hashFile} from '../store.mjs';
import {runBridgeWorkers} from '../claude-runner.mjs';
import {fileURLToPath} from 'node:url';
import {fixtureLog} from './fixtures/fixture-log.mjs';
import {inspectContract,wirePacket,verifyWire,receiptFor} from '../contracts.mjs';
import {runAgentTask} from '../runner-core.mjs';

function setup(t){
 const cwd=mkdtempSync(path.join(os.tmpdir(),'bridge-coordinate-')),store=new BridgeStore(':memory:');
 t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
 const task=(id,extra={})=>({message_id:id,task_id:'shared-work',project_id:'project',sender:'claude-code',recipient:'codex',cwd,
  goal:'same business request',acceptance:['verified'],...extra});
 const finish=id=>{const row=store.get(id);return store.finishTask(id,{claim:row,outcome:'result',reply:{status:'done',summary:'shared actual result',
  acceptance:[{criterion:'verified',result:'pass',evidence:'observed once'}],input_hashes:snapshotHashes(row.body),changed_files:{reported:[],observed:[]}}});};
 return {cwd,store,task,finish};
}

test('different IDs and recipients share one in-flight execution and each sender receives and ACKs its result',t=>{
 const {store,task,finish}=setup(t);store.sendTask(task('first'));store.sendTask(task('second',{sender:'codex',recipient:'gemini',model:'another-model'}));
 assert.ok(store.claimTask('codex','runner:first'));assert.equal(store.claimTask('gemini','runner:second'),null);
 assert.match(store.get('second').status_reason,/same work/);finish('first');
 const shared=store.takeReplies('codex').find(r=>r.reply_to==='second');assert.equal(shared.body.status,'done');
 assert.equal(shared.body.summary,'shared actual result');assert.equal(shared.body.coalesced_from.message_id,'first');
 assert.equal(store.listUsage('second')[0].calls.model_calls,0);assert.equal(shared.body.thread_id,null);
 store.ackReplies('codex',[shared.message_id]);assert.equal(store.takeReplies('codex').length,0);
});

test('duplicates arriving during execution are shared without a second worker claiming them',t=>{
 const {store,task,finish}=setup(t);store.sendTask(task('first'));store.claimTask('codex','runner:first');store.sendTask(task('later',{recipient:'gemini',sender:'codex'}));
 finish('first');assert.equal(store.get('later').status,'ready');assert.equal(store.get('later').claimed_by,'coalesced:first');
});

test('auto-generated task IDs do not defeat deduplication when no project scope was explicitly supplied',t=>{
 const {store,task,finish}=setup(t),first=task('first'),second=task('second',{sender:'codex',recipient:'gemini'});
 delete first.project_id;delete second.project_id;first.task_id='auto-task-one';second.task_id='auto-task-two';
 store.sendTask(first);store.sendTask(second);store.claimTask('codex','one');assert.equal(store.claimTask('gemini','two'),null);
 finish('first');assert.equal(store.get('second').status,'ready');assert.equal(store.get('second:attempt:1:result').body.coalesced_from.message_id,'first');
});

test('a completed job does not suppress a later intentional request; repeat:true also permits independent in-flight runs',t=>{
 const {store,task,finish}=setup(t);store.sendTask(task('first'));store.claimTask('codex','one');finish('first');
 store.sendTask(task('after'));assert.equal(store.claimTask('codex','two').message_id,'after');
 store.sendTask(task('repeat',{repeat:true,recipient:'gemini',sender:'codex'}));assert.equal(store.claimTask('gemini','three').message_id,'repeat');
 assert.throws(()=>store.sendTask(task('bad',{repeat:'yes'})),/repeat/);
});

test('different inputs, acceptance, project or independent review/resumed context are not merged',t=>{
 const {store,task,cwd}=setup(t);writeFileSync(path.join(cwd,'input.txt'),'input');
 store.sendTask(task('first'));store.claimTask('codex','one');
 for(const [id,extra] of [['criteria',{acceptance:['other']}],['input',{file_refs:['input.txt']}],['project',{project_id:'other'}],['resume',{thread_id:'11111111-1111-4111-8111-111111111111'}]]){
  store.sendTask(task(id,{...extra,recipient:'gemini',sender:'codex'}));assert.equal(store.claimTask('gemini',id).message_id,id);store.setStatus(id,'cancelled');
 }
 store.sendTask(task('independent',{chain:{review:true}}));assert.equal(store.claimTask('codex','independent').message_id,'independent');
});

test('a failed shared source reports failure without invoking another model, and explicit retry can run again',t=>{
 const {store,task}=setup(t);store.sendTask(task('first'));store.sendTask(task('second',{recipient:'gemini',sender:'codex'}));store.claimTask('codex','one');
 store.setStatus('first','blocked','runner error: native permission denied');assert.equal(store.claimTask('gemini','two'),null);
 const reply=store.takeReplies('codex').find(r=>r.reply_to==='second');assert.equal(reply.body.status,'failed');assert.match(reply.body.summary,/native permission denied/);
 store.requeue('second');assert.equal(store.claimTask('gemini','retry').message_id,'second');
});

test('different tasks or pages in the same browser space serialize even with no overlapping files',t=>{
 const {store,task,finish}=setup(t);store.sendTask(task('first',{browser_context:{space_id:12,page:'p1'}}));
 store.sendTask(task('second',{goal:'different work',repeat:true,recipient:'gemini',sender:'codex',browser_context:{space_id:12,page:'p2'}}));
 store.claimTask('codex','one');assert.equal(store.claimTask('gemini','two'),null);assert.match(store.get('second').status_reason,/browser space/);
 finish('first');assert.equal(store.claimTask('gemini','two').message_id,'second');
});

test('different browser spaces can run concurrently and inherited browser references lock before dispatch',t=>{
 const {store,task,finish}=setup(t);store.sendTask(task('parent',{browser_context:{space_id:12,page:'p1'}}));store.claimTask('codex','parent');finish('parent');
 const parentReply=store.get('parent:attempt:1:result');parentReply.body.browser_context={space_id:12,page:'p1'};
 store.db.prepare('UPDATE messages SET body=? WHERE message_id=?').run(JSON.stringify(parentReply.body),parentReply.message_id);
 store.sendTask(task('inherited',{goal:'inherited work',handoff_from:['parent']}));store.claimTask('codex','one');
 store.sendTask(task('same-space',{goal:'other work',recipient:'gemini',sender:'codex',browser_context:{space_id:12,page:'p1'}}));assert.equal(store.claimTask('gemini','two'),null);
 store.sendTask(task('other-space',{goal:'other work',recipient:'gemini',sender:'codex',browser_context:{space_id:13,page:'p1'}}));assert.equal(store.claimTask('gemini','three').message_id,'other-space');
});

test('unconfirmed cleanup keeps both duplicate work and browser space locked',t=>{
 const {store,task}=setup(t);store.sendTask(task('first',{browser_context:{space_id:12,page:'p1'}}));store.claimTask('codex','one');
 store.setStatus('first','blocked','runner cleanup failed: native process still running');
 store.sendTask(task('second',{goal:'other',recipient:'gemini',sender:'codex',browser_context:{space_id:12,page:'p2'}}));assert.equal(store.claimTask('gemini','two'),null);
 store.confirmStopped('first',1);assert.equal(store.claimTask('gemini','two').message_id,'second');
});

test('native worker dispatch executes only the leader and returns a zero-call shared result to the other agent',async t=>{
 const {store,task}=setup(t),codexLog=fixtureLog(t,'leader.jsonl'),geminiLog=fixtureLog(t,'follower.jsonl');
 store.sendTask(task('first',{acceptance:[]}));store.sendTask(task('second',{acceptance:[],sender:'codex',recipient:'gemini'}));
 await runBridgeWorkers(store,{once:true,agents:['codex','gemini'],
  codex:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/fake-app-server.mjs',import.meta.url))],env:{FAKE_LOG:codexLog}},
  gemini:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/fake-general-cli.mjs',import.meta.url))],env:{FAKE_GENERAL_LOG:geminiLog}}});
 assert.equal(store.get('first').status,'ready');assert.equal(store.get('second').status,'ready');assert.equal(existsSync(geminiLog),false);
 assert.equal(store.listUsage('first')[0].calls.model_calls,1);assert.equal(store.listUsage('second')[0].calls.model_calls,0);
 assert.equal(store.get('second:attempt:1:result').body.delivery.coalesced_from.message_id,'first');
});

test('shared contract results retain verified requirements and source/environment hashes',t=>{
 const {store,task,cwd}=setup(t),file=path.join(cwd,'contract.json');
 writeFileSync(file,JSON.stringify({id:'contract',version:'1',objective:'same business request',requirements:[{id:'R1',text:'verified'}],review:{criteria:[{id:'Q1',text:'verified',method:'automated'}]}}));
 for(const id of ['first','second'])store.sendTask(task(id,{contract:file,contract_review_ids:['Q1'],...(id==='second'?{sender:'codex',recipient:'gemini'}:{})}));
 const claim=store.claimTask('codex','leader'),bound=claim.body,environment=inspectContract(bound),packet={...bound,contract_environment:environment};
 store.bindContractEnvironment(bound,environment);store.saveRuntime('first',{contract_environment:environment,contract_delivery:verifyWire(packet,wirePacket(packet))},claim);
 const acceptance=[{criterion:'verified',result:'pass',evidence:'source observation'}];
 store.finishTask('first',{claim,outcome:'result',reply:{status:'done',summary:'verified once',acceptance,contract_receipt:receiptFor(bound,environment,acceptance),changed_files:{reported:[],observed:[]}}});
 assert.equal(store.get('second').status,'ready',store.get('second').status_reason);
 assert.deepEqual(store.get('second:attempt:1:result').body.contract_receipt.requirement_ids,['R1']);
 assert.equal(store.listRuntime('second')[0].contract_delivery.verified,true);
});

test('browser locks survive reopening until exact-attempt cleanup is confirmed',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'bridge-browser-lock-')),db=path.join(root,'queue.db');let store=new BridgeStore(db);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const task=(id,goal)=>({message_id:id,task_id:'lock',sender:'claude-code',recipient:'codex',cwd:root,goal,browser_context:{space_id:12,page:'p1'}});
 store.sendTask(task('first','first'));store.claimTask('codex','first');store.setStatus('first','blocked','runner cleanup failed: process still running');store.close();store=new BridgeStore(db);
 store.sendTask(task('second','second'));assert.equal(store.claimTask('codex','second'),null);
 assert.throws(()=>store.confirmStopped('first',99),/attempt/);store.confirmStopped('first',1);assert.equal(store.claimTask('codex','second').message_id,'second');
});

test('changed inherited browser references block before a connector can execute',async t=>{
 const {store,task,finish}=setup(t);store.sendTask(task('parent'));store.claimTask('codex','parent');finish('parent');
 const reply=store.get('parent:attempt:1:result');reply.body.browser_context={space_id:12,page:'p1'};
 const update=()=>store.db.prepare('UPDATE messages SET body=? WHERE message_id=?').run(JSON.stringify(reply.body),reply.message_id);update();
 store.sendTask(task('child',{goal:'child',handoff_from:['parent']}));const claim=store.claimTask('codex','child');assert.equal(claim.browser_space_id,12);
 reply.body.browser_context.space_id=13;update();let executed=false;
 await runAgentTask(store,claim,{async execute(){executed=true;},async close(){}});
 assert.equal(executed,false);assert.match(store.get('child').status_reason,/browser context changed before execution/);
});

test('repeat:true forces a fresh execution even when pure-result reuse was also requested',async t=>{
 const {store,task}=setup(t);let calls=0;
 const connector={async execute(){calls++;return {};},parse(){return {outcome:'result',reply:{status:'done',summary:'fresh',
  acceptance:[{criterion:'verified',result:'pass',evidence:'this execution'}],changed_files:{reported:[],observed:[]}}};},async close(){}};
 for(const id of ['first','second']){
  store.sendTask(task(id,{repeat:true,reuse:{pure:true,version:'1'}}));const claim=store.claimTask('codex',id);await runAgentTask(store,claim,connector);
 }
 assert.equal(calls,2);
});

test('shared results retain the receiving request input paths when junction aliases name the same file',t=>{
 const {store,task,cwd,finish}=setup(t);mkdirSync(path.join(cwd,'actual'));writeFileSync(path.join(cwd,'actual/input.txt'),'data');
 symlinkSync(path.join(cwd,'actual'),path.join(cwd,'alias'),process.platform==='win32'?'junction':'dir');
 store.sendTask(task('first',{file_refs:['actual/input.txt']}));store.sendTask(task('second',{file_refs:['alias/input.txt'],sender:'codex',recipient:'gemini'}));
 store.claimTask('codex','first');finish('first');const reply=store.get('second:attempt:1:result');
 assert.equal(reply.body.input_hashes['alias/input.txt'],hashFile(cwd,'alias/input.txt'));
});
