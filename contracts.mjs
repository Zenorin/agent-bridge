import {readFileSync,lstatSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {hashFile,pathKey} from './store.mjs';
import {validateHybridReview} from './hybrid-review.mjs';

const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const contractHash=v=>createHash('sha256').update(JSON.stringify(stable(v)) ?? 'undefined').digest('hex');
const text=v=>typeof v==='string'&&v.trim().length>0;
const same=(a,b)=>contractHash(a)===contractHash(b);
function nestedLink(file){const stat=lstatSync(file);return stat.isSymbolicLink()||(stat.isDirectory()&&readdirSync(file).some(name=>nestedLink(path.join(file,name))));}
function records(value,name,fields){
  if(!Array.isArray(value))throw new Error(`contract ${name} must be an array`);
  const ids=new Set();for(const item of value){if(!item||fields.some(key=>!text(item[key]))||ids.has(item.id))throw new Error(`invalid contract ${name}`);ids.add(item.id);}
}
function validateDocument(doc){
  if(!doc||!['id','version','objective'].every(key=>text(doc[key])))throw new Error('contract id/version/objective required');
  records(doc.requirements,'requirements',['id','text']);records(doc.review?.criteria,'review criteria',['id','text','method']);
  if(!doc.review.criteria.length)throw new Error('contract review criteria required');
  for(const criterion of doc.review.criteria)if(criterion.required!==undefined&&typeof criterion.required!=='boolean')throw new Error('invalid required review flag');
  for(const ref of [...(doc.sources ?? []),...(doc.environment?.files ?? []),...(doc.environment?.tools ?? [])]){
    if(!ref||!text(ref.path)||!/^sha256:[a-f0-9]{64}$/i.test(ref.hash))throw new Error('contract file path/hash required');
  }
  for(const key of ['node','platform','arch'])if(doc.environment?.[key]!==undefined&&!text(doc.environment[key]))throw new Error('invalid contract host requirement');
  if(doc.environment && Object.keys(doc.environment).some(key=>!['node','platform','arch','files','tools'].includes(key)))throw new Error('unsupported contract environment requirement');
  validateHybridReview(doc);
  return doc;
}

export function bindContract(task){
  if(!task.contract)return task;
  let sealed;
  if(task.contract.document){
    sealed=structuredClone(task.contract);validateDocument(sealed.document);
    if(sealed.hash!==contractHash(sealed.document)||!text(sealed.source?.path)||!text(sealed.source?.hash))throw new Error('sealed contract mismatch');
  }else{
    const file=typeof task.contract==='string'?task.contract:task.contract.file;
    if(!text(file))throw new Error('external contract file required');
    const full=path.resolve(task.cwd,file),bytes=readFileSync(full);let document;
    try{document=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{throw new Error('invalid contract JSON');}
    validateDocument(document);sealed={document,hash:contractHash(document),source:{path:full,hash:'sha256:'+createHash('sha256').update(bytes).digest('hex')}};
  }
  // Each step names the criteria it checks: a default of "all" failed every step that could not check one of them.
  const criteria=sealed.document.review.criteria,ids=task.contract_review_ids;
  if(ids===undefined||ids===null)throw new Error('contract_review_ids required: list the review criterion IDs this step checks, or [] for none');
  if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!criteria.some(c=>c.id===id)))throw new Error('invalid contract review selection');
  const acceptance=[...(task.acceptance ?? [])];for(const c of criteria.filter(c=>ids.includes(c.id)&&c.required!==false))if(!acceptance.includes(c.text))acceptance.push(c.text);
  const file_refs=(task.file_refs ?? []).map(ref=>typeof ref==='string'?{path:ref}:{...ref});
  for(const ref of [sealed.source,...(sealed.document.sources ?? []),...(sealed.document.environment?.files ?? []),...(sealed.document.environment?.tools ?? [])]){
    const old=file_refs.find(file=>pathKey(file.path,task.cwd)===pathKey(ref.path,task.cwd));
    if(old?.hash&&old.hash.toLowerCase()!==ref.hash.toLowerCase())throw new Error('contract source hash conflicts with task reference');
    if(!old)file_refs.push({path:ref.path,hash:ref.hash});else old.hash=ref.hash;
  }
  return {...task,acceptance,file_refs,contract:sealed,contract_review_ids:[...ids]};
}

export function inspectContract(task){
  if(!task.contract)return null;
  const {document,hash,source}=task.contract;
  if(hash!==contractHash(validateDocument(document)))throw new Error('contract document changed');
  let sourceDocument;try{sourceDocument=JSON.parse(readFileSync(source.path,'utf8').replace(/^\uFEFF/,''));}catch{throw new Error('invalid contract source JSON');}
  if(!same(sourceDocument,document))throw new Error('contract source document mismatch');
  const observed={host:{node:process.version,platform:process.platform,arch:process.arch},files:{},tools:{}};
  for(const key of ['node','platform','arch'])if(document.environment?.[key]&&document.environment[key]!==observed.host[key])throw new Error(`contract environment mismatch: ${key}`);
  for(const [kind,refs] of [['files',[source,...(document.sources ?? []),...(document.environment?.files ?? [])]],['tools',document.environment?.tools ?? []]]){
    for(const ref of refs){const actual=hashFile(task.cwd,ref.path);if(!actual||actual.toLowerCase()!==ref.hash.toLowerCase())throw new Error(`contract source/environment mismatch: ${ref.path}`);
      if(nestedLink(pathKey(ref.path,task.cwd)))throw new Error('contract directory contains linked inputs; declare the resolved input files explicitly');
      observed[kind][pathKey(ref.path,task.cwd)]=actual;}
  }
  // Source identity is tracked separately; environment identity covers the shared host and declared toolchain.
  const environment={host:observed.host,files:Object.fromEntries((document.environment?.files ?? []).map(ref=>[pathKey(ref.path,task.cwd),observed.files[pathKey(ref.path,task.cwd)]])),tools:observed.tools};
  return {verified:true,contract_hash:hash,environment_hash:contractHash(environment),observed};
}

export function wirePacket(task){
  return {contract:structuredClone(task.contract),contract_review_ids:[...task.contract_review_ids],
    contract_environment:structuredClone(task.contract_environment),
    step:{goal:task.goal,acceptance:[...task.acceptance],sandbox:task.sandbox,write_files:task.write_files ?? []}};
}

export function verifyProgramEnvironment(task,program){
  const tools=task.contract?.document.environment?.tools ?? [];
  if(!tools.length)return null;
  const declared=[...tools,...(task.contract.document.environment.files ?? []),...(task.contract.document.sources ?? [])];
  if(!tools.some(tool=>pathKey(tool.path,task.cwd)===pathKey(program.adapter.command,task.cwd)))throw new Error('program executable differs from common toolchain');
  for(const [file,hash] of Object.entries(program.code_hashes))if(!declared.some(ref=>pathKey(ref.path,task.cwd)===pathKey(file,task.cwd)&&ref.hash.toLowerCase()===hash?.toLowerCase()))throw new Error('program code differs from declared common toolchain');
  return {verified:true,command:program.adapter.command,code_hashes:program.code_hashes};
}

export function verifyWire(task,wire){
  if(!task.contract)return null;
  let packet=wire;
  if(typeof wire==='string'){
    const line=wire.split('\n').find(line=>line.startsWith('CONTRACT_JSON:'));
    try{packet=line?JSON.parse(line.slice('CONTRACT_JSON:'.length)):JSON.parse(wire);}catch{throw new Error('contract payload missing or invalid');}
  }
  const expected=wirePacket(task);
  for(const key of ['contract','contract_review_ids','contract_environment','step'])if(!same(packet?.[key],expected[key]))throw new Error(`contract ${key==='step'?'step':'payload'} mismatch: ${key}`);
  for(const key of ['goal','acceptance','sandbox','write_files'])if(Object.hasOwn(packet,key)&&!same(packet[key],expected.step[key]))throw new Error(`contract step field mismatch: ${key}`);
  return {verified:true,contract_hash:task.contract.hash,environment_hash:task.contract_environment?.environment_hash ?? null,
    requirement_ids:task.contract.document.requirements.map(r=>r.id),review_ids:task.contract_review_ids,
    step_hash:contractHash(expected.step),wire_hash:contractHash(wire)};
}

export function responseSchema(base,task){
  if(!task.contract)return base;
  const string={type:'string'};
  return {...base,required:[...base.required,'contract_receipt'],properties:{...base.properties,contract_receipt:{type:'object',additionalProperties:false,
    required:['contract_hash','environment_hash','requirement_ids','review'],properties:{contract_hash:string,environment_hash:string,
      requirement_ids:{type:'array',items:string},review:{type:'array',items:{type:'object',additionalProperties:false,required:['criterion_id','result','evidence'],
        properties:{criterion_id:string,result:{type:'string',enum:['pass','fail','unverified']},evidence:string}}}}}}};
}

export const contractInstructions='공통 계약 원문·요구사항 ID·검수 기준을 유지한다. contract_receipt에 제공된 contract_hash와 environment_hash, 모든 requirement_ids를 그대로 회신한다. review에는 이번 단계 contract_review_ids 각각의 criterion_id/result(pass|fail|unverified)/evidence를 기록한다. 수행하지 못한 검수는 unverified로 표시하고 성공을 주장하지 않는다.';

export function receiptFor(task,environment,checks){
  return {contract_hash:task.contract.hash,environment_hash:environment.environment_hash,requirement_ids:task.contract.document.requirements.map(r=>r.id),
    review:task.contract_review_ids.map(id=>{const criterion=task.contract.document.review.criteria.find(c=>c.id===id),check=checks.find(check=>check.criterion===criterion.text);
      return {criterion_id:id,result:check?.result ?? 'unverified',evidence:check?.evidence ?? '검수 근거 없음'};})};
}

export function validateContractReply(task,reply,environment){
  if(!task.contract)return;
  if(!environment?.verified||environment.contract_hash!==task.contract.hash)throw new Error('contract environment preflight missing');
  const receipt=reply?.contract_receipt;
  if(!receipt||receipt.contract_hash!==task.contract.hash||receipt.environment_hash!==environment.environment_hash)throw new Error('contract acknowledgement hash mismatch');
  const ids=task.contract.document.requirements.map(r=>r.id);
  if(!Array.isArray(receipt.requirement_ids)||!same([...receipt.requirement_ids].sort(),[...ids].sort()))throw new Error('contract requirement acknowledgement mismatch');
  if(!Array.isArray(receipt.review)||!same(receipt.review.map(c=>c?.criterion_id).sort(),[...task.contract_review_ids].sort()))throw new Error('contract review acknowledgement mismatch');
  for(const review of receipt.review)if(!['pass','fail','unverified'].includes(review.result)||!text(review.evidence))throw new Error('contract review evidence missing');
  const rejectedReview=task.role==='review'&&reply.verdict==='reject';
  const checks=reply.acceptance ?? reply.criteria;
  const missingReview=receipt.review.some(r=>r.result!=='pass'&&task.contract.document.review.criteria.find(c=>c.id===r.criterion_id).required!==false);
  const missingChecks=!Array.isArray(checks)||task.acceptance.some(criterion=>!checks.some(c=>c?.criterion===criterion&&c.result==='pass'&&text(c.evidence)));
  if(!rejectedReview&&reply.status==='done'&&(missingReview||missingChecks)){
    reply.status='failed';if(reply.delivery)reply.delivery.status='failed';return 'contract required checks not verified';
  }
}
