import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BridgeStore} from '../store.mjs';
import {runAgentTask,runAgentWorker} from '../runner-core.mjs';
import {buildPrompt,runCodexTask} from '../codex-runner.mjs';
import {main} from '../cli.mjs';
import {GEMINI_TEST_AUTH} from './fixtures/gemini-auth.mjs';

function fixture(t){const cwd=mkdtempSync(path.join(os.tmpdir(),'bridge-efficiency-'));const store=new BridgeStore(':memory:');
 t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
 const task=(id,extra={})=>({message_id:id,task_id:'work',project_id:'project',sender:'codex',recipient:'gemini',cwd,goal:'Keep SKU A-17; 0.35 kg; no publication.',acceptance:['keep 0.35 kg exactly','do not publish'],...extra});
 return {cwd,store,task};}

test('Ego tasks receive compact-output advice without dropping their contract or changing other tasks',()=>{
 const task={goal:'Use ego-browser to verify the page',acceptance:['preserve the exact denial'],file_refs:[],write_files:[],task_id:'ego',message_id:'one'};
 const prompt=buildPrompt(task);
 assert.match(prompt,/Prefer batching independent reads/);
 assert.match(prompt,/required Ego guide/);
 assert.match(prompt,/permission errors/);
 assert.match(prompt,/preserve the exact denial/);
 assert.doesNotMatch(buildPrompt({...task,goal:'Review a source file'}),/Prefer batching independent reads/);
 assert.match(buildPrompt({...task,goal:'Verify browser',file_refs:[{path:'skills/ego-browser/SKILL.md'}]}),/Prefer batching independent reads/);
});

test('Claude and Gemini receive the same Ego efficiency advice through their real connector paths',async t=>{
 const {fileURLToPath}=await import('node:url');
 const {runClaudeWorker}=await import('../claude-runner.mjs'),{runGeminiWorker}=await import('../gemini-runner.mjs');
 const {store,task}=fixture(t),logs=mkdtempSync(path.join(os.tmpdir(),'bridge-ego-prompt-')),log=path.join(logs,'calls.jsonl');
 t.after(()=>rmSync(logs,{recursive:true,force:true}));
 const script=fileURLToPath(new URL('./fixtures/fake-general-cli.mjs',import.meta.url));
 for(const [recipient,run] of [['claude-code',runClaudeWorker],['gemini',runGeminiWorker]]){
  store.sendTask(task(recipient,{recipient,goal:'Verify ego-browser output',acceptance:[]}));
  await run(store,{once:true,geminiAuth:GEMINI_TEST_AUTH,command:process.execPath,args:[script],env:{FAKE_GENERAL_LOG:log}});
  assert.equal(store.get(recipient).status,'ready',store.get(recipient).status_reason);
 }
 const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(calls.length,2);
 for(const call of calls)assert.match(call.input,/Prefer batching independent reads/);
});

test('usage counts model calls per attempt and leaves unreported counts out of the total',async()=>{
 const {callTracker,claudeCallInput,aggregateUsage,zeroUsage}=await import('../usage.mjs');
 const calls=callTracker();calls.record('msg-a',100);calls.record('msg-a',140);calls.record('msg-b',90);
 assert.deepEqual(calls.summary(),{model_calls:2,peak_call_input_tokens:140});assert.equal(callTracker().summary(),null);
 assert.equal(claudeCallInput({input_tokens:3,cache_read_input_tokens:40,cache_creation_input_tokens:7,output_tokens:9}),50);
 const report=aggregateUsage([{recipient:'codex',usage:{turn:{},calls:{model_calls:74,peak_call_input_tokens:150000}}},
  {recipient:'program',usage:zeroUsage('program')},{recipient:'gemini',usage:{turn:{},calls:null}}]);
 assert.deepEqual(report.calls,{model_calls:{known:74,measured:2,missing:1,total:null},peak_call_input_tokens:150000});
});

test('usage separates cached subsets, unknowns and project attempts without summing snapshots',async t=>{
 const {normalizeUsage}=await import('../usage.mjs');
 const openai=normalizeUsage('codex',{inputTokens:100,cachedInputTokens:60,outputTokens:20});
 assert.equal(openai.turn.totalTokens,120);assert.equal(openai.turn.cacheWriteInputTokens,null);
 const claude=normalizeUsage('claude-code',{input_tokens:100,cache_read_input_tokens:60,cache_creation_input_tokens:10,output_tokens:20});
 assert.equal(claude.turn.totalTokens,190);
 assert.equal(normalizeUsage('claude-code',{input_tokens:100,output_tokens:20}).turn.totalTokens,null);
 const {store,task}=fixture(t);store.sendTask(task('one'));const claim=store.claimTask('gemini','test');
 for(let i=0;i<3;i++)store.saveUsage('one',{...openai,thread_total:{totalTokens:99999}},claim);
 store.setStatus('one','blocked','retry',claim);store.requeue('one');const next=store.claimTask('gemini','test');store.saveUsage('one',claude,next);
 store.sendTask(task('other',{project_id:'other'}));
 const report=store.projectUsage('project');assert.equal(report.attempts,2);assert.equal(report.tokens.totalTokens.known,310);
 assert.equal(report.coverage,'bridge-attempts-only');assert.equal(report.unmetered_external_usage,true);
});

test('registered program executes via shared lifecycle and preserves the entire task contract',async t=>{
 const {cwd,store,task}=fixture(t);const script=path.join(cwd,'check.mjs'),profiles=path.join(cwd,'profiles.json');
 writeFileSync(script,`let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const t=JSON.parse(s);console.log(JSON.stringify({status:'done',summary:t.goal,question:null,acceptance:t.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fixture program'})),changed_files:[]}));});`);
 writeFileSync(profiles,JSON.stringify({required_plugins:[],profiles:{standard:{plugins:[],input_fields:[],output_fields:['summary'],adapters:['check']}},adapters:{check:{command:process.execPath,args:[script],input_fields:[],output_fields:[]}}}));
 store.sendTask(task('program',{execution:{adapter:'check'}}));let models=0;
 await runAgentWorker(store,{recipient:'gemini',once:true,profilesPath:profiles,createConnector(){models++;throw new Error('model must not start');}});
 assert.equal(models,0);assert.equal(store.get('program').status,'ready');
 const reply=store.takeReplies('codex')[0];assert.equal(reply.body.summary,task('').goal);assert.deepEqual(reply.body.acceptance.map(c=>c.criterion),task('').acceptance);
 assert.equal(store.listUsage('program')[0].turn.totalTokens,0);
});

test('context excerpts are exact and retain the full original plus every condition',async t=>{
 const {prepareContext}=await import('../context.mjs');const {cwd,store,task}=fixture(t);
 writeFileSync(path.join(cwd,'source.txt'),'ORIGINAL FIRST\nlocked 0.35 kg\nLAST\n');
 const envelope=task('context',{context_refs:[{path:'source.txt',lines:'2-2'}]});store.sendTask(envelope);const claim=store.claimTask('gemini','test');
 const prepared=prepareContext(store,claim.body);const prompt=buildPrompt({...prepared,task_id:'work',message_id:'context'});
 assert.ok(prompt.includes(envelope.goal));for(const c of envelope.acceptance)assert.ok(prompt.includes(c));
 assert.ok(prompt.includes('locked 0.35 kg'));assert.ok(prompt.includes('source.txt'));assert.equal(readFileSync(path.join(cwd,'source.txt'),'utf8'),'ORIGINAL FIRST\nlocked 0.35 kg\nLAST\n');
 assert.equal(prepared.file_refs[0].path,'source.txt');
 await assert.rejects(async()=>prepareContext(store,{...claim.body,context_refs:[{path:'source.txt',lines:'2-99'}]}),/range|lines/i);
});

test('external role plans retain conditions and wait for predecessor completion',async t=>{
 const {compilePlan,sendPlan}=await import('../workflow.mjs');const {cwd,store}=fixture(t),roles=path.join(cwd,'roles.json');
 writeFileSync(roles,JSON.stringify({roles:{inspect:{agent:'gemini',instructions:'Keep source evidence.'}}}));
 const plan={project_id:'flow',cwd,sender:'codex',steps:[{id:'second',workflow_role:'inspect',goal:'verify',acceptance:['required visual review'],depends_on:['first']},{id:'first',workflow_role:'inspect',goal:'read',acceptance:['exact source']}]};
 const compiled=compilePlan(plan,{workflowFile:roles});sendPlan(store,compiled);
 const first=store.claimTask('gemini','first');assert.equal(first.message_id,'flow:first');assert.equal(store.claimTask('gemini','second'),null);
 store.finishTask(first.message_id,{claim:first,outcome:'result',reply:{status:'done',summary:'checked',acceptance:[{criterion:'exact source',result:'pass',evidence:'fixture'}]}});
 const second=store.claimTask('gemini','second');assert.equal(second.message_id,'flow:second');assert.deepEqual(second.body.acceptance,['required visual review']);
 assert.throws(()=>compilePlan({...plan,steps:[{...plan.steps[0],depends_on:['second']}]},{workflowFile:roles}),/cycle|dependency/i);
});

test('exact-input reuse retains checks and invalidates changed input, conditions, output and environment',async t=>{
 const {cwd,store,task}=fixture(t);writeFileSync(path.join(cwd,'input.txt'),'one');writeFileSync(path.join(cwd,'environment.txt'),'v1');
 let calls=0;const connector={async execute(){calls++;return {};},parse(){return {outcome:'result',reply:{status:'done',summary:'checked',acceptance:task('').acceptance.map(criterion=>({criterion,result:'pass',evidence:'actual fixture'})),changed_files:{reported:[],observed:[],outside_scope:[]}}};},async close(){}};
 const submit=async(id,extra={})=>{store.sendTask(task(id,{file_refs:['input.txt'],reuse:{pure:true,version:'1',files:['environment.txt']},...extra}));const claim=store.claimTask('gemini','test');await runAgentTask(store,claim,connector);return store.takeReplies('codex').find(r=>r.reply_to===id);};
 await submit('first');const reused=await submit('second');assert.equal(calls,1);assert.equal(reused.body.reused_from.message_id,'first');assert.equal(reused.body.acceptance.length,2);
 writeFileSync(path.join(cwd,'input.txt'),'two');await submit('third');assert.equal(calls,2);
 await submit('fourth',{acceptance:['different mandatory condition']});assert.equal(calls,3);
 writeFileSync(path.join(cwd,'environment.txt'),'v2');await submit('fifth');assert.equal(calls,4);
});

test('reused direct Codex wrapper keeps zero usage and never opens a model',async t=>{
 const {cwd,store,task}=fixture(t);const envelope=task('first',{recipient:'codex',sender:'gemini',reuse:{pure:true,version:'1'}});
 const connector={execute:async()=>({}),parse:()=>({outcome:'result',reply:{status:'done',summary:'source',acceptance:envelope.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fixture'})),changed_files:{reported:[],observed:[],outside_scope:[]}}}),close:async()=>{}};
 store.sendTask(envelope);await runAgentTask(store,store.claimTask('codex','seed'),connector);
 store.sendTask({...envelope,message_id:'second'});await runCodexTask(store,store.claimTask('codex','cached'));
 assert.equal(store.get('second').status,'ready');assert.equal(store.listUsage('second')[0].turn.totalTokens,0);
});

test('plans roll back on invalid steps and never advance past failed mandatory checks',async t=>{
 const {compilePlan,sendPlan}=await import('../workflow.mjs');const {cwd,store,task}=fixture(t);
 assert.throws(()=>sendPlan(store,compilePlan({project_id:'rollback',cwd,sender:'codex',steps:[{id:'one',recipient:'gemini',goal:'first'},{id:'bad',recipient:'invalid',goal:'bad'}]})));
 assert.equal(store.get('rollback:one'),null);
 store.sendTask(task('source'));const claim=store.claimTask('gemini','first');
 store.finishTask('source',{claim,outcome:'result',reply:{status:'done',acceptance:[{criterion:'do not publish',result:'unverified',evidence:'no proof'}]}});
 store.sendTask(task('next',{depends_on:['source']}));assert.equal(store.claimTask('gemini','next'),null);
});

test('output mutations and incomplete verification invalidate reuse; standalone verification evidence survives reuse',async t=>{
 const {cwd,store,task}=fixture(t);const run=async(id,extra={},complete=true)=>{
  const envelope=task(id,{sandbox:'workspace-write',write_files:['out.txt'],reuse:{pure:true,version:'1'},verification:{kind:'visual',required:true},...extra});store.sendTask(envelope);
  const claim=store.claimTask('gemini',id);let executed=false;
  await runAgentTask(store,claim,{async execute(){executed=true;writeFileSync(path.join(cwd,'out.txt'),'verified');return {};},parse(){return {outcome:'result',reply:{status:'done',summary:'checked',acceptance:complete?envelope.acceptance.map(criterion=>({criterion,result:'pass',evidence:'reviewed exact fixture'})):[],changed_files:{reported:['out.txt'],observed:['out.txt'],outside_scope:[]}}};},async close(){}},{allowWrite:true});
  return executed;
 };
 assert.equal(await run('a'),true);assert.equal(await run('b'),false);
 writeFileSync(path.join(cwd,'out.txt'),'external');assert.equal(await run('c'),true);
 assert.equal(await run('no-proof',{reuse:{pure:true,version:'missing-proof'}},false),true);
 assert.equal(await run('no-proof-again',{reuse:{pure:true,version:'missing-proof'}},false),true);
});

test('a changed predecessor cannot publish an obsolete consumer result',async t=>{
 const {store,task}=fixture(t);const success=summary=>({status:'done',summary,acceptance:task('').acceptance.map(criterion=>({criterion,result:'pass',evidence:'fixture'}))});
 store.sendTask(task('parent'));let parent=store.claimTask('gemini','parent');store.finishTask('parent',{claim:parent,outcome:'result',reply:success('original')});
 store.sendTask(task('child',{depends_on:['parent']}));const child=store.claimTask('gemini','child');
 await runAgentTask(store,child,{async execute(){store.setStatus('parent','blocked','correct');store.requeue('parent');parent=store.claimTask('gemini','parent2');store.finishTask('parent',{claim:parent,outcome:'result',reply:success('corrected')});return {};},parse:()=>({outcome:'result',reply:success('obsolete consumer')}),close:async()=>{}});
 assert.equal(store.get('child').status,'blocked');assert.match(store.get('child').status_reason,/handoff.*changed/);
 assert.equal(store.takeReplies('codex').some(reply=>reply.reply_to==='child'),false);
});

test('independent review retains exact excerpts and full predecessor evidence',async()=>{
 const {reviewPacket}=await import('../claude-runner.mjs');
 const handoffs=[{result:{summary:'all facts',acceptance:[{criterion:'locked',result:'pass',evidence:'exact'}],custom_evidence:'retain'}}],context=[{path:'original.txt',content:'0.35 kg'}];
 const packet=reviewPacket({goal:'verify',acceptance:['locked'],file_refs:[],handoffs,context},'diff');
 assert.deepEqual(packet.handoffs,handoffs);assert.deepEqual(packet.context,context);
});

test('registered program code gets persisted read scopes, including queued conflicts',t=>{
 const {store,task}=fixture(t);store.sendTask(task('program'));const claim=store.claimTask('gemini','program');
 assert.equal(store.bindReadScopes('program',['check.mjs'],claim),true);
 store.sendTask(task('writer',{recipient:'claude-code',sandbox:'workspace-write',write_files:['check.mjs']}));assert.equal(store.claimTask('claude-code','writer'),null);
 store.finishTask('program',{claim,outcome:'result',reply:{status:'done'}});const writer=store.claimTask('claude-code','writer');assert.ok(writer);
 store.sendTask(task('program2'));const next=store.claimTask('gemini','program2');assert.equal(store.bindReadScopes('program2',['check.mjs'],next),false);assert.equal(store.get('program2').status,'queued');
 assert.equal(store.claimTask('gemini','early'),null);
});

test('separate-process usage events are idempotent and do not invent complete coverage',t=>{
 const {store}=fixture(t),event={project_id:'project',event_id:'writer:receipt',provider:'codex-writer',scope:'separate-process',source:'measured receipt',usage:{turn:{inputTokens:10,cachedInputTokens:5,outputTokens:2,totalTokens:12}}};
 assert.equal(store.recordExternalUsage(event).duplicate,false);assert.equal(store.recordExternalUsage(event).duplicate,true);
 assert.throws(()=>store.recordExternalUsage({...event,source:'conflict'}),/conflict/);
 const result=store.projectUsage('project');assert.equal(result.tokens.totalTokens.known,12);assert.equal(result.external_events,1);assert.equal(result.unmetered_external_usage,true);
});

test('an in-place transformation cannot reuse a result for a different starting input',async t=>{
 const {store,task,cwd}=fixture(t);writeFileSync(path.join(cwd,'counter.txt'),'0');let runs=0;
 for(const id of ['first','second']){
  const envelope=task(id,{file_refs:['counter.txt'],sandbox:'workspace-write',write_files:['counter.txt'],reuse:{pure:true,version:'in-place'}});
  store.sendTask(envelope);const claim=store.claimTask('gemini',id);
  await runAgentTask(store,claim,{async execute(){runs++;writeFileSync(path.join(cwd,'counter.txt'),String(Number(readFileSync(path.join(cwd,'counter.txt'),'utf8'))+1));return {};},parse:()=>({outcome:'result',reply:{status:'done',summary:'incremented',acceptance:envelope.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fixture'})),changed_files:{reported:['counter.txt'],observed:['counter.txt'],outside_scope:[]}}}),close:async()=>{}},{allowWrite:true});assert.equal(store.get(id).status,'ready');
 }
 assert.equal(runs,2);assert.equal(readFileSync(path.join(cwd,'counter.txt'),'utf8'),'2');
});

test('program result reuse includes effective environment overrides',async t=>{
 const {cwd,store,task}=fixture(t),script=path.join(cwd,'env.mjs'),profiles=path.join(cwd,'profiles.json');
 writeFileSync(script,`let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const t=JSON.parse(s);console.log(JSON.stringify({status:'done',summary:process.env.MODE,question:null,acceptance:t.acceptance.map(criterion=>({criterion,result:'pass',evidence:'measured env'})),changed_files:[]}));});`);
 writeFileSync(profiles,JSON.stringify({required_plugins:[],profiles:{standard:{plugins:[],input_fields:[],output_fields:['summary'],adapters:['env']}},adapters:{env:{command:process.execPath,args:[script],input_fields:[],output_fields:[]}}}));
 for(const mode of ['one','two']){store.sendTask(task(mode,{execution:{adapter:'env'},reuse:{pure:true,version:'1'}}));await runAgentWorker(store,{recipient:'gemini',once:true,profilesPath:profiles,env:{MODE:mode},createConnector(){throw new Error('no models');}});}
 const reply=store.takeReplies('codex').find(row=>row.reply_to==='two');assert.equal(reply.body.summary,'two');assert.equal(reply.body.reused_from,undefined);
});

test('reuse fingerprints follow declared and bridge variables, not the whole shell environment',async t=>{
 const {reuseKey}=await import('../reuse.mjs');const {store,task}=fixture(t);
 t.after(()=>{for(const name of ['BRIDGE_TEST_NOISE','BRIDGE_TEST_MODE','AGENT_BRIDGE_TEST_SETTING'])delete process.env[name];});
 const body=store.sendTask(task('env',{reuse:{pure:true,version:'1',env:['BRIDGE_TEST_MODE']}})).message.body,first=reuseKey(body);
 process.env.BRIDGE_TEST_NOISE='changed';assert.equal(reuseKey(body),first);
 process.env.BRIDGE_TEST_MODE='declared';const declared=reuseKey(body);assert.notEqual(declared,first);
 process.env.AGENT_BRIDGE_TEST_SETTING='bridge';assert.notEqual(reuseKey(body),declared);
 assert.notEqual(reuseKey(body,{env:{BRIDGE_TEST_NOISE:'override'}}),reuseKey(body));
 assert.throws(()=>store.sendTask(task('bad',{reuse:{pure:true,version:'1',env:'BRIDGE_TEST_MODE'}})),/reuse\.env must be an array/);
});

test('context changed during connector construction is detected before execution',async t=>{
 const {cwd,store,task}=fixture(t);writeFileSync(path.join(cwd,'source.txt'),'original\n');store.sendTask(task('race',{context_refs:[{path:'source.txt',lines:'1-1'}]}));let calls=0;
 await runAgentWorker(store,{recipient:'gemini',once:true,createConnector(){writeFileSync(path.join(cwd,'source.txt'),'changed\n');return {async execute(){calls++;return {};},parse:()=>({outcome:'result',reply:{status:'done'}}),close:async()=>{}};}});
 assert.equal(calls,0);assert.equal(store.get('race').status,'blocked');assert.match(store.get('race').status_reason,/context source changed/);
});

test('malformed manual evidence blocks its dependents without stopping unrelated scheduling',t=>{
 const {store,task}=fixture(t);store.sendTask(task('parent'));const parent=store.claimTask('gemini','parent');store.finishTask('parent',{claim:parent,outcome:'result',reply:{status:'done',acceptance:[{criterion:task('').acceptance[0],result:'pass',evidence:42}]}});
 store.sendTask(task('dependent',{depends_on:['parent']}));store.sendTask(task('unrelated'));assert.equal(store.claimTask('gemini','worker').message_id,'unrelated');
});

test('usage baselines are namespaced by recipient as well as session id',t=>{
 const {store,task}=fixture(t);
 for(const [recipient,total] of [['gemini',100],['codex',500]]){
  store.sendTask(task(recipient,{repeat:true,recipient,sender:'claude-code'}));const claim=store.claimTask(recipient,recipient);store.setTurn(recipient,'same-external-id','turn',claim);store.saveUsage(recipient,{thread_total:{totalTokens:total},turn:{totalTokens:total}},claim);
 }
 assert.equal(store.lastThreadTotal('same-external-id','gemini').totalTokens,100);assert.equal(store.lastThreadTotal('same-external-id','codex').totalTokens,500);
});

test('directory inputs with nested links do not silently reuse untracked target contents',async t=>{
 const {cwd,store,task}=fixture(t);mkdirSync(path.join(cwd,'inputs'));mkdirSync(path.join(cwd,'target'));writeFileSync(path.join(cwd,'target','facts.txt'),'one');
 symlinkSync(path.join(cwd,'target'),path.join(cwd,'inputs','linked'),process.platform==='win32'?'junction':'dir');let calls=0;
 for(const id of ['first','second']){store.sendTask(task(id,{file_refs:['inputs'],reuse:{pure:true,version:'links'}}));const claim=store.claimTask('gemini',id);
  await runAgentTask(store,claim,{async execute(){calls++;return {};},parse:()=>({outcome:'result',reply:{status:'done',summary:'checked',acceptance:task('').acceptance.map(criterion=>({criterion,result:'pass',evidence:'fixture'})),changed_files:{reported:[],observed:[],outside_scope:[]}}}),close:async()=>{}});
  writeFileSync(path.join(cwd,'target','facts.txt'),'two');
 }
 assert.equal(calls,2);
});

test('relative program entrypoints and explicit library code files are fingerprinted',async t=>{
 const {programConfig}=await import('../program-runner.mjs');const {cwd,task}=fixture(t),profiles=path.join(cwd,'profiles.json');
 writeFileSync(path.join(cwd,'runner.mjs'),'// fixture');writeFileSync(path.join(cwd,'library.txt'),'v1');
 writeFileSync(profiles,JSON.stringify({required_plugins:[],profiles:{standard:{plugins:[],input_fields:[],output_fields:[],adapters:['a']}},adapters:{a:{command:process.execPath,args:['runner.mjs'],code_files:['library.txt'],input_fields:[],output_fields:[]}}}));
 const envelope=task('program',{execution:{adapter:'a'}}),first=programConfig(envelope,{profilesPath:profiles});assert.ok(first.code_hashes[path.join(cwd,'runner.mjs')]);
 writeFileSync(path.join(cwd,'library.txt'),'v2');assert.notEqual(programConfig(envelope,{profilesPath:profiles}).code_hashes[path.join(cwd,'library.txt')],first.code_hashes[path.join(cwd,'library.txt')]);
});
