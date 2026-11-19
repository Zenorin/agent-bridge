import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {BridgeStore,snapshotHashes} from '../store.mjs';
import {runAgentTask} from '../runner-core.mjs';
import {runClaudeWorker} from '../claude-runner.mjs';
import {RESULT_SCHEMA} from '../codex-runner.mjs';
import {AppServerClient} from '../codex-runner.mjs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixtureLog} from './fixtures/fixture-log.mjs';

function setup(t){
 const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-safety-')),db=path.join(dir,'queue.db'),s=new BridgeStore(db);
 const task=(message_id,extra={})=>({message_id,task_id:'safe',sender:'codex',recipient:'gemini',cwd:dir,goal:'unchanged goal',...extra});
 t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return {dir,db,s,task};
}
test('one resumed session runs one task at a time, including tasks with no writes',t=>{
 const {s,task}=setup(t);
 s.sendTask(task('a',{thread_id:'session'}));s.sendTask(task('b',{thread_id:'session'}));
 const first=s.claimTask('gemini','one');assert.equal(s.claimTask('gemini','two'),null);
 s.finishTask('a',{claim:first,outcome:'result',reply:{status:'done'}});
 assert.equal(s.claimTask('gemini','two').message_id,'b');
});
test('readers share inputs but writers wait for readers and readers wait for writers',t=>{
 const {s,task}=setup(t);
 s.sendTask(task('reader1',{file_refs:[{path:'a.txt'}]}));s.sendTask(task('reader2',{repeat:true,file_refs:[{path:'a.txt'}]}));
 const one=s.claimTask('gemini','reader1'),two=s.claimTask('gemini','reader2');assert.ok(one&&two);
 s.sendTask(task('writer',{sender:'gemini',recipient:'claude-code',sandbox:'workspace-write',write_files:['a.txt']}));
 assert.equal(s.claimTask('claude-code','writer'),null);
 for(const claim of [one,two])s.finishTask(claim.message_id,{claim,outcome:'result',reply:{status:'done'}});
 assert.equal(s.claimTask('claude-code','writer').message_id,'writer');
 s.sendTask(task('reader3',{file_refs:[{path:'a.txt'}]}));assert.equal(s.claimTask('gemini','reader3'),null);
});
test('external input changes during a run block the result and record both versions',async t=>{
 const {s,task,dir}=setup(t);writeFileSync(path.join(dir,'input.txt'),'before');
 s.sendTask(task('read',{file_refs:[{path:'input.txt'}]}));const claim=s.claimTask('gemini','reader');
 const connector={async execute(){writeFileSync(path.join(dir,'input.txt'),'after');return {};},parse(){return {outcome:'result',reply:{status:'done',cwd:dir,input_hashes:snapshotHashes(claim.body)}};},async close(){}};
 await runAgentTask(s,claim,connector);
 assert.equal(s.get('read').status,'blocked');assert.match(s.get('read').status_reason,/input changed/);
 assert.equal(s.takeReplies('codex').length,0);
 const versions=s.listRuntime('read')[0].input_versions;assert.notEqual(versions.before['input.txt'],versions.after['input.txt']);
});
test('directory input detects external changes while allowing its own declared output writes',async t=>{
 const {s,task,dir}=setup(t);mkdirSync(path.join(dir,'src'));writeFileSync(path.join(dir,'src','input.txt'),'before');
 for(const ref of ['src','.'])for(const external of [false,true]){
  const id='directory-'+ref+'-'+external,output=`src/${ref==='.'?'root':'nested'}-${external}/output.txt`;
  s.sendTask(task(id,{file_refs:[{path:ref,hash:'fixture'}],sandbox:'workspace-write',write_files:[output]}));const claim=s.claimTask('gemini',id);
  const connector={async execute(){mkdirSync(path.dirname(path.join(dir,output)),{recursive:true});writeFileSync(path.join(dir,output),'owned output');if(external)writeFileSync(path.join(dir,'src','input.txt'),id);return {};},parse(){return {outcome:'result',reply:{status:'done',cwd:dir}};},async close(){}};
  await runAgentTask(s,claim,connector,{allowWrite:true});assert.equal(s.get(id).status,external?'blocked':'ready');
 }
});
test('unconfirmed process cleanup retains scopes across reopen until this attempt is confirmed stopped',t=>{
 const {s,task,db}=setup(t);
 s.sendTask(task('a',{sandbox:'workspace-write',write_files:['a.txt'],thread_id:'session'}));const claim=s.claimTask('gemini','writer');
 s.setStatus('a','blocked','runner cleanup failed: exit was not confirmed',claim);
 s.sendTask(task('b',{sandbox:'workspace-write',write_files:['a.txt']}));
 const second=new BridgeStore(db);try{
  assert.equal(second.claimTask('gemini','next'),null);assert.throws(()=>second.requeue('a'),/stop|cleanup/i);
  assert.throws(()=>second.confirmStopped('a',claim.attempt+1),/attempt/);
  second.confirmStopped('a',claim.attempt);assert.equal(second.claimTask('gemini','next').message_id,'b');
 }finally{second.close();}
});
test('a reply creates one follow-up per step atomically with ACK; retries survive restart',t=>{
 const {s,task,db}=setup(t);s.sendTask(task('source'));const claim=s.claimTask('gemini','worker');
 const reply=s.finishTask('source',{claim,outcome:'result',reply:{status:'done'}});
 const next=task('follow1',{reply_to:reply.message_id,goal:'execute next'});
 s.sendTask(next);assert.equal(s.takeReplies('codex').length,0);
 const reopened=new BridgeStore(db);try{
  const retry=reopened.sendTask({...next,message_id:'follow2'});assert.equal(retry.duplicate,true);assert.equal(retry.message.message_id,'follow1');
  assert.throws(()=>reopened.sendTask({...next,message_id:'different',goal:'different work'}),/follow.up.*content/i);
  assert.throws(()=>reopened.sendTask({...next,message_id:'wrong-route',recipient:'claude-code'}),/follow.up.*content/i);
  reopened.sendTask({...next,message_id:'named-step',followup_key:'another-step',goal:'intentionally different'});
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM messages WHERE kind='task' AND reply_to=?").get(reply.message_id).n,2);
 }finally{reopened.close();}
});

test('a conflicting message ID cannot masquerade as a saved follow-up',t=>{
 const {s,task}=setup(t);s.sendTask(task('source'));const claim=s.claimTask('gemini','one');
 const reply=s.finishTask('source',{claim,outcome:'result',reply:{status:'done'}});
 s.sendTask(task('collision',{goal:'unrelated'}));
 assert.throws(()=>s.sendTask(task('collision',{reply_to:reply.message_id,goal:'next work'})),/different content/);
 assert.equal(s.takeReplies('codex').length,1);
});

test('chain review reset waits for exact-attempt cleanup confirmation',t=>{
 const {s,dir}=setup(t);
 s.sendTask({message_id:'root',task_id:'chain',sender:'claude-code',recipient:'codex',cwd:dir,goal:'read',chain:{review:true}});
 const first=s.claimTask('codex','implement1');s.finishTask('root',{claim:first,outcome:'result',reply:{status:'done'}});
 const review=s.claimTask('claude-code','review1');s.setTurn(review.message_id,'session','turn',review);
 s.setStatus(review.message_id,'blocked','runner cleanup failed: unconfirmed',review);
 s.setStatus('root','blocked','retry');s.requeue('root');
 const second=s.claimTask('codex','implement2');assert.ok(second);
 s.finishTask('root',{claim:second,outcome:'result',reply:{status:'done'}});
 assert.equal(s.claimTask('claude-code','review2'),null);
 assert.equal(s.get(review.message_id).attempt,1);
 s.confirmStopped(review.message_id,review.attempt);
 const next=s.claimTask('claude-code','review2');assert.ok(next);assert.equal(next.attempt,2);
});

for(const failedTree of [false,true])test(`Codex close confirms exit and reports tree failure=${failedTree}`,async t=>{
 if(process.platform!=='win32'&&failedTree)return;
 if(process.platform==='win32'){
  const original=childProcess.spawnSync;
  t.mock.method(childProcess,'spawnSync',(command,args,options)=>{
   if(command!=='taskkill')return original(command,args,options);
   if(failedTree)return {status:1};process.kill(Number(args[1]),'SIGKILL');return {status:0};
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 }
 const client=AppServerClient.start({command:process.execPath,args:['-e','process.stdin.resume();setInterval(()=>{},1000)']});
 if(failedTree)await assert.rejects(()=>client.close(),/tree termination failed/);else await client.close();
 assert.notEqual(client.exitCode,undefined);
});
test('compact prompt preserves every goal/condition and keeps the schema in the native option only',async t=>{
 const {s,task,dir}=setup(t),log=fixtureLog(t,'calls.jsonl');
 const goal='Keep all facts: SKU A-17; 0.35 kg; do not publish.\nCondition: preserve original text.';
 const acceptance=['no publication','keep 0.35 kg exactly'];
 s.sendTask(task('prompt',{recipient:'claude-code',goal,acceptance}));
 await runClaudeWorker(s,{once:true,command:process.execPath,args:[fileURLToPath(new URL('./fixtures/fake-general-cli.mjs',import.meta.url))],env:{FAKE_GENERAL_LOG:log}});
 const call=JSON.parse(readFileSync(log,'utf8'));
 assert.ok(call.input.includes(goal));for(const condition of acceptance)assert.ok(call.input.includes(condition));
 assert.equal(call.input.includes(JSON.stringify(RESULT_SCHEMA)),false);
 assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--json-schema')+1]),RESULT_SCHEMA);
});
