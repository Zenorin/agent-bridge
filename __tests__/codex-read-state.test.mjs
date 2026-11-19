import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {BridgeStore} from '../store.mjs';
import {runCodexWorker} from '../codex-runner.mjs';
import {fixtureLog} from './fixtures/fixture-log.mjs';

const fake=fileURLToPath(new URL('./fixtures/fake-app-server.mjs',import.meta.url));
async function run(t,env={},task={}) {
  const cwd=mkdtempSync(path.join(os.tmpdir(),'bridge-read-state-'));
  const log=fixtureLog(t),store=new BridgeStore(path.join(cwd,'bridge.db'));
  t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
  store.sendTask({message_id:'read-test',task_id:'read-test',sender:'claude-code',recipient:'codex',cwd,goal:'small check',acceptance:['test passes'],...task});
  await runCodexWorker(store,{once:true,command:process.execPath,args:[fake],env:{FAKE_LOG:log,...(typeof env==='function'?env(cwd):env)}});
  const requests=existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  return {requests,row:store.get('read-test'),receipt:store.listRuntime('read-test').at(-1)};
}

test('successful Bridge-owned work marks only the observed revision read after saving its result',async t=>{
  const {requests,row,receipt}=await run(t);
  assert.equal(row.status,'ready');
  assert.deepEqual(requests.find(r=>r.method==='thread/readState/update')?.params,
    {threadId:'thr-new',operation:{type:'read'},expectedRevision:'seen-revision'});
  assert.equal(receipt.read_state.status,'read');
  assert.equal(requests.filter(r=>r.method==='turn/start').length,1);
});
test('successful resumed Bridge-owned history remains usable',async t=>{
  const {requests}=await run(t,{}, {thread_id:'bridge-history'});
  assert.equal(requests.find(r=>r.method==='thread/readState/update')?.params.threadId,'bridge-history');
  assert.ok(requests.some(r=>r.method==='thread/resume'));
});
for(const mode of ['question','failed','plain'])test(`${mode} keeps user attention visible`,async t=>{
  const {requests}=await run(t,{FAKE_MODE:mode});
  assert.equal(requests.some(r=>r.method==='thread/readState/update'),false);
});
test('a normal resumed conversation is never marked read',async t=>{
  const {requests,receipt}=await run(t,{FAKE_ORIGINATOR:'codex-desktop'},{thread_id:'user-history'});
  assert.equal(requests.some(r=>r.method==='thread/readState/update'),false);
  assert.equal(receipt.read_state.status,'foreign');
});
test('newer user activity is not cleared by an older Bridge completion',async t=>{
  const {requests,receipt}=await run(t,{FAKE_LATEST_TURN:'user-next-turn'});
  assert.equal(requests.some(r=>r.method==='thread/readState/update'),false);
  assert.equal(receipt.read_state.status,'attention');
});
test('post-execution scope validation failure is not marked read',async t=>{
  const {requests,row}=await run(t,cwd=>({FAKE_WRITE:path.join(cwd,'outside.txt')}));
  assert.equal(row.status,'blocked');
  assert.equal(requests.some(r=>r.method==='thread/readState/update'),false);
});
for(const env of [{FAKE_NO_READ_STATE:'1'},{FAKE_READ_ERROR:'revision conflict'},{FAKE_READ_ERROR:'unknown thread/readState/update'}])
  test(`unavailable or stale read state preserves the successful result: ${JSON.stringify(env)}`,async t=>{
    const {row,receipt,requests}=await run(t,env);
    assert.equal(row.status,'ready');
    assert.equal(receipt.read_state.status,'unavailable');
    assert.ok(requests.filter(r=>r.method==='thread/readState/update').length<=1);
  });
