import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BridgeStore} from '../store.mjs';
import {runGeminiWorker} from '../gemini-runner.mjs';
import {classifyFailure} from '../failures.mjs';

const denial='permission check failed for read_file "C:/fixture/권한-시험.txt": Permission denied for read_file(C:/fixture/권한-시험.txt).\nMatches user-configured deny rule.';
const fixture=fileURLToPath(new URL('./fixtures/fake-general-cli.mjs',import.meta.url));

for(const mode of ['denial-empty','denial-error','denial-exit','denial-text','denial-failed','denial-recovered','empty-reply'])test(`native permission error reporting: ${mode}`,async t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'bridge-permission-error-')),store=new BridgeStore(':memory:');
  t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
  store.sendTask({message_id:mode,task_id:'permission-errors',sender:'codex',recipient:'gemini',goal:'Read the test fixture',cwd});
  await runGeminiWorker(store,{once:true,command:process.execPath,args:[fixture],env:{FAKE_GENERAL_MODE:mode,FAKE_DENIAL_MESSAGE:denial}});
  const row=store.get(mode);
  if(mode==='denial-recovered'){
    assert.equal(row.status,'ready');
  }else if(mode==='empty-reply'){
    assert.equal(row.status_reason,'runner error: gemini returned an empty reply');
  }else{
    assert.equal(row.status,'blocked');
    assert.equal(row.status_reason,'runner error: gemini permission denied: '+denial);
    assert.deepEqual(classifyFailure(row.status,row.status_reason),{kind:'rule',execution:'ran'});
  }
  if(mode!=='empty-reply')assert.deepEqual(store.listRuntime(mode)[0].permission_denials,[denial]);
});
