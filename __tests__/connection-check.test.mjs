import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {checkConnections} from '../connection-check.mjs';

const fixture=fileURLToPath(new URL('./fixtures/fake-connection-cli.mjs',import.meta.url));
const found={agents:['codex','gemini','claude-code'],clients:{codex:{installed:true},gemini:{installed:true,model:'gemini-4-argon-medium'},'claude-code':{installed:true}},workers:{codex:{command:process.execPath,args:[fixture,'app-server']},gemini:{command:process.execPath,args:[fixture]},claude:{command:'MUST_NOT_RUN'}}};
function setup(t,mode){const root=mkdtempSync(path.join(os.tmpdir(),'bridge-connection-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,log:path.join(root,'calls.jsonl'),env:{...process.env,CONNECTION_FIXTURE_MODE:mode,CONNECTION_FIXTURE_LOG:path.join(root,'calls.jsonl'),GEMINI_API_KEY:'test-secret'}};}
test('one local auth check and one tiny probe per provider; Claude, API key and project context stay out',async t=>{
 const {env,log}=setup(t,'pass');const result=await checkConnections(found,{env});
 assert.equal(result.ok,true);assert.equal(result.agents.codex.authentication,'verified');assert.equal(result.agents.gemini.authentication,'verified');
 assert.equal(result.agents.codex.usage.turn.cachedInputTokens,40);assert.equal(result.agents.gemini.usage.turn.inputTokens,70);
 const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,3);
 assert.equal(calls.filter(c=>c.login).length,1);assert.equal(calls.filter(c=>!c.login).length,2);
 assert.ok(calls.filter(c=>!c.login).every(c=>c.cwd.includes('bridge-connection-')));
 assert.equal(calls.find(c=>c.agent==='gemini'&&!c.login).hasGeminiKey,false);
 assert.ok(!calls.find(c=>c.agent==='gemini'&&!c.login).args.includes('--effort'));
 assert.doesNotMatch(JSON.stringify(result),/private-value|private-secret|test-secret/);
});
test('missing CLIs are reported without any subprocess or model call',async()=>{
 const result=await checkConnections({agents:[],clients:{},workers:{}});
 assert.equal(result.ok,false);for(const r of Object.values(result.agents)){assert.equal(r.call,'skipped');assert.equal(r.reason,'not_installed');assert.equal(r.probe_invocations,0);}
});
test('a busy temporary directory never discards completed check results',async t=>{
 const original=fs.rmSync;let owned;
 t.mock.method(fs,'rmSync',dir=>{owned=dir;throw Object.assign(new Error('busy'),{code:'EBUSY'});});syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();if(owned&&path.dirname(owned)===path.resolve(os.tmpdir()))original(owned,{recursive:true,force:true});});
 const result=await checkConnections({agents:[],clients:{},workers:{}});
 assert.equal(result.agents.codex.reason,'not_installed');assert.deepEqual(result.temporary_cleanup,{status:'retained',reason:'EBUSY'});
});
test('Codex logged out skips its paid probe while Gemini is still checked',async t=>{
 const {env,log}=setup(t,'logged-out');const result=await checkConnections(found,{env});
 assert.equal(result.agents.codex.authentication,'missing');assert.equal(result.agents.codex.probe_invocations,0);
 assert.equal(result.agents.gemini.call,'passed');assert.equal(readFileSync(log,'utf8').trim().split('\n').length,2);
});
for(const mode of ['wrong','auth-failed','quota','model-conflict','tool','timeout'])test(`real-call failure stays distinct and is never retried: ${mode}`,async t=>{
 const {env,log}=setup(t,mode);const only={...found,agents:['gemini'],clients:{gemini:{installed:true}}};
 const result=await checkConnections(only,{env,timeoutMs:mode==='timeout'?400:2000});
 assert.equal(result.ok,false);assert.equal(result.agents.gemini.call,'failed');
 assert.equal(result.agents.gemini.reason,{'wrong':'unexpected_reply','auth-failed':'authentication','quota':'quota','model-conflict':'configuration','tool':'tool_attempt','timeout':'timeout'}[mode]);
 assert.equal(result.agents.gemini.probe_invocations,1);
 assert.equal(readFileSync(log,'utf8').trim().split('\n').length,1);
 assert.doesNotMatch(JSON.stringify(result),/private-secret|person@example/);
});
