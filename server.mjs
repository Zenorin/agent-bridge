import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadProfiles, resolveProfile, profileSummary, saveProfiles, taskPacket, DEFAULT_PROFILES } from './profiles.mjs';
import { openProfileRuntime } from './codex-runner.mjs';
import { runBridgeWorkers } from './claude-runner.mjs';
import { listWorktrees, createWorktree, setWorktreeLocked, verifyWorktree, resolveInsideWorktree } from './worktrees.mjs';
import { AGENTS, staleInputs } from './store.mjs';
import { classifyFailure } from './failures.mjs';

const UI=fileURLToPath(new URL('./ui/',import.meta.url));
const portableCopy=JSON.parse(readFileSync(new URL('./distribution-text.ko.json',import.meta.url),'utf8'));

export async function startDashboard({store,repo=process.cwd(),profilesPath=DEFAULT_PROFILES,port=0,allowWrite=false,workers=1,workerOptions={}}) {
  if(!Number.isSafeInteger(workers) || workers<1) throw new Error('workers must be a positive integer');
  const token=randomBytes(32).toString('hex');
  const agents=workerOptions.agents ?? AGENTS;
  let origin,controller=null,running=null,runnerError=null;
  const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
  const tasks=()=>store.db.prepare("SELECT message_id FROM messages WHERE kind='task' ORDER BY created_at DESC,rowid DESC").all().map(({message_id})=>store.get(message_id));
  const state=()=>({available_agents:agents,availability_notice:agents.length?null:portableCopy.noAgents,tasks:tasks().map(t=>({...t,failure:classifyFailure(t.status,t.status_reason),attempt_usage:store.listUsage(t.message_id),runtime:store.listRuntime(t.message_id)})),runner:{running:!!controller,workers,error:runnerError,allow_write:allowWrite}});
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON body required');
    let raw='';
    for await(const chunk of req) {raw+=chunk;if(Buffer.byteLength(raw)>1024*1024) throw new Error('request body too large');}
    const value=JSON.parse(raw || '{}');
    if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('object body required');
    return value;
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if(req.headers.host!==new URL(origin).host || (req.headers.origin && req.headers.origin!==origin)) return send(res,403,{error:'origin rejected'});
    const url=new URL(req.url,origin); const route=url.pathname;
    try {
      if(req.method==='GET') {
        if(route==='/api/bootstrap') return send(res,200,{token,repo,profiles:profileSummary(loadProfiles(profilesPath)),...state()});
        if(route==='/api/state') return send(res,200,state());
        if(route==='/api/worktrees') return send(res,200,{worktrees:listWorktrees(repo)});
        if(route.startsWith('/api/tasks/')) {
          const task=store.get(decodeURIComponent(route.slice('/api/tasks/'.length)));
          if(!task || task.kind!=='task') return send(res,404,{error:'task not found'});
          const replies=store.listTasks({taskId:task.task_id}).filter(r=>r.reply_to===task.message_id && r.kind!=='task')
            .map(r=>({...r,current:r.attempt===task.attempt && ['ready','blocked'].includes(task.status),stale_inputs:staleInputs(r)}));
          return send(res,200,{...task,failure:classifyFailure(task.status,task.status_reason),replies,attempt_usage:store.listUsage(task.message_id),runtime:store.listRuntime(task.message_id)});
        }
        const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/copy.ko.json':'copy.ko.json'};
        if(!Object.hasOwn(files,route)) return send(res,404,{error:'not found'});
        const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[path.extname(files[route])];
        res.writeHead(200,{'content-type':`${type}; charset=utf-8`,'cache-control':'no-store'});
        return res.end(readFileSync(path.join(UI,files[route])));
      }
      if(req.method!=='POST') return send(res,405,{error:'method not allowed'});
      if(req.headers['x-bridge-token']!==token) return send(res,403,{error:'request token required'});
      const data=await body(req);
      if(route==='/api/tasks' || route==='/api/preview') {
        const profile=resolveProfile(loadProfiles(profilesPath),data.profile ?? 'standard');
        if(route==='/api/preview') return send(res,200,{profile:profile.id,packet:taskPacket(data,profile),omitted_fields:Object.keys(data).filter(k=>!Object.hasOwn(taskPacket(data,profile),k))});
        const task={...data,message_id:data.message_id || `msg-${randomUUID()}`,task_id:data.task_id || (data.reply_to && store.get(data.reply_to)?.task_id) || `task-${randomUUID().slice(0,8)}`,profile:profile.id};
        if(!agents.includes(task.recipient))throw new Error(portableCopy.agentUnavailable+' '+task.recipient);
        if(task.chain?.review && (!agents.includes('codex') || !agents.includes('claude-code')))throw new Error(portableCopy.reviewUnavailable);
        task.cwd=data.worktree ? verifyWorktree(repo,data.worktree) : resolveInsideWorktree(repo,data.cwd ?? repo);
        return send(res,200,store.sendTask(task));
      }
      const action=route.match(/^\/api\/tasks\/([^/]+)\/(cancel|requeue|answer)$/);
      if(action) {
        const id=decodeURIComponent(action[1]); const task=store.get(id);
        if(!task || task.kind!=='task') return send(res,404,{error:'task not found'});
        if(action[2]==='cancel') return send(res,200,{status:store.requestCancel(id)});
        if(action[2]==='requeue') return send(res,200,store.requeue(id));
        if(task.status!=='blocked' || task.status_reason!=='question' || typeof data.answer!=='string' || !data.answer.trim()) throw new Error('active question and answer required');
        const questions=store.listTasks({taskId:task.task_id}).filter(r=>r.reply_to===id && r.kind==='question');
        const question=questions.at(-1); if(!question) throw new Error('question not found');
        const {pending_review,findings,implementation,current,followup_request_hash,followup_key,...answerTask}=task.body;
        const out=store.sendTask({...answerTask,message_id:`msg-${randomUUID()}`,reply_to:question.message_id,thread_id:task.thread_id,goal:data.answer,file_refs:task.body.file_refs.map(({hash,...r})=>r)});
        store.ackReplies(question.recipient,[question.message_id]); return send(res,200,out);
      }
      if(route==='/api/ack') {store.ackReplies(data.recipient,[data.message_id]);return send(res,200,{acknowledged:true});}
      if(route==='/api/profiles') {
        // Adapter commands run local programs; they change only by editing the file, never through this API.
        if(JSON.stringify(data.config?.adapters ?? {})!==JSON.stringify(loadProfiles(profilesPath).adapters ?? {})) throw new Error('adapters cannot be changed from the dashboard');
        saveProfiles(profilesPath,data.config,data.hash);return send(res,200,profileSummary(loadProfiles(profilesPath)));}
      if(route==='/api/runtime/inspect') {
        const profile=resolveProfile(loadProfiles(profilesPath),data.profile ?? 'standard');
        const result=await openProfileRuntime({cwd:repo,profile,...workerOptions});
        try {return send(res,200,result.receipt);} finally {await result.client.close();}
      }
      if(route==='/api/runner/start') {
        if(controller) return send(res,200,{running:true});
        if(!agents.length)throw new Error(portableCopy.noAgents);
        controller=new AbortController(); runnerError=null;
        running=runBridgeWorkers(store,{...workerOptions,workers,profilesPath,allowWrite,signal:controller.signal})
          .catch(e=>{runnerError=e.message;}).finally(()=>{controller=null;});
        return send(res,200,{running:true});
      }
      if(route==='/api/runner/stop') {controller?.abort();return send(res,200,{stopping:!!controller});}
      if(route==='/api/worktrees') return send(res,200,createWorktree(repo,data));
      if(route==='/api/worktrees/lock') {
        if(typeof data.locked!=='boolean') throw new Error('locked must be boolean');
        return send(res,200,setWorktreeLocked(repo,data.path,data.locked));
      }
      return send(res,404,{error:'not found'});
    } catch(error) {send(res,400,{error:error.message});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  return {url:origin,server,async close(){controller?.abort();await running;await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
