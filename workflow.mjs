import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {AGENTS} from './store.mjs';
import {digest} from './context.mjs';
import {bindContract} from './contracts.mjs';

export function applyWorkflow(task, file, roleName) {
  if(typeof task.goal!=='string' || !task.goal.trim())throw new Error('workflow task goal is required');
  const raw=readFileSync(file,'utf8');
  const role=JSON.parse(raw).roles?.[roleName];
  if (!role || !AGENTS.includes(role.agent) || typeof role.instructions!=='string') throw new Error('invalid workflow role');
  if (task.recipient && task.recipient!==role.agent) throw new Error('recipient conflicts with workflow role');
  return {...task,recipient:role.agent,goal:`${role.instructions}\n\n${task.goal}`,
    workflow:{file,role:roleName,hash:createHash('sha256').update(raw).digest('hex')}};
}

export function compilePlan(plan,{workflowFile}={}) {
  if(typeof plan.project_id!=='string'||!plan.project_id.trim()||!Array.isArray(plan.steps)||!plan.steps.length)throw new Error('project_id and steps are required');
  const steps=new Map();
  for(const step of plan.steps){if(typeof step.id!=='string'||!step.id.trim()||steps.has(step.id))throw new Error('unique step id required');steps.set(step.id,step);}
  const sorted=[],visited=new Set(),visiting=new Set();
  const visit=id=>{if(visited.has(id))return;if(visiting.has(id))throw new Error('dependency cycle');const step=steps.get(id);if(!step)throw new Error(`unknown dependency ${id}`);
    visiting.add(id);for(const dep of step.depends_on ?? [])visit(dep);visiting.delete(id);visited.add(id);sorted.push(step);};
  for(const id of steps.keys())visit(id);
  const hash=digest({plan,workflow:workflowFile?readFileSync(workflowFile,'utf8'):null});
  const declared = sorted.find(step => step.contract);
  const common = bindContract({cwd:plan.contract?plan.cwd:declared?.cwd ?? plan.cwd,
    contract:plan.contract ?? declared?.contract,contract_review_ids:[]}).contract;
  const tasks=sorted.map(({id,workflow_role,depends_on,...step})=>{
    let task={cwd:plan.cwd,sender:plan.sender,...step,contract:step.contract ?? common,message_id:`${plan.project_id}:${id}`,task_id:step.task_id ?? plan.project_id,
      project_id:plan.project_id,depends_on:(depends_on ?? []).map(dep=>`${plan.project_id}:${dep}`),plan:{hash,step:id}};
    if(workflow_role){if(!workflowFile)throw new Error('external workflow file required');task=applyWorkflow(task,workflowFile,workflow_role);}
    task=bindContract(task);
    if(common && task.contract.hash!==common.hash)throw new Error('plan step contract differs from common contract');
    return task;
  });
  checkReviewCoverage(tasks);
  return tasks;
}

function checkReviewCoverage(tasks) {
  const contract = tasks.find(task => task.contract)?.contract;
  if (!contract) return;
  const required = contract.document.review.criteria.filter(c => c.required !== false);
  if (required.some(c => !tasks.some(task => task.contract?.hash === contract.hash
    && (task.chain?.review || task.contract_review_ids.includes(c.id))))) {
    throw new Error('mandatory contract review coverage missing');
  }
}

export function sendPlan(store,tasks) {
  return store.transaction(() => {
    const saved = tasks.map(task => {
      const row = store.sendTask(task);
      if(row.duplicate&&!row.sameContent&&row.message.body.plan?.hash!==task.plan.hash)throw new Error('plan task id collision');
      return row;
    });
    checkReviewCoverage(saved.map(row => row.message.body));
    return saved;
  });
}
