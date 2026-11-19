import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as sleep} from 'node:timers/promises';
import { BridgeStore, AGENTS } from '../store.mjs';
import { buildClaudeArgs, runClaudeWorker } from '../claude-runner.mjs';

test('every distinct client pair can exchange and acknowledge results', () => {
  assert.ok(AGENTS.includes('gemini'));
  const store = new BridgeStore(':memory:');
  try { for (const sender of AGENTS) for (const recipient of AGENTS) {
    if (sender === recipient) continue;
    const message_id = `${sender}-${recipient}`;
    store.sendTask({ message_id, task_id:'pairs', sender, recipient, cwd:process.cwd(), goal:'reply' });
    const claim=store.claimTask(recipient,'manual:test');
    const reply=store.finishTask(message_id,{claim,outcome:'result',reply:{status:'done',summary:message_id}});
    assert.equal(reply.recipient,sender);
    store.ackReplies(sender,[reply.message_id]);
  }} finally { store.close(); }
});

for(const failedTree of [false,true])test(`general connector cancellation confirms cleanup (tree failure=${failedTree})`,async t=>{
  if(process.platform==='win32'){
    const original=childProcess.spawnSync;
    t.mock.method(childProcess,'spawnSync',(command,args,options)=>{
      if(command!=='taskkill')return original(command,args,options);
      if(failedTree)return {status:1};
      process.kill(Number(args[1]),'SIGKILL');return {status:0};
    });
    syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  }else if(failedTree)return;
  const {runGeminiWorker}=await import('../gemini-runner.mjs');
  const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-cancel-')),log=path.join(dir,'started.jsonl');
  const store=new BridgeStore(':memory:');
  try{
    store.sendTask({message_id:'cancel',task_id:'cancel',sender:'codex',recipient:'gemini',goal:'wait',cwd:dir});
    const running=runGeminiWorker(store,{once:true,command:process.execPath,args:[fileURLToPath(new URL('./fixtures/fake-general-cli.mjs',import.meta.url))],
      cancelPollMs:10,env:{FAKE_GENERAL_MODE:'slow',FAKE_GENERAL_LOG:log}});
    for(let i=0;i<100;i++){try{readFileSync(log);break;}catch{await sleep(10);}}
    store.requestCancel('cancel');await running;
    assert.equal(store.get('cancel').status,failedTree?'blocked':'cancelled');
    if(failedTree)assert.match(store.get('cancel').status_reason,/cleanup failed/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Claude accepts ordinary write tasks and enables ordinary tools without bypassing permissions', () => {
  const store=new BridgeStore(':memory:');
  try {
    const task={message_id:'write',task_id:'write',sender:'codex',recipient:'claude-code',cwd:process.cwd(),goal:'work',sandbox:'workspace-write',write_files:['a.txt']};
    store.sendTask(task);
    const args=buildClaudeArgs(task);
    assert.equal(args[args.indexOf('--tools')+1],'default');
    assert.equal(args[args.indexOf('--permission-mode')+1],'auto');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  } finally {store.close();}
});

test('external workflows change roles without changing bridge code or granting file authority', async () => {
  const {applyWorkflow}=await import('../workflow.mjs');
  const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-workflow-'));
  try {
    const file=path.join(dir,'workflow.json');
    writeFileSync(file,JSON.stringify({roles:{research:{agent:'gemini',instructions:'Classify evidence.'}}}));
    const task=applyWorkflow({goal:'Analyse',sender:'codex',sandbox:'read-only'},file,'research');
    assert.equal(task.recipient,'gemini'); assert.match(task.goal,/Classify evidence/);
    assert.equal(task.sandbox,'read-only');
    assert.throws(()=>applyWorkflow({recipient:'claude-code',goal:'x'},file,'research'),/recipient/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Gemini uses Google auth and structured output without inheriting API credentials', async () => {
  const {buildGeminiArgs,googleAccountEnv}=await import('../gemini-runner.mjs');
  const args=buildGeminiArgs({sandbox:'read-only',write_files:[]});
  assert.equal(args[args.indexOf('--output-format')+1],'stream-json');
  assert.equal(args[args.indexOf('--input-format')+1],'stream-json');
  const settings=JSON.parse(args[args.indexOf('--settings')+1]);
  assert.equal(settings.modelProvider,'');
  assert.ok(settings.permissions.deny.includes('write_file(*)'));
  const env=googleAccountEnv({GEMINI_API_KEY:'secret',GOOGLE_API_KEY:'secret',GOOGLE_GENAI_USE_VERTEXAI:'true',PATH:'ok'});
  assert.equal(env.GEMINI_API_KEY,undefined); assert.equal(env.GOOGLE_API_KEY,undefined);
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI,undefined); assert.equal(env.PATH,'ok');
});


test('gemini counts model requests from finished agent_response steps and drops the count when one has no usage',async()=>{
  const {runGeminiWorker}=await import('../gemini-runner.mjs');
  const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-gemini-calls-')),store=new BridgeStore(':memory:');
  const args=[fileURLToPath(new URL('./fixtures/fake-general-cli.mjs',import.meta.url))];
  try {
    for(const mode of ['steps','steps-unmeasured','pass']) {
      store.sendTask({message_id:mode,task_id:'calls',sender:'codex',recipient:'gemini',goal:'work',cwd:dir,sandbox:'read-only'});
      await runGeminiWorker(store,{once:true,command:process.execPath,args,env:{FAKE_GENERAL_MODE:mode}});
      assert.equal(store.get(mode).status,'ready');
    }
    // The second request's prompt is its uncached input plus the cached part: 2271 + 10424.
    assert.deepEqual(store.listUsage('steps')[0].calls,{model_calls:2,peak_call_input_tokens:12695});
    assert.equal(store.listUsage('steps-unmeasured')[0].calls,null);
    assert.equal(store.listUsage('pass')[0].calls,null);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

for(const recipient of ['claude-code','gemini'])test(`${recipient} runs normal work, preserves questions and rejects malformed replies`,async()=>{
  const {runGeminiWorker}=await import('../gemini-runner.mjs');
  const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-general-'));
  const store=new BridgeStore(':memory:');
  const run=recipient==='gemini'?runGeminiWorker:runClaudeWorker;
  const args=[fileURLToPath(new URL('./fixtures/fake-general-cli.mjs',import.meta.url))];
  try {
    for(const [i,mode] of ['pass','question','malformed','preamble',...(recipient==='gemini'?['native-canceled']:[])].entries()) {
      const message_id='task-'+i;
      store.sendTask({message_id,task_id:'general',sender:'codex',recipient,goal:'work',cwd:dir,sandbox:'read-only'});
      await run(store,{once:true,command:process.execPath,args,env:{FAKE_GENERAL_MODE:mode,GEMINI_API_KEY:'must-not-use'}});
      assert.equal(store.get(message_id).status,['pass','preamble'].includes(mode)?'ready':'blocked');
      if(mode==='question')assert.equal(store.get(message_id).status_reason,'question');
    }
    store.sendTask({message_id:'write',task_id:'general',sender:'codex',recipient,goal:'workspace-write a.txt',cwd:dir,sandbox:'workspace-write',write_files:['a.txt']});
    await run(store,{once:true,allowWrite:true,command:process.execPath,args});
    assert.equal(store.get('write').status,'ready');
    assert.equal(readFileSync(path.join(dir,'a.txt'),'utf8'),'written by fixture');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
