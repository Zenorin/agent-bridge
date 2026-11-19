import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BridgeStore,normaliseTask} from '../store.mjs';
import {runAgentTask} from '../runner-core.mjs';
import {main} from '../cli.mjs';
import {buildGeminiArgs} from '../gemini-runner.mjs';
import {artifactScopes} from '../artifact-runtime.mjs';
import {fixtureLog} from './fixtures/fixture-log.mjs';

const task = (cwd, extra={}) => ({message_id:'browser',task_id:'browser',sender:'claude-code',recipient:'codex',goal:'Read a public browser page',cwd,...extra});

test('Codex full access is explicit without changing any client default',()=>{
  assert.equal(normaliseTask(task(process.cwd())).sandbox,'read-only');
  assert.equal(normaliseTask(task(process.cwd(),{sandbox:'danger-full-access'})).sandbox,'danger-full-access');
  for (const recipient of ['gemini','claude-code']) assert.throws(()=>normaliseTask(task(process.cwd(),{sender:'codex',recipient,sandbox:'danger-full-access'})),/Codex/);
});

test('full access still requires the existing runner write authorization',async t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'bridge-browser-')),store=new BridgeStore(':memory:');
  t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
  let executed=false;
  store.sendTask(task(cwd,{sandbox:'danger-full-access'}));
  const claim=store.claimTask('codex','test');
  await runAgentTask(store,claim,{async execute(){executed=true;},async close(){} });
  assert.equal(executed,false);
  assert.match(store.get('browser').status_reason,/allow-write/);
  store.requeue('browser');
  await runAgentTask(store,store.claimTask('codex','test-full'),{async execute(){executed=true;},async close(){} },{allowWrite:true});
  assert.equal(executed,false);
  assert.match(store.get('browser').status_reason,/allow-full-access/);
});

test('Codex receives the requested full access mode on its actual thread start',async t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'bridge-browser-codex-')),db=path.join(cwd,'queue.db'),store=new BridgeStore(db),log=fixtureLog(t,'browser-requests.jsonl');
  t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
  store.sendTask(task(cwd,{sandbox:'danger-full-access'}));
  assert.equal(await main(['run-codex','--once','--allow-write','--allow-full-access','--db',db],{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/fake-app-server.mjs',import.meta.url))],env:{FAKE_LOG:log}}),0);
  assert.equal(store.get('browser').status,'ready');
  const requests=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.find(r=>r.method==='thread/start').params.sandbox,'danger-full-access');
});

test('Gemini retains its sandbox and native permission checks',()=>{
  const write=buildGeminiArgs({sandbox:'workspace-write',write_files:[]});
  assert.equal(write[write.indexOf('--mode')+1],'auto');
  assert.ok(write.includes('--sandbox'));
  assert.ok(!write.includes('--dangerously-skip-permissions'));
  const read=buildGeminiArgs({sandbox:'read-only',write_files:[]});
  assert.ok(JSON.parse(read[read.indexOf('--settings')+1]).permissions.deny.includes('command(*)'));
});

test('full access retains the same task-scoped Artifact Writer protection as workspace writes',()=>{
  const scoped={cwd:process.cwd(),write_files:['browser-result.json']};
  const full=artifactScopes({...scoped,sandbox:'danger-full-access'},true);
  assert.equal(full.length,1);
  assert.deepEqual(full,artifactScopes({...scoped,sandbox:'workspace-write'},true));
  assert.deepEqual(artifactScopes({...scoped,sandbox:'danger-full-access'},false),[]);
});
