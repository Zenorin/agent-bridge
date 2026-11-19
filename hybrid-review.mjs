import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { contractHash, receiptFor } from './contracts.mjs';
import { hashFile, pathKey } from './store.mjs';

export const isHybrid = task => task.contract?.document.review.mode === 'hybrid';

const artifactExtensions = new Set(['.pptx', '.docx', '.xlsx', '.pdf', '.png', '.jpg', '.jpeg', '.webp']);
const relativeFile = file => typeof file === 'string' && file.trim() && !path.isAbsolute(file)
  && !/[:\0]/.test(file) && file.split(/[\\/]/).every(part => part && part !== '.' && part !== '..');
const unique = list => [...new Set(list)];
const same = (a,b) => contractHash(a) === contractHash(b);

export function validateHybridReview(doc) {
  // A misspelt mode or a stray check would otherwise silently send every criterion to the model.
  if (doc.review.mode !== 'hybrid') {
    if (doc.review.mode !== undefined) throw new Error('unsupported contract review mode');
    if (doc.review.criteria.some(c => Object.hasOwn(c,'check') || Object.hasOwn(c,'evidence'))) {
      throw new Error('review check and evidence need review.mode "hybrid"');
    }
    return;
  }
  const criteria = doc.review.criteria;
  if (unique(criteria.map(c => c.text)).length !== criteria.length) throw new Error('hybrid review criterion texts must be unique');
  for (const criterion of criteria) {
    if (Object.hasOwn(criterion, 'check')) {
      const { check } = criterion;
      if (!check || !relativeFile(check.path)) throw new Error('invalid hybrid program check path');
      const fields = {
        'file-exists': ['type','path'],
        'file-sha256': ['type','path','expected'],
        'json-equals': ['type','path','key','expected'],
      }[check.type];
      if (!Array.isArray(fields) || !same(Object.keys(check).sort(), [...fields].sort())
          || (check.type === 'file-sha256' && !/^sha256:[a-f0-9]{64}$/i.test(check.expected))
          || (check.type === 'json-equals' && (!Array.isArray(check.key)
            || !check.key.every(k => typeof k === 'string') || check.expected === undefined))) {
        throw new Error('invalid hybrid program check');
      }
    } else if (!Array.isArray(criterion.evidence) || !criterion.evidence.length || !criterion.evidence.every(relativeFile)) {
      throw new Error('hybrid judgment needs evidence file paths');
    }
    const ids = criterion.requirement_ids;
    if (ids !== undefined && (!Array.isArray(ids) || unique(ids).length !== ids.length
        || ids.some(id => !doc.requirements.some(req => req.id === id)))) {
      throw new Error('invalid hybrid requirement IDs');
    }
  }
}

export function validateHybridTask(task) {
  if (!isHybrid(task)) return;
  if (!task.chain?.review) throw new Error('hybrid contract needs chain.review so every criterion is verified');
  if (task.contract_review_ids.length) throw new Error('hybrid implementation must use contract_review_ids: []; the review stage owns the checks');
  const allowed = new Set([...task.file_refs.map(ref => ref.path), ...task.write_files].map(file => pathKey(file,task.cwd)));
  for (const criterion of task.contract.document.review.criteria) {
    for (const file of criterion.check ? [criterion.check.path] : criterion.evidence) {
      if (!allowed.has(pathKey(file,task.cwd))) throw new Error(`hybrid evidence must be declared as a file reference or output: ${file}`);
    }
  }
}

function evidenceFile(cwd, file) {
  const resolved = realpathSync(path.resolve(cwd,file));
  const relative = path.relative(realpathSync(cwd),resolved);
  if (!relativeFile(relative) || !statSync(resolved).isFile()) throw new Error('not a file inside the workspace');
  return resolved;
}

export function hybridScope(task, unavailable = []) {
  const { document } = task.contract;
  const program = document.review.criteria.filter(c => c.check);
  const skipped = new Set(unavailable.map(c => c.criterion_id));
  const judgment = document.review.criteria.filter(c => !c.check && !skipped.has(c.id));
  const localTexts = new Set(document.review.criteria.filter(c => c.check || skipped.has(c.id)).map(c => c.text));
  const acceptance = task.acceptance.filter(text => !localTexts.has(text));
  const evidence = unique(judgment.flatMap(c => c.evidence));
  const selected = new Set(judgment.flatMap(c => c.requirement_ids ?? document.requirements.map(r => r.id)));
  const requirements = document.requirements.filter(r => selected.has(r.id));
  const projected = { ...task, acceptance,
    contract: { hash:task.contract.hash, document:{objective:document.objective,requirements,review:{criteria:judgment}} },
    contract_environment: { environment_hash:task.contract_environment.environment_hash },
    contract_review_ids: judgment.map(c => c.id) };
  return { program, judgment, evidence, projected };
}

// Preserve independent boundary review when code, configuration or an unexpected path changed.
export function needsBoundaryReview(root, implementation, changed) {
  if (!['reported','observed','outside_scope'].every(key => Array.isArray(changed?.[key])) || changed.outside_scope.length) return true;
  const files = [...changed.reported,...changed.observed];
  if (implementation.sandbox === 'read-only') return files.length > 0;
  const declared = root.contract.document.review.criteria.flatMap(c => c.check ? [c.check.path] : c.evidence);
  const artifacts = new Set(declared.filter(file => artifactExtensions.has(path.extname(file).toLowerCase())).map(file => pathKey(file,root.cwd)));
  const writes = root.write_files.map(file => pathKey(file,root.cwd));
  return !writes.length || [...writes,...files.map(file => pathKey(file,root.cwd))].some(file => !artifacts.has(file) || !writes.includes(file));
}

function checkProgram(task, criterion) {
  const { check } = criterion;
  try {
    const file = evidenceFile(task.cwd,check.path);
    const hash = hashFile(task.cwd,file);
    let passed = check.type === 'file-exists' && hash !== null;
    if (check.type === 'file-sha256') passed = hash?.toLowerCase() === check.expected.toLowerCase();
    if (check.type === 'json-equals') {
      const document = JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
      const value = check.key.reduce((item,key) => item != null && Object.hasOwn(item,key) ? item[key] : undefined,document);
      passed = value !== undefined && same(value,check.expected);
    }
    return { criterion_id:criterion.id, result:passed?'pass':'fail',
      evidence:JSON.stringify({type:check.type,path:check.path,hash,...(check.key?{key:check.key}:{})}) };
  } catch (error) {
    return { criterion_id:criterion.id, result:'fail', evidence:`${check.type} ${check.path}: ${error.code ?? error.name}` };
  }
}

export function programReview(task,scope) {
  const checks = scope.program.map(c => checkProgram(task,c));
  const unavailable = scope.judgment.flatMap(c => {
    const missing = c.evidence.filter(file => {
      try { evidenceFile(task.cwd,file); return false; } catch { return true; }
    });
    return missing.length ? [{criterion_id:c.id,result:'unverified',evidence:`Evidence unavailable: ${missing.join(', ')}`}] : [];
  });
  return { checks, unavailable };
}

export function localReview(task, scope, observed) {
  const results = [...observed.checks,...observed.unavailable];
  const criterion = id => task.contract.document.review.criteria.find(c => c.id === id);
  const failures = results.filter(r => r.result !== 'pass'
    && (criterion(r.criterion_id).required !== false || task.acceptance.includes(criterion(r.criterion_id).text)));
  if (!failures.length && (scope.judgment.length || scope.projected.acceptance.length || task.review_boundary)) return null;
  const criteria = results.map(r => ({criterion:criterion(r.criterion_id).text,
    result:r.result,evidence:r.evidence}));
  return { status:'done', verdict:failures.length?'reject':'pass', summary:failures.length?'Required review failed':'Program review passed',
    criteria, findings:failures.map(r => {
      const item = criterion(r.criterion_id);
      return {criterion:item.text,problem:r.evidence,required_change:r.result === 'unverified'
        ? 'Produce the listed evidence files so the reviewer can judge this criterion.' : 'Correct the artifact and rerun the check.',
        files:item.check?[item.check.path]:item.evidence};
    }),
    boundary_review:{paths:'unchanged',exec:'unchanged',auth_permissions:'unchanged',
      notes:failures.length?'No approval was issued.':'No code or configuration change required independent review.'},
    contract_receipt:receiptFor(task,task.contract_environment,criteria) };
}

export function mergeHybridReview(task, observed, reply) {
  const receipts = new Map(reply.contract_receipt.review.map(r => [r.criterion_id,r]));
  for (const entry of [...observed.checks,...observed.unavailable]) {
    receipts.set(entry.criterion_id,entry);
    const criterion = task.contract.document.review.criteria.find(c => c.id === entry.criterion_id).text;
    reply.criteria = reply.criteria.filter(check => check.criterion !== criterion);
    reply.criteria.push({criterion,result:entry.result,evidence:entry.evidence});
  }
  const receipt = receiptFor(task,task.contract_environment,reply.criteria);
  receipt.review = task.contract_review_ids.map(id => receipts.get(id));
  return {...reply,contract_receipt:receipt};
}

export function verifyHybridPrograms(task, reply) {
  const program = task.contract.document.review.criteria.filter(c => c.check);
  for (const criterion of program) {
    const submitted = reply.contract_receipt?.review.find(r => r.criterion_id === criterion.id);
    if (!same(submitted,checkProgram(task,criterion))) throw new Error(`hybrid program evidence changed: ${criterion.id}`);
  }
}
