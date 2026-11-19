import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {BridgeStore,AGENTS,normaliseTask} from '../store.mjs';
import {runCodexWorker} from '../codex-runner.mjs';
import {runClaudeWorker} from '../claude-runner.mjs';
import {runGeminiWorker} from '../gemini-runner.mjs';
import {runAgentTask} from '../runner-core.mjs';
import {prepareContext} from '../context.mjs';
import {main} from '../cli.mjs';
import {communicationPolicy,verifyCommunication,observePermissionDenial} from '../communication.mjs';

function setup(t){
 const home=mkdtempSync(path.join(os.tmpdir(),'bridge-communication-'));mkdirSync(path.join(home,'work'));
 const cwd=path.join(home,'work'),store=new BridgeStore(':memory:');
 t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 return {home,cwd,store,task:(id,extra={})=>({message_id:id,task_id:'directions',sender:'codex',recipient:'gemini',cwd,goal:'Return a short confirmation',profile:'light',recovery:false,...extra})};
}
const fixture=name=>fileURLToPath(new URL('./fixtures/'+name,import.meta.url));

test('all six native AI directions deliver the same rules, preserve settings and return browser state with ACK',async t=>{
 const {home,store,task}=setup(t);let rulesHash;
 const workers={codex:runCodexWorker,'claude-code':runClaudeWorker,gemini:runGeminiWorker};
 for(const sender of AGENTS)for(const recipient of AGENTS){
  if(sender===recipient)continue;
  const id=sender+'-'+recipient;store.sendTask(task(id,{sender,recipient,browser_context:{space_id:7,page:'p1'}}));
  await workers[recipient](store,{once:true,policyHome:home,command:process.execPath,args:[fixture(recipient==='codex'?'fake-app-server.mjs':'fake-general-cli.mjs')]});
  assert.equal(store.get(id).status,'ready',store.get(id).status_reason);
  const reply=store.takeReplies(sender).find(r=>r.reply_to===id);const proof=reply.body.communication_receipt;
  assert.equal(proof.delivery_verified,true);assert.equal(proof.settings_preserved,true);
  assert.equal(proof.profile,'light');assert.equal(proof.rules_hash,rulesHash??=proof.rules_hash);
  assert.deepEqual(reply.body.browser_context,{space_id:7,page:'p1'});
  assert.deepEqual(reply.body.delivery.communication_receipt,proof);
  store.ackReplies(sender,[reply.message_id]);assert.ok(!store.takeReplies(sender).some(r=>r.reply_to===id));
 }
});

test('rules hashes bind task scope and cannot be replaced or omitted in transport',()=>{
 const task={goal:'inspect',acceptance:[],sandbox:'read-only',write_files:[],profile:'light'};
 task.communication=communicationPolicy(task);
 assert.equal(verifyCommunication(task,'BRIDGE_RULES_JSON:'+JSON.stringify(task.communication)).verified,true);
 assert.throws(()=>verifyCommunication(task,'missing'),/communication/);
 assert.throws(()=>verifyCommunication(task,{communication:{...task.communication,task_hash:'tampered'}}),/communication/);
 assert.notEqual(communicationPolicy({...task,write_files:['extra']}).task_hash,task.communication.task_hash);
});

test('native settings changed outside the permitted task scope block publication',async t=>{
 const {home,cwd,store,task}=setup(t);mkdirSync(path.join(home,'.gemini/antigravity-cli'),{recursive:true});
 const config=path.join(home,'.gemini/antigravity-cli/settings.json');writeFileSync(config,'{}');
 store.sendTask(task('settings'));const claim=store.claimTask('gemini','test');
 await runAgentTask(store,claim,{async execute(){writeFileSync(config,'{"permissions":{"allow":["*"]}}');return {};},
  async parse(){return {outcome:'result',reply:{status:'done',summary:'ok',changed_files:{reported:[]}}};},async close(){}},{policyHome:home});
 assert.equal(store.get('settings').status,'blocked');assert.match(store.get('settings').status_reason,/native settings changed/);
 assert.equal(store.get('settings:attempt:1:result'),null);
});

test('configured Claude prompt hooks require an actual successful hook event',async t=>{
 const {home,store,task}=setup(t);mkdirSync(path.join(home,'.claude'));
 writeFileSync(path.join(home,'.claude/settings.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'configured hook'}]}]}}));
 for(const mode of ['pass','no-hooks']){
  store.sendTask(task(mode,{recipient:'claude-code'}));
  await runClaudeWorker(store,{once:true,policyHome:home,command:process.execPath,args:[fixture('fake-general-cli.mjs')],env:{FAKE_GENERAL_MODE:mode}});
  assert.equal(store.get(mode).status,mode==='pass'?'ready':'blocked');
  if(mode==='no-hooks')assert.match(store.get(mode).status_reason,/required hook not observed/);
 }
});

test('permission diagnostics retain native classifier reasons without replacing recovered success',()=>{
 const receipt={};observePermissionDenial({type:'system',subtype:'permission_denied',tool_name:'Bash',decision_reason:'Blocked by classifier',decision_reason_type:'classifier'},receipt);
 observePermissionDenial({type:'result',permission_denials:[{tool_name:'Bash',decision_reason:'Blocked by classifier'}]},receipt);
 assert.deepEqual(receipt.permission_denials,['Blocked by classifier']);
 assert.equal(receipt.permission_details[0].source,'classifier');
});

for(const recipient of ['claude-code','gemini'])test(`native denial reason survives ${recipient} parsing`,async t=>{
 const {home,store,task}=setup(t);store.sendTask(task(recipient,{recipient}));
 await (recipient==='gemini'?runGeminiWorker:runClaudeWorker)(store,{once:true,policyHome:home,command:process.execPath,args:[fixture('fake-general-cli.mjs')],env:{FAKE_GENERAL_MODE:'classifier-denial'}});
 assert.equal(store.get(recipient).status,'blocked');assert.match(store.get(recipient).status_reason,/Blocked by classifier/);
});

test('browser context is validated and handed off using the compact verified result',t=>{
 const {store,task}=setup(t);
 assert.throws(()=>normaliseTask(task('bad',{browser_context:{space_id:-1,page:'p1'}})),/browser_context/);
 store.sendTask(task('first'));const claim=store.claimTask('gemini','test');
 store.finishTask('first',{claim,outcome:'result',reply:{status:'done',summary:'short',final_text:'long'.repeat(10000),browser_context:{space_id:7,page:'p1'},delivery:{status:'done',summary:'short',browser_context:{space_id:7,page:'p1'}}}});
 const next=normaliseTask(task('next',{handoff_from:['first']}));const prepared=prepareContext(store,next);
 assert.deepEqual(prepared.browser_context,{space_id:7,page:'p1'});assert.equal(prepared.handoffs[0].result.final_text,undefined);
});

test('compact handoffs retain review findings even from an older delivery projection',t=>{
 const {store,task}=setup(t);store.sendTask(task('review'));const claim=store.claimTask('gemini','test');
 const findings=[{problem:'retain this evidence'}];
 store.finishTask('review',{claim,outcome:'result',reply:{status:'done',summary:'review',verdict:'pass',findings,criteria:[{result:'pass'}],delivery:{status:'done',summary:'review'}}});
 const prepared=prepareContext(store,normaliseTask(task('next-review',{handoff_from:['review']})));
 assert.deepEqual(prepared.handoffs[0].result.findings,findings);assert.equal(prepared.handoffs[0].result.verdict,'pass');
});

test('manual CLI delivery and reply carry verified common rules in every direction',async t=>{
 const home=mkdtempSync(path.join(os.tmpdir(),'bridge-manual-')),cwd=path.join(home,'work');mkdirSync(cwd);
 const db=path.join(home,'manual.db'),store=new BridgeStore(db);t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const printed=[];t.mock.method(process.stdout,'write',line=>{printed.push(JSON.parse(line));return true;});
 for(const sender of AGENTS)for(const recipient of AGENTS){
  if(sender===recipient)continue;const id='manual-'+sender+'-'+recipient;
  store.sendTask({message_id:id,task_id:'manual',sender,recipient,cwd,goal:'manual reply',profile:'light',browser_context:{space_id:7,page:'p1'}});
  await main(['receive','--as',recipient,'--take-tasks','--db',db]);
  const packet=printed.find(p=>p.message_id===id&&p.kind==='task');assert.ok(packet.communication?.rules_hash);
  await main(['reply','--to',id,'--attempt','1','--summary','done','--db',db]);
  const reply=store.takeReplies(sender).find(r=>r.reply_to===id);assert.equal(reply.body.communication_receipt.delivery_verified,true);
  assert.deepEqual(reply.body.browser_context,{space_id:7,page:'p1'});store.ackReplies(sender,[reply.message_id]);
 }
});
