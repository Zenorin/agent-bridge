import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {BridgeStore} from '../store.mjs';

async function race(db){
 const children=Array.from({length:8},()=>fork(fileURLToPath(new URL('./fixtures/claim-once.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc']}));
 const exits=children.map(child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}));
 const message=child=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});
 try{
  const ready=children.map(message);children.forEach(child=>child.send({db,recipient:'codex'}));
  assert.ok((await Promise.all(ready)).every(event=>event.ready));
  const results=children.map(message);children.forEach(child=>child.send('claim'));
  return await Promise.all(results);
 }finally{
  children.forEach(child=>{if(child.exitCode===null)child.kill();});await Promise.all(exits);
 }
}

for(const mode of ['same-message','same-write-scope','same-session','same-inflight-work','same-browser-space'])test(`eight processes cannot simultaneously claim ${mode}`,{timeout:30_000},async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'bridge-claim-race-')),db=path.join(root,'queue.db'),store=new BridgeStore(db);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const task=id=>({message_id:id,task_id:'race',sender:'claude-code',recipient:'codex',cwd:root,goal:'one owner',
  ...(mode==='same-write-scope'?{repeat:true,sandbox:'workspace-write',write_files:['shared.mjs']}:{}),
  ...(mode==='same-browser-space'?{goal:id,browser_context:{space_id:12,page:id==='first'?'p1':'p2'}}:{}),
  ...(mode==='same-session'?{thread_id:'11111111-1111-4111-8111-111111111111'}:{})});
 store.sendTask(task('first'));
 if(mode==='same-message')for(let i=0;i<8;i++)assert.equal(store.sendTask(task('first')).duplicate,true);
 else store.sendTask(task('second'));
 const claims=(await race(db)).filter(result=>result.id!==null);
 assert.equal(claims.length,1);assert.equal(claims[0].id,'first');assert.equal(store.get('first').attempt,1);
 if(mode!=='same-message'){assert.equal(store.get('second').status,'queued');assert.equal(store.get('second').attempt,0);}
});
