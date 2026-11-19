import {inspectContract as inspectContractForTest,receiptFor as receiptForTest,verifyWire as verifyWireForTest,wirePacket as wirePacketForTest} from '../contracts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {BridgeStore,hashFile} from '../store.mjs';
import {buildPrompt,RESULT_SCHEMA} from '../codex-runner.mjs';
import {reviewPacket,buildClaudeArgs} from '../claude-runner.mjs';
import {buildGeminiArgs} from '../gemini-runner.mjs';
import {taskPacket,loadProfiles,resolveProfile} from '../profiles.mjs';
import {runAgentTask} from '../runner-core.mjs';
import {runCodexWorker} from '../codex-runner.mjs';
import {runClaudeWorker} from '../claude-runner.mjs';
import {fixtureLog} from './fixtures/fixture-log.mjs';
import {runGeminiWorker} from '../gemini-runner.mjs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {GEMINI_TEST_AUTH} from './fixtures/gemini-auth.mjs';

function fixture(t){const cwd=mkdtempSync(path.join(os.tmpdir(),'bridge-contract-'));const store=new BridgeStore(':memory:');t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});
 writeFileSync(path.join(cwd,'facts.txt'),'SKU A-17; 0.35 kg\n');writeFileSync(path.join(cwd,'environment.txt'),'renderer-v1');
 const document={id:'C-PROJECT',version:'1',objective:'원본의 SKU와 중량을 유지한다.\n게시하지 않는다.',requirements:[{id:'R1',text:'SKU A-17 그대로'},{id:'R2',text:'0.35 kg 그대로; 게시 금지'}],
  sources:[{path:'facts.txt',hash:hashFile(cwd,'facts.txt')}],environment:{node:process.version,platform:process.platform,arch:process.arch,files:[{path:'environment.txt',hash:hashFile(cwd,'environment.txt')}]},
  review:{criteria:[{id:'Q1',text:'원문 수치와 조건 일치',method:'source-comparison',required:true}]}};
 const file=path.join(cwd,'contract.json');writeFileSync(file,JSON.stringify(document));
 const task=(id,extra={})=>({message_id:id,task_id:'contract',project_id:'P1',sender:'codex',recipient:'gemini',cwd,goal:'맡은 작업을 수행한다.\n원문 보존',acceptance:['기존 조건'],sandbox:'read-only',write_files:[],file_refs:[],contract:file,contract_review_ids:['Q1'],...extra});
 return {cwd,store,document,file,task};}

test('binding preserves canonical text and selected profile cannot discard contract or step conditions',async t=>{
 const {bindContract,verifyWire,wirePacket}=await import('../contracts.mjs');const {task,document}=fixture(t);const bound=bindContract(task('one'));
 assert.deepEqual(bound.contract.document,document);assert.ok(bound.acceptance.includes('기존 조건'));assert.ok(bound.acceptance.includes('원문 수치와 조건 일치'));
 const packet=taskPacket(bound,resolveProfile(loadProfiles(),'light'));assert.deepEqual(packet.contract,bound.contract);
 const prompt=buildPrompt({...bound,...packet});const receipt=verifyWire(bound,prompt);assert.equal(receipt.contract_hash,bound.contract.hash);
 const bad=wirePacket(bound);bad.contract.document.requirements.pop();assert.throws(()=>verifyWire(bound,bad),/contract.*changed|contract.*mismatch/i);
 const step=wirePacket(bound);step.step.acceptance=[];assert.throws(()=>verifyWire(bound,step),/step.*changed|step.*mismatch/i);
});

test('each step must name the contract criteria it checks; none are assigned by default',async t=>{
 const {bindContract}=await import('../contracts.mjs');const {compilePlan}=await import('../workflow.mjs');const {store,task,cwd,file}=fixture(t);
 assert.throws(()=>bindContract(task('implicit',{contract_review_ids:undefined})),/contract_review_ids required/);
 assert.throws(()=>store.sendTask(task('implicit',{contract_review_ids:undefined})),/contract_review_ids required/);
 const none=bindContract(task('none',{contract_review_ids:[]}));assert.deepEqual(none.contract_review_ids,[]);assert.deepEqual(none.acceptance,['기존 조건']);
 store.sendTask(task('registered'));
 assert.throws(()=>store.sendTask(task('plain',{contract:undefined,contract_review_ids:undefined})),/already has a common contract.*inherits/);
 assert.throws(()=>compilePlan({project_id:'implicit',cwd,sender:'codex',contract:file,steps:[{id:'a',recipient:'gemini',goal:'work',acceptance:[]}]}),/contract_review_ids required/);
});

test('native adapters retain acknowledgements through execution, parse and delivery projection',async t=>{
 const {store,task}=fixture(t);
 for(const [recipient,run,fixture] of [['codex',runCodexWorker,'fake-app-server.mjs'],['claude-code',runClaudeWorker,'fake-general-cli.mjs'],['gemini',runGeminiWorker,'fake-general-cli.mjs']]){
  store.sendTask(task(recipient,{recipient,sender:recipient==='codex'?'gemini':'codex'}));
  await run(store,{once:true,geminiAuth:GEMINI_TEST_AUTH,command:process.execPath,args:[fileURLToPath(new URL('./fixtures/'+fixture,import.meta.url))]});
  const row=store.get(recipient);assert.equal(row.status,'ready',row.status_reason);
  const reply=store.takeReplies(row.sender).find(reply=>reply.reply_to===recipient);assert.equal(reply.body.contract_receipt.contract_hash,row.body.contract.hash);
  assert.ok(reply.body.delivery.contract_receipt);assert.equal(store.listRuntime(recipient)[0].contract_delivery.verified,true);
 }
});

test('a project contract cannot be replaced or dropped by another step',t=>{
 const {store,task,file,document,cwd}=fixture(t);store.sendTask(task('root',{sender:'claude-code',recipient:'codex',chain:{review:true},contract_review_ids:[]}));
 const root=store.get('root');const other=path.join(cwd,'other.json');writeFileSync(other,JSON.stringify({...document,id:'REPLACEMENT'}));
 assert.throws(()=>store.sendTask(task('replace',{contract:other})),/contract/);
 store.sendTask(task('inherit',{contract:undefined}));assert.equal(store.get('inherit').body.contract.hash,root.body.contract.hash);
});

test('independent final review covers mandatory contract criteria even when implementation scope is empty',async t=>{
 const {reviewTask}=await import('../chain.mjs');const {store,task}=fixture(t);store.sendTask(task('root',{sender:'claude-code',recipient:'codex',chain:{review:true},contract_review_ids:[]}));
 const root=store.get('root'),review=reviewTask({...root,round:1},root,{message_id:'result',body:{}},null);
 assert.deepEqual(review.contract_review_ids,['Q1']);
});

test('all schema adapters require the same acknowledgement and independent reviewer gets the full contract',async t=>{
 const {bindContract,responseSchema}=await import('../contracts.mjs');const {task}=fixture(t);const bound=bindContract(task('wire'));
 for(const args of [buildClaudeArgs(bound),buildGeminiArgs(bound)])assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema')+1]),responseSchema(RESULT_SCHEMA,bound));
 const packet=reviewPacket(bound,'diff.txt');assert.deepEqual(packet.contract,bound.contract);assert.deepEqual(packet.contract_review_ids,bound.contract_review_ids);
});

test('shared environment is observed and mismatches block before model execution',async t=>{
 const {inspectContract}=await import('../contracts.mjs');const {store,task,cwd}=fixture(t);store.sendTask(task('env'));const claim=store.claimTask('gemini','env');
 const first=inspectContract(claim.body);assert.equal(first.verified,true);writeFileSync(path.join(cwd,'environment.txt'),'renderer-v2');let calls=0;
 await runAgentTask(store,claim,{execute:async()=>{calls++;return {};},close:async()=>{}});assert.equal(calls,0);assert.equal(store.get('env').status,'blocked');
});

test('missing and altered model acknowledgements cannot publish a successful result',async t=>{
 const {inspectContract,receiptFor,verifyWire,wirePacket}=await import('../contracts.mjs');const {store,task}=fixture(t);
 for(const mode of ['missing','wrong-hash','missing-requirement','unverified','valid']){
  store.sendTask(task(mode));const claim=store.claimTask('gemini',mode),environment=inspectContract(claim.body);
  const reply={status:'done',summary:'checked',acceptance:claim.body.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fixture'})),changed_files:{reported:[],observed:[],outside_scope:[]}};
  if(mode!=='missing')reply.contract_receipt=receiptFor(claim.body,environment,reply.acceptance);
  if(mode==='wrong-hash')reply.contract_receipt.contract_hash='wrong';
  if(mode==='missing-requirement')reply.contract_receipt.requirement_ids.pop();
  if(mode==='unverified')reply.contract_receipt.review[0].result='unverified';
  if(mode==='unverified')reply.delivery={status:'done'};
  await runAgentTask(store,claim,{execute:async()=>{store.saveRuntime(claim.message_id,{contract_delivery:verifyWire(claim.body,wirePacket(claim.body))},claim);return {};},parse:()=>({outcome:'result',reply}),close:async()=>{}});
  assert.equal(store.get(mode).status,mode==='valid'?'ready':'blocked');
  if(mode==='unverified')assert.equal(store.takeReplies('codex').find(row=>row.reply_to===mode).body.delivery.status,'failed');
 }
});

test('conflicting duplicate step fields and missing mandatory project review coverage are rejected',async t=>{
 const {bindContract,wirePacket,verifyWire}=await import('../contracts.mjs');const {compilePlan}=await import('../workflow.mjs');const {task,cwd,file}=fixture(t);
 const bound=bindContract(task('one')),packet={...wirePacket(bound),goal:'altered'};assert.throws(()=>verifyWire(bound,packet),/step|goal/);
 assert.throws(()=>compilePlan({project_id:'unreviewed',cwd,sender:'codex',contract:file,steps:[{id:'skip',recipient:'gemini',goal:'work',acceptance:[],contract_review_ids:[]}]}),/review.*coverage|mandatory.*review/);
});

test('manual completion cannot bypass adapter wire verification',async t=>{
 const {inspectContract,receiptFor}=await import('../contracts.mjs');const {store,task}=fixture(t);store.sendTask(task('manual'));const claim=store.claimTask('gemini','manual'),environment=inspectContract(claim.body);
 store.saveRuntime('manual',{contract_environment:environment},claim);
 const checks=claim.body.acceptance.map(criterion=>({criterion,result:'pass',evidence:'claim'}));
 assert.throws(()=>store.finishTask('manual',{claim,outcome:'result',reply:{status:'done',acceptance:checks,contract_receipt:receiptFor(claim.body,environment,checks)}}),/delivery|wire/);
});

test('a valid independent contract rejection still queues the existing rework round',async t=>{
 const {inspectContract,receiptFor,verifyWire,wirePacket}=await import('../contracts.mjs');const {store,task}=fixture(t);
 store.sendTask(task('root',{sender:'claude-code',recipient:'codex',chain:{review:true},contract_review_ids:[]}));
 const finish=(claim,reply)=>{const environment=inspectContract(claim.body),prepared={...claim.body,contract_environment:environment};
   store.saveRuntime(claim.message_id,{contract_environment:environment,contract_delivery:verifyWire(prepared,wirePacket(prepared))},claim);
   reply.contract_receipt=receiptFor(claim.body,environment,reply.acceptance ?? reply.criteria);return store.finishTask(claim.message_id,{claim,outcome:'result',reply});};
 let claim=store.claimTask('codex','implement');finish(claim,{status:'done',summary:'implemented',acceptance:claim.body.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fixture'})),changed_files:{reported:[],observed:[],outside_scope:[]}});
 claim=store.claimTask('claude-code','review');finish(claim,{status:'done',verdict:'reject',summary:'fix required',criteria:claim.body.acceptance.map(criterion=>({criterion,result:criterion==='원문 수치와 조건 일치'?'fail':'pass',evidence:'actual rejection fixture'})),findings:[{criterion:'원문 수치와 조건 일치',problem:'missing output check',required_change:'correct the evidence',files:[]}],boundary_review:{paths:'unchanged',exec:'unchanged',auth_permissions:'unchanged',notes:'fixture'}});
 assert.equal(store.get(claim.message_id).status,'ready');assert.equal(store.get('root:rework:2').status,'queued');
});

test('registered program execution must match a declared common toolchain',async t=>{
 const {verifyProgramEnvironment,bindContract}=await import('../contracts.mjs');const {task,document,cwd,file}=fixture(t);
 writeFileSync(file,JSON.stringify({...document,environment:{...document.environment,tools:[{id:'node',path:process.execPath,hash:hashFile(cwd,process.execPath)}]}}));
 const bound=bindContract(task('program'));
 assert.throws(()=>verifyProgramEnvironment(bound,{adapter:{command:path.join(cwd,'different.exe')},code_hashes:{}}),/toolchain/);
 assert.equal(verifyProgramEnvironment(bound,{adapter:{command:process.execPath},code_hashes:{[process.execPath]:hashFile(cwd,process.execPath)}}).verified,true);
});

test('a directory fingerprint cannot silently omit nested linked source contents',async t=>{
 const {bindContract,inspectContract}=await import('../contracts.mjs');const {cwd,file,document,task}=fixture(t);
 mkdirSync(path.join(cwd,'sources'));mkdirSync(path.join(cwd,'target'));writeFileSync(path.join(cwd,'target','text.txt'),'actual input');
 symlinkSync(path.join(cwd,'target'),path.join(cwd,'sources','link'),process.platform==='win32'?'junction':'dir');
 writeFileSync(file,JSON.stringify({...document,sources:[{path:'sources',hash:hashFile(cwd,'sources')}]}));
 assert.throws(()=>inspectContract(bindContract(task('linked'))),/linked|symlink/i);
});

test('manual CLI receive and reply preserve the same verified contract protocol',async t=>{
 const {receiptFor}=await import('../contracts.mjs');const {task,cwd}=fixture(t),db=path.join(cwd,'manual.db'),cli=fileURLToPath(new URL('../cli.mjs',import.meta.url)),file=path.join(cwd,'task.json');
 writeFileSync(file,JSON.stringify(task('manual')));
 const call=args=>{const result=spawnSync(process.execPath,[cli,...args,'--db',db],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 call(['send',file]);const received=call(['receive','--as','gemini','--take-tasks']);assert.ok(received.step);assert.ok(received.contract_environment?.verified);
 const checks=received.step.acceptance.map(criterion=>({criterion,result:'pass',evidence:'manual protocol fixture'}));
 const reply=call(['reply','--to','manual','--attempt',String(received.attempt),'--summary','checked','--acceptance',JSON.stringify(checks),'--contract-receipt',JSON.stringify(receiptFor(received,received.contract_environment,checks))]);
 assert.equal(reply.contract_receipt.contract_hash,received.contract.hash);
});

test('external plans and chain descendants keep the same sealed business contract',async t=>{
 const {compilePlan,sendPlan}=await import('../workflow.mjs');const {reviewTask}=await import('../chain.mjs');const {store,task,file,cwd}=fixture(t);
 const roles=path.join(cwd,'roles.json');writeFileSync(roles,JSON.stringify({roles:{research:{agent:'gemini',instructions:'자료를 확인한다.'},frontend:{agent:'claude-code',instructions:'프론트 검수한다.'}}}));
 const tasks=compilePlan({project_id:'P2',cwd,sender:'codex',contract:file,steps:[{id:'a',workflow_role:'research',goal:'자료 확인',acceptance:[],contract_review_ids:['Q1']},{id:'b',workflow_role:'frontend',goal:'자료 검수',acceptance:[],depends_on:['a'],contract_review_ids:[]}]},{workflowFile:roles});
 sendPlan(store,tasks);const a=store.get('P2:a'),b=store.get('P2:b');assert.equal(a.body.contract.hash,b.body.contract.hash);
 assert.notEqual(a.body.goal,b.body.goal);assert.deepEqual(a.body.contract.document,b.body.contract.document);
 const review=reviewTask({...a,body:{...a.body,chain:{review_model:'claude-test',review_effort:'high'}},round:1},a,{message_id:'fixture',body:{}},null);assert.deepEqual(review.contract,a.body.contract);
});

test('review coverage cannot be bypassed by using step-local or registered contracts', async t => {
  const {compilePlan,sendPlan}=await import('../workflow.mjs');
  const {store,cwd,file,task}=fixture(t);
  const step={id:'skip',recipient:'gemini',goal:'work',acceptance:[],contract_review_ids:[]};
  const plan={project_id:'P1',cwd,sender:'codex',steps:[step]};
  assert.throws(()=>compilePlan({...plan,steps:[{...step,contract:file}]}),/mandatory contract review coverage missing/);
  store.sendTask(task('register'));
  assert.throws(()=>sendPlan(store,compilePlan(plan)),/mandatory contract review coverage missing/);
  assert.equal(store.get('P1:skip'),null);
});

test('inherited contract preserves a follow-up’s explicit review selection', async t => {
  const {store,task}=fixture(t);
  store.sendTask(task('first',{contract_review_ids:[]}));
  const claim=store.claimTask('gemini','fixture');
  const environment=inspectContractForTest(claim.body),prepared={...claim.body,contract_environment:environment};
  store.saveRuntime('first',{contract_environment:environment,contract_delivery:verifyWireForTest(prepared,wirePacketForTest(prepared))},claim);
  const checks=claim.body.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fixture'}));
  const reply=store.finishTask('first',{claim,outcome:'result',reply:{status:'done',summary:'first',
    acceptance:checks,contract_receipt:receiptForTest(claim.body,environment,checks)}});
  const next=store.sendTask(task('followup',{contract:undefined,reply_to:reply.message_id,contract_review_ids:['Q1']}));
  assert.deepEqual(next.message.body.contract_review_ids,['Q1']);
});

function hybridReviewFixture(t, { judgment = false, present = true } = {}) {
  const { store, cwd, file, task, document } = fixture(t);
  const checks = [{ id:'Q1', text:'Deliverable exists', method:'file-exists', check:{ type:'file-exists', path:'output.txt' } }];
  if (judgment) checks.push({ id:'Q2', text:'Meaning preserved', method:'source-comparison', evidence:['facts.txt','output.txt'], requirement_ids:['R1'] });
  writeFileSync(file, JSON.stringify({ ...document, review:{ mode:'hybrid', criteria:checks } }));
  if (present) writeFileSync(path.join(cwd,'output.txt'),'SKU A-17; 0.35 kg\n');
  store.sendTask(task('hybrid',{ sender:'claude-code', recipient:'codex', chain:{ review:true, max_rounds:1 },
    contract_review_ids:[], file_refs:['output.txt'], acceptance:[] }));
  const claim=store.claimTask('codex','producer'),environment=inspectContractForTest(claim.body);
  const prepared={ ...claim.body, contract_environment:environment };
  store.saveRuntime(claim.message_id,{ contract_environment:environment, contract_delivery:verifyWireForTest(prepared,wirePacketForTest(prepared)) },claim);
  store.finishTask(claim.message_id,{ claim, outcome:'result',reply:{ status:'done', summary:'irrelevant producer summary',
    acceptance:[], changed_files:{reported:[],observed:[],outside_scope:[]}, contract_receipt:receiptForTest(claim.body,environment,[]) } });
  return {store,cwd};
}

test('hybrid contract verifies file evidence locally and never starts a model for a program-only review', async t => {
  for (const present of [true,false]) {
    const {store,cwd}=hybridReviewFixture(t,{present});
    await runClaudeWorker(store,{once:true,command:path.join(cwd,'must-not-start.exe')});
    const final=store.get('hybrid:final')?.body;
    assert.equal(final?.verdict,present?'pass':'reject');
    assert.equal(final.contract_receipt.review[0].result,present?'pass':'fail');
    assert.equal(store.listUsage('hybrid:review:1')[0].calls.model_calls,0);
  }
});

test('hybrid reviewer receives scoped judgment evidence and final receipt includes both checks', async t => {
  const {store,cwd}=hybridReviewFixture(t,{judgment:true});
  const log=fixtureLog(t,'review.jsonl');
  await runClaudeWorker(store,{once:true,command:process.execPath,
    args:[fileURLToPath(new URL('./fixtures/fake-claude.mjs',import.meta.url))],env:{FAKE_CLAUDE_LOG:log}});
  const packet=JSON.parse(readFileSync(log,'utf8')).packet;
  assert.deepEqual(packet.contract_review_ids,['Q2']);
  assert.deepEqual(packet.contract.document.requirements.map(r=>r.id),['R1']);
  assert.deepEqual(packet.file_refs.map(r=>path.basename(r.path)).sort(),['facts.txt','output.txt']);
  assert.doesNotMatch(JSON.stringify(packet),/irrelevant producer summary|Deliverable exists|environment\.txt/);
  assert.deepEqual(store.get('hybrid:final').body.contract_receipt.review.map(r=>[r.criterion_id,r.result]),[['Q1','pass'],['Q2','pass']]);
});

test('hybrid mandatory judgment cannot be skipped when the model omits it or its evidence is missing', async t => {
  for (const evidencePresent of [true,false]) {
    const {store,cwd}=hybridReviewFixture(t,{judgment:true});
    if (!evidencePresent) rmSync(path.join(cwd,'output.txt'));
    const log=fixtureLog(t,'review.jsonl');
    await runClaudeWorker(store,{once:true,command:process.execPath,
      args:[fileURLToPath(new URL('./fixtures/fake-claude.mjs',import.meta.url))],
      env:{FAKE_CLAUDE_LOG:log,FAKE_CLAUDE_MODE:'omit-review-id'}});
    if (evidencePresent) {
      assert.equal(store.get('hybrid:final'),null);
      assert.match(store.get('hybrid:review:1').status_reason,/review acknowledgement mismatch/);
    } else {
      assert.equal(store.get('hybrid:final')?.body.verdict,'reject');
      assert.equal(store.get('hybrid:final').body.contract_receipt.review[1].result,'unverified');
      assert.equal(store.listUsage('hybrid:review:1')[0].calls.model_calls,0);
    }
  }
});

test('hybrid structured values and expected hashes use program evidence without an AI', async t => {
  const {programReview}=await import('../hybrid-review.mjs');
  const {cwd}=fixture(t);
  writeFileSync(path.join(cwd,'output.json'),JSON.stringify({product:{weight:350}}));
  const hash=hashFile(cwd,'output.json');
  const program=[
    {id:'same',check:{type:'json-equals',path:'output.json',key:['product','weight'],expected:350}},
    {id:'wrong',check:{type:'json-equals',path:'output.json',key:['product','weight'],expected:'350'}},
    {id:'hash',check:{type:'file-sha256',path:'output.json',expected:hash}},
  ];
  assert.deepEqual(programReview({cwd},{program,judgment:[]}).checks.map(row=>[row.criterion_id,row.result]),
    [['same','pass'],['wrong','fail'],['hash','pass']]);
});

test('a misspelt review mode or a check outside hybrid mode is rejected instead of ignored', async t => {
  const {bindContract}=await import('../contracts.mjs');
  const {file,task,document}=fixture(t);
  const check={type:'file-exists',path:'facts.txt'};
  for (const [review,error] of [
    [{mode:'hybird',criteria:document.review.criteria},/unsupported contract review mode/],
    [{criteria:[{...document.review.criteria[0],check}]},/need review\.mode "hybrid"/],
  ]) {
    writeFileSync(file,JSON.stringify({...document,review}));
    assert.throws(()=>bindContract(task('typo')),error);
  }
});
