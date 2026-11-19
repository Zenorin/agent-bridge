const $ = (id) => document.getElementById(id);
const copy = await fetch('/copy.ko.json').then(r => r.json());
let token, repo, profiles, state, selected, detailSignature, activeTab = 'tasks', refreshing = false;
const t = key => copy[key] ?? key;
const json = value => JSON.stringify(value, null, 2);
const lines = value => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = error ? 'error' : 'success';
  if($('task-dialog').open) {
    let feedback=$('task-feedback');
    if(!feedback) {feedback=el('p');feedback.id='task-feedback';feedback.setAttribute('role','alert');$('task-form').prepend(feedback);}
    feedback.textContent=text;feedback.className=error?'error':'success';
  }
}
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : {method:'POST', headers:{'content-type':'application/json','x-bridge-token':token}, body:json(data)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? response.statusText);
  return value;
}
function action(button, fn) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await fn(); } catch (e) { notice(`${t('error')}: ${e.message}`, true); }
    finally { button.disabled = button.id==='start-runner'?!!state?.runner.running:button.id==='stop-runner'?!state?.runner.running:false; }
  });
  return button;
}
function button(label, fn, className) { return action(el('button', t(label), className), fn); }
function field(label, value) {
  const box = el('div', null, 'fact');
  box.append(el('span', t(label), 'muted'), el('div', value ?? '—'));
  return box;
}
function raw(label, value) {
  const d = el('details'); d.append(el('summary', t(label)), el('pre', json(value), 'code')); return d;
}
function badge(status) { return el('span', t(status), `badge ${status}`); }
function setOptions(id, values) {
  const before = $(id).value;
  $(id).replaceChildren(...values.map(v => {const o=el('option',v);o.value=v;return o;}));
  if (values.includes(before)) $(id).value=before;
}
function renderProfiles() {
  const names=profiles.profiles.map(p=>p.id);
  setOptions('task-profile',names); setOptions('profile-select',names);
  $('profiles-json').value=json(profiles.config);
  showProfile();
}
function showProfile() {
  const p=profiles.profiles.find(p=>p.id===$('profile-select').value);
  $('runtime-result').replaceChildren(field('requiredPlugins',profiles.config.required_plugins.join(', ') || t('none')),
    field('pluginSelection',p.plugins==='*'?'*':p.plugins.join(', ')),
    field('inputFields',['goal','acceptance','write_files','sandbox',...p.input_fields].filter((v,i,a)=>a.indexOf(v)===i).join(', ')),
    field('outputFields',['status','question','acceptance','changed_files',...p.output_fields].filter((v,i,a)=>a.indexOf(v)===i).join(', ')),
    raw('adapters',profiles.config.adapters ?? {}));
}
function renderState() {
  const agents=state.available_agents ?? ['codex','claude-code','gemini'];
  setOptions('task-recipient',agents);
  if(agents.length>1)setOptions('task-sender',agents);
  if($('task-sender').value===$('task-recipient').value)$('task-sender').value=[...$('task-sender').options].map(option=>option.value).find(agent=>agent!==$('task-recipient').value) ?? '';
  $('new-task').disabled=!agents.length;
  if(state.availability_notice)notice(state.availability_notice);
  $('runner-state').textContent=`${t(state.runner.running?'runnerRunning':'runnerStopped')} · ${state.runner.workers}`;
  $('write-mode').textContent=t(state.runner.allow_write?'writeAllowed':'readOnlyRunner');
  $('start-runner').disabled=state.runner.running || !agents.length;
  $('stop-runner').disabled=!state.runner.running;
  if(state.runner.error) notice(`${t('workerError')} ${state.runner.error}`,true);
  const tasks=state.tasks.filter(task=>!$('status-filter').value || task.status===$('status-filter').value);
  $('task-list').replaceChildren(...tasks.map(task=>{
    const b=button('',async()=>{selected=task.message_id;detailSignature=null;renderState();await refreshDetail();},`task-card${selected===task.message_id?' selected':''}`);
    b.setAttribute('aria-pressed',String(selected===task.message_id));
    const row=el('div',null,'task-meta'); row.append(badge(task.status),el('span',task.body.profile ?? 'standard','muted'));
    b.append(row,el('strong',task.body.goal),el('span',`${task.sender} → ${task.recipient}`,'muted'),el('span',`${task.task_id} · ${t('attempt')} ${task.attempt}`,'muted'));
    return b;
  }));
  if(!tasks.length) $('task-list').append(el('p',t('noTasks'),'empty'));
}
async function refreshDetail(force=false) {
  if(!selected) return;
  const id=selected;
  const task=await api(`/api/tasks/${encodeURIComponent(id)}`);
  if(selected!==id) return;
  const signature=json(task);
  if(!force && (signature===detailSignature || ($('task-detail').contains(document.activeElement) && document.activeElement.matches('input,textarea,select')))) return;
  detailSignature=signature;
  const root=$('task-detail'); root.replaceChildren();
  root.append(badge(task.status),el('h2',task.body.goal));
  const facts=el('div',null,'facts');
  facts.append(field('profile',task.body.profile ?? 'standard'),field('attempt',task.attempt),field('cwd',task.body.cwd),field('lastSeen',task.heartbeat_at ?? task.updated_at));root.append(facts);
  if(task.status_reason) root.append(el('p',task.status_reason,'reason'));
  if(task.failure) root.append(el('p',`${t('failureKind_'+task.failure.kind)} · ${t('failureRun_'+task.failure.execution)}`,'muted'));
  const recovery=task.recovery?.at(-1);
  if(recovery) root.append(el('p',recovery.action==='retry'?`${t('recoveryRetry')} ${new Date(recovery.retry_at).toLocaleString()} (${recovery.retry}/${recovery.max})`
    :recovery.action==='fallback'?`${t('recoveryFallback')} ${recovery.from} → ${recovery.to}`:`${t('recoveryStay')} ${t('recoveryStay_'+recovery.code)}`,'muted'));
  const actions=el('div',null,'actions');
  for(const op of task.status==='blocked'?['requeue']:['queued','working'].includes(task.status)?['cancel']:[]) {
    actions.append(button(op,async()=>{await api(`/api/tasks/${encodeURIComponent(id)}/${op}`,{});await refresh(true);}));
  }
  root.append(actions,raw('acceptance',task.body.acceptance),raw('usage',task.attempt_usage.length?task.attempt_usage:t('noUsage')));
  const current=task.replies.filter(r=>r.current);
  for(const reply of current) {
    const section=el('section',null,'result');section.append(el('h3',t(reply.kind==='question'?'question':'summary')),el('p',reply.body.question ?? reply.body.summary ?? t('noResults')));
    if(reply.stale_inputs.length) section.append(el('p',`${t('staleResult')} ${reply.stale_inputs.join(', ')}`,'error'));
    section.append(raw('evidence',reply.body.acceptance),raw('changedFiles',reply.body.changed_files));
    if(reply.delivered_at) section.append(badge('received'));
    else section.append(el('p',t('ackHelp'),'muted'),button('acknowledge',async()=>{await api('/api/ack',{message_id:reply.message_id,recipient:reply.recipient});await refreshDetail(true);}));
    section.append(raw('outputPreview',reply.body.delivery ?? reply.body),raw('sourceDetails',reply.body));root.append(section);
  }
  if(task.status==='blocked' && task.status_reason==='question') {
    const form=el('form');const label=el('label',t('answer'));label.htmlFor='answer-input';
    const input=el('textarea');input.id='answer-input';input.required=true;
    const send=el('button',t('sendAnswer'),'primary');send.type='submit';form.append(label,input,send);
    form.addEventListener('submit',async e=>{e.preventDefault();send.disabled=true;try {const result=await api(`/api/tasks/${encodeURIComponent(id)}/answer`,{answer:input.value});selected=result.message.message_id;detailSignature=null;await refresh(true);}catch(e){notice(e.message,true);}finally{send.disabled=false;}});root.append(form);
  }
  root.append(raw('profileReceipt',task.runtime),raw('history',task.replies),raw('sourceDetails',task.body));
}
async function refresh(force=false) {
  if(refreshing) return;
  refreshing=true;
  try {
    state=await api('/api/state');renderState();
    if(activeTab==='tasks') await refreshDetail(force);
    $('connection').textContent=`${t('updated')} ${new Date().toLocaleTimeString()}`;
  } catch(e) { $('connection').textContent=t('connectionLost');if(force) notice(e.message,true); }
  finally {refreshing=false;}
}
async function showWorktrees() {
  $('worktree-list').textContent=t('loading');
  try {
    const {worktrees}=await api('/api/worktrees');
    $('worktree-list').replaceChildren(...worktrees.map(w=>{
      const card=el('article',null,'worktree-card');
      card.append(el('h3',w.branch ?? w.head?.slice(0,10)),el('p',w.path,'code'),badge(w.error?'unknown':w.dirty?'dirty':'clean'));
      if(w.locked) card.append(badge('locked'));
      const actions=el('div',null,'actions');
      actions.append(button('useWorktree',()=>openTask(w.path)),button(w.locked?'unlock':'lock',async()=>{await api('/api/worktrees/lock',{path:w.path,locked:!w.locked});await showWorktrees();}));
      card.append(actions);return card;
    }));
    if(!worktrees.length) $('worktree-list').append(el('p',t('noWorktrees')));
  } catch(e) {$('worktree-list').textContent=`${t('loadError')} ${e.message}`;}
}
function openTask(cwd=repo) {
  $('task-feedback')?.remove();
  $('task-cwd').value=cwd;$('packet-preview').hidden=true;$('task-dialog').showModal();$('task-goal').focus();
}
function taskInput() {
  const task={goal:$('task-goal').value,acceptance:lines($('task-acceptance').value),profile:$('task-profile').value,cwd:$('task-cwd').value,
    file_refs:lines($('task-files').value),write_files:lines($('task-writes').value),sender:$('task-sender').value,recipient:$('task-recipient').value,sandbox:$('task-sandbox').value};
  for(const [key,id] of [['model','task-model'],['effort','task-effort'],['thread_id','task-thread']]) if($(id).value) task[key]=$(id).value;
  return task;
}
for(const nav of document.querySelectorAll('[data-tab]')) action(nav,async()=>{
  activeTab=nav.dataset.tab;
  for(const n of document.querySelectorAll('[data-tab]')) n.setAttribute('aria-current',String(n===nav));
  for(const name of ['tasks','worktrees','profiles']) $(`tab-${name}`).hidden=name!==activeTab;
  $('page-title').textContent=t(activeTab);
  if(activeTab==='worktrees') await showWorktrees();
  if(activeTab==='tasks') await refresh();
});
action($('refresh'),async()=>{await refresh(true);if(activeTab==='worktrees') await showWorktrees();});
action($('new-task'),()=>openTask());
action($('close-task'),()=>$('task-dialog').close());
action($('preview-task'),async()=>{const preview=await api('/api/preview',taskInput());$('packet-preview').textContent=json(preview);$('packet-preview').hidden=false;});
action($('start-runner'),async()=>{await api('/api/runner/start',{});await refresh();});
action($('stop-runner'),async()=>{await api('/api/runner/stop',{});await refresh();});
action($('inspect-runtime'),async()=>{
  $('runtime-result').textContent=t('loading');
  const receipt=await api('/api/runtime/inspect',{profile:$('profile-select').value});
  $('runtime-result').replaceChildren(el('p',t('runtimeInspected'),'success'),raw('profileReceipt',receipt));
});
$('status-filter').addEventListener('change',renderState);
$('profile-select').addEventListener('change',showProfile);
function formAction(id,fn) {
  $(id).addEventListener('submit',async e=>{
    e.preventDefault();const b=e.submitter;b.disabled=true;
    try {await fn();} catch(e){notice(`${t('error')}: ${e.message}`,true);}
    finally{b.disabled=false;}
  });
}
formAction('task-form',async()=>{
  const result=await api('/api/tasks',taskInput());selected=result.message.message_id;detailSignature=null;
  $('task-dialog').close();$('task-form').reset();notice(t('taskSubmitted'));await refresh(true);
});
formAction('worktree-form',async()=>{await api('/api/worktrees',{name:$('worktree-name').value,base:$('worktree-base').value || 'HEAD'});notice(t('created'));await showWorktrees();});
formAction('profiles-form',async()=>{
  profiles=await api('/api/profiles',{config:JSON.parse($('profiles-json').value),hash:profiles.hash});renderProfiles();notice(t('saved'));
});
for(const id of ['task-sender','task-recipient','task-effort']) for(const option of $(id).options) option.textContent=option.value || '—';
try {
  const boot=await api('/api/bootstrap');({token,repo,profiles}=boot);state=boot;
  $('repo-path').textContent=repo;renderProfiles();renderState();
  document.querySelector('[data-tab="tasks"]').setAttribute('aria-current','true');
  await refresh();setInterval(()=>{if(!document.hidden) void refresh();},3000);
} catch(e) {notice(`${t('loadError')} ${e.message}`,true);}
