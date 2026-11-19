import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');

export function prepareContext(store,task) {
  const context=(task.context_refs ?? []).map(ref=>{
    const bytes=readFileSync(path.resolve(task.cwd,ref.path)),full=bytes.toString('utf8'),lines=full.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const [start,end]=ref.lines.split('-').map(Number);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end>lines.length)throw new Error(`context lines out of range: ${ref.path} ${ref.lines}`);
    return {...ref,hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),content:lines.slice(start-1,end).join('')};
  });
  const handoffs=(task.handoff_from ?? task.depends_on ?? []).map(id=>{
    const parent=store.get(id);
    if(!store.dependencyReady(parent))throw new Error(`handoff dependency is not ready: ${id}`);
    const reply=parent.root_id?store.get(`${parent.root_id}:final`):store.db.prepare("SELECT message_id FROM messages WHERE reply_to=? AND kind='result' ORDER BY attempt DESC LIMIT 1").get(id);
    const full=reply && store.get(reply.message_id);
    if(!full || full.body.status!=='done' || full.body.current===false)throw new Error(`handoff result is not successful: ${id}`);
    const essential=['status','summary','question','acceptance','criteria','findings','verdict','boundary_review','changed_files','contract_receipt','browser_context','communication_receipt','coalesced_from','reused_artifacts'];
    const result=full.body.delivery?{...full.body.delivery,...Object.fromEntries(essential.filter(key=>Object.hasOwn(full.body,key)).map(key=>[key,full.body[key]]))}:full.body;
    return {message_id:full.message_id,attempt:full.attempt,source_message_id:id,source_attempt:parent.attempt,hash:digest(full.body),result};
  });
  const inherited=handoffs.map(h=>h.result.browser_context).filter(Boolean);
  if(!task.browser_context&&new Set(inherited.map(digest)).size>1)throw new Error('multiple browser contexts: select browser_context explicitly');
  return {...task,context,handoffs,browser_context:task.browser_context ?? inherited[0]};
}
