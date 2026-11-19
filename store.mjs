// Work queue shared by Claude Code and Codex. Plain SQLite; this module never calls a model.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {aggregateUsage,zeroUsage} from './usage.mjs';
import {normaliseBrowserContext} from './communication.mjs';
import {bindContract,inspectContract,validateContractReply,wirePacket,verifyWire} from './contracts.mjs';
import {isHybrid,validateHybridTask,verifyHybridPrograms} from './hybrid-review.mjs';
import { normaliseChain, normaliseReview, reviewTask, reworkTask, nextStep, finalReply } from "./chain.mjs";

const { DatabaseSync } = await importSqlite();

export const AGENTS = ["codex", "claude-code", "gemini"];
export const KINDS = ["task", "result", "question"];
// Task status follows the handoff vocabulary (working/ready/blocked) plus queue-only states.
export const TASK_STATUSES = ["queued", "working", "ready", "blocked", "cancelled"];
export const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

const RESULT_SUFFIX = ":result";
const QUESTION_SUFFIX = ":question";

async function importSqlite() {
  // node:sqlite is still flagged experimental on Node 22 and warns on every CLI call.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes("SQLite")) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

export function defaultDbPath() {
  return process.env.AGENT_BRIDGE_DB || path.join(os.homedir(), ".agent-bridge", "bridge.db");
}

export function hashFile(cwd, relPath, exclusions = []) {
  const full = path.resolve(cwd, relPath);
  if (!existsSync(full)) return null;
  return hashEntry(realpathSync.native(full), exclusions) ?? null;
}

function hashEntry(full, exclusions) {
  const key = pathKey(full);
  if (exclusions.some(scope => key === scope || key.startsWith(`${scope}/`))) return undefined;
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) {
    return `sha256:${createHash("sha256").update(`link:${readlinkSync(full)}`).digest("hex")}`;
  }
  if (stat.isDirectory()) {
    const entries = readdirSync(full).sort().map((name) => [name, hashEntry(path.join(full, name), exclusions)])
      .filter(([,hash]) => hash !== undefined);
    if (!entries.length && exclusions.some(scope => scope.startsWith(`${key}/`))) return undefined;
    return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
  }
  return `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
}

/** Resolve aliases through the nearest existing ancestor, including not-yet-created files. */
export function pathKey(p, cwd = process.cwd()) {
  let ancestor = path.resolve(cwd, p);
  const tail = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    tail.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  let key = path.join(realpathSync.native(ancestor), ...tail).replace(/\\/g, "/");
  if (process.platform === "win32") key = key.toLowerCase();
  return key;
}

/** True when two write scopes touch the same file or one contains the other. */
export function scopesOverlap(a, b) {
  for (const x of a.map((p) => pathKey(p))) {
    for (const y of b.map((p) => pathKey(p))) {
      if (x === y || x.startsWith(y.endsWith("/") ? y : `${y}/`) || y.startsWith(x.endsWith("/") ? x : `${x}/`)) return true;
    }
  }
  return false;
}

function now() {
  return new Date().toISOString();
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
}

function requireOneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

function stringArray(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}

// Independent reviews, chains and resumed conversations are intentional distinct executions.
function workKey(task,lineage=[],project=task.project_id) {
  if(task.repeat||task.chain||task.root_id||task.role==='review'||task.thread_id)return null;
  const intent={...task,cwd:pathKey(task.cwd),project_id:project,profile:task.profile??'standard',lineage,
    write_files:task.write_files.map(file=>pathKey(file,task.cwd)),
    file_refs:task.file_refs.map(ref=>({...ref,path:pathKey(ref.path,task.cwd)}))};
  for(const key of ['message_id','task_id','sender','recipient','model','effort','repeat'])delete intent[key];
  return createHash('sha256').update(JSON.stringify(stable(intent))).digest('hex');
}

function followupHash(input) {
  const { message_id, followup_key, ...intent } = input;
  return createHash('sha256').update(JSON.stringify(stable(intent))).digest('hex');
}

/**
 * Validate a task envelope and fill file hashes that the sender left out.
 * Returns the normalised envelope; throws with a readable message on bad input.
 */
export function normaliseTask(input) {
  const task = { ...input, kind: "task" };
  if(task.repeat!==undefined&&typeof task.repeat!=='boolean')throw new Error('repeat must be true or false');
  task.browser_context = normaliseBrowserContext(task.browser_context);
  for (const key of ["message_id", "task_id", "goal", "cwd"]) requireString(task[key], key);
  requireOneOf(task.sender, AGENTS, "sender");
  requireOneOf(task.recipient, AGENTS, "recipient");
  if (task.sender === task.recipient) throw new Error("sender and recipient must differ");
  task.sandbox = task.sandbox ?? "read-only";
  requireOneOf(task.sandbox, SANDBOXES, "sandbox");
  if (task.sandbox === "danger-full-access" && task.recipient !== "codex") {
    throw new Error("Full access mode is supported by Codex only");
  }
  task.acceptance = stringArray(task.acceptance, "acceptance");
  task.write_files = stringArray(task.write_files, "write_files");
  if (task.sandbox === "read-only" && task.write_files.length > 0) {
    throw new Error("write_files needs sandbox workspace-write");
  }
  task.file_refs = (task.file_refs ?? []).map((ref) => {
    const r = typeof ref === "string" ? { path: ref } : { ...ref };
    requireString(r.path, "file_refs[].path");
    r.hash = r.hash ?? hashFile(task.cwd, r.path);
    return r;
  });
  task.reply_to = task.reply_to ?? null;
  task.thread_id = task.thread_id ?? null;
  task.project_id = task.project_id ?? task.task_id;
  requireString(task.project_id,'project_id');
  task.depends_on=stringArray(task.depends_on,'depends_on');
  task.handoff_from=task.handoff_from===undefined?undefined:stringArray(task.handoff_from,'handoff_from');
  if(task.execution && (typeof task.execution.adapter!=='string'||Object.keys(task.execution).some(key=>key!=='adapter')))throw new Error('execution must name a configured adapter only');
  if(task.recovery!==undefined && typeof task.recovery!=='boolean')throw new Error('recovery must be true or false');
  if(task.reuse){
    if(task.reuse.pure!==true||typeof task.reuse.version!=='string'||!task.reuse.version.trim())throw new Error('reuse requires pure:true and version');
    task.reuse.files=stringArray(task.reuse.files,'reuse.files');
    task.reuse.env=stringArray(task.reuse.env,'reuse.env');
    for(const file of task.reuse.files)if(!task.file_refs.some(ref=>ref.path===file))task.file_refs.push({path:file,hash:hashFile(task.cwd,file)});
  }
  if(task.depends_on.includes(task.message_id))throw new Error('task cannot depend on itself');
  for(const ref of task.context_refs ?? []){
    if(!ref || typeof ref.path!=='string' || typeof ref.lines!=='string' || !/^\d+-\d+$/.test(ref.lines))throw new Error('invalid context_refs lines');
    if(!task.file_refs.some(file=>file.path===ref.path))task.file_refs.push({path:ref.path,hash:hashFile(task.cwd,ref.path)});
  }
  return bindContract(task);
}

export class BridgeStore {
  constructor(dbPath = defaultDbPath()) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Another process may hold the write lock briefly during claim.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        reply_to TEXT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT,
        body TEXT NOT NULL,
        write_files TEXT NOT NULL DEFAULT '[]',
        thread_id TEXT,
        turn_id TEXT,
        usage TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        heartbeat_at TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages (recipient, kind, status, created_at);
    `);
    this.transaction(() => {
      if (!this.db.prepare("PRAGMA table_info(messages)").all().some((c) => c.name === "attempt")) {
        this.db.exec("ALTER TABLE messages ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
      }
      const columns = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map(c => c.name));
      for (const [name, type] of [["root_id", "TEXT"], ["parent_id", "TEXT"],
        ["round", "INTEGER"], ["scope_held", "INTEGER NOT NULL DEFAULT 0"], ["cleanup_pending", "INTEGER NOT NULL DEFAULT 0"], ["runtime_reads", "TEXT NOT NULL DEFAULT '[]'"],
        ["not_before", "TEXT"], ["recovery", "TEXT NOT NULL DEFAULT '[]'"],
        ["work_key", "TEXT"], ["duplicate_of", "TEXT"], ["browser_space_id", "INTEGER"]]) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS messages_chain ON messages(root_id, kind)");
      this.db.exec('CREATE INDEX IF NOT EXISTS messages_work ON messages(work_key,status)');
      this.db.exec(`UPDATE messages SET cleanup_pending = 1 WHERE kind = 'task' AND status = 'blocked'
        AND (status_reason LIKE 'runner cleanup failed:%' OR status_reason LIKE 'runner stopped during work;%')`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS attempt_usage (
        message_id TEXT NOT NULL, attempt INTEGER NOT NULL, thread_id TEXT,
        usage TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (message_id, attempt)
      );
      INSERT OR IGNORE INTO attempt_usage SELECT message_id, attempt, thread_id, usage, updated_at
        FROM messages WHERE kind = 'task' AND usage IS NOT NULL;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_receipts (
        message_id TEXT NOT NULL, attempt INTEGER NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY(message_id,attempt));`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS result_reuse (fingerprint TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,reply_id TEXT NOT NULL,output_hashes TEXT NOT NULL)`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS external_usage (project_id TEXT NOT NULL,event_id TEXT NOT NULL,
        body TEXT NOT NULL,PRIMARY KEY(project_id,event_id))`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS contract_environments (project_id TEXT NOT NULL,contract_hash TEXT NOT NULL,
        environment_hash TEXT NOT NULL,PRIMARY KEY(project_id,contract_hash))`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS project_contracts (project_id TEXT PRIMARY KEY,contract_hash TEXT NOT NULL,contract TEXT NOT NULL)`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_holds (recipient TEXT PRIMARY KEY,hold_until TEXT NOT NULL,reason TEXT NOT NULL)`);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  transaction(fn) {
    if(this.inTransaction)return fn();
    this.inTransaction=true;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if(this.db.isTransaction)this.db.exec("ROLLBACK");
      throw err;
    } finally {this.inTransaction=false;}
  }

  get(messageId) {
    return decode(this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId));
  }

  /**
   * Queue a task. Re-sending the same message_id never creates a second task;
   * the stored copy is returned with duplicate=true.
   */
  sendTask(input) {
    return this.transaction(() => {
      for (const field of ["pending_review", "findings", "implementation", "current", "followup_request_hash", "review_boundary", "work_key", "duplicate_of", "browser_space_id"]) {
        if (Object.hasOwn(input, field)) throw new Error(`${field} is internal to the store`);
      }
      let task = { ...input };
      const question = task.reply_to ? this.get(task.reply_to) : null;
      const parentTask=question?this.get(question.reply_to):null;
      const sourceTask=parentTask?.kind==='task'?parentTask:question?.root_id?this.get(question.root_id):null;
      if(!task.contract && sourceTask?.body.contract)task={...task,contract:sourceTask.body.contract,contract_review_ids:task.contract_review_ids ?? sourceTask.body.contract_review_ids};
      if(!task.project_id && question)task.project_id=this.get(question.reply_to)?.body.project_id ?? question.task_id;
      for(const dep of task.depends_on ?? [])if(!this.get(dep) || this.get(dep).kind!=='task')throw new Error(`dependency not found: ${dep}`);
      if (task.reply_to) {
        if (!question || !['result','question'].includes(question.kind)) throw new Error('follow-up needs a source reply');
        if (task.sender !== question.recipient) throw new Error('follow-up sender must be the reply recipient');
        const key = task.followup_key ?? 'default';
        requireString(key, 'followup_key');
        const hash = followupHash(input);
        const old = this.db.prepare(`SELECT * FROM messages WHERE kind='task' AND reply_to=?
          AND COALESCE(json_extract(body,'$.followup_key'),'default')=? ORDER BY rowid LIMIT 1`).get(task.reply_to,key);
        if (old) {
          const existing = decode(old);
          // Older queues have no request hash; compare the supplied intent against their stored fields.
          const same = existing.body.followup_request_hash ? existing.body.followup_request_hash === hash
            : Object.entries(input).filter(([k]) => !['message_id','followup_key'].includes(k)).every(([k,v]) => {
              if (k !== 'file_refs') return JSON.stringify(stable(existing.body[k])) === JSON.stringify(stable(v));
              return JSON.stringify(stable(existing.body.file_refs.map(({hash,...ref}) => ref))) ===
                JSON.stringify(stable(v.map(ref => typeof ref === 'string' ? {path:ref} : ref)));
            });
          if (!same) throw new Error('follow-up key already exists with different content');
          this.db.prepare('UPDATE messages SET delivered_at=COALESCE(delivered_at,?) WHERE message_id=?').run(now(),question.message_id);
          return {message:existing,duplicate:true,sameContent:true};
        }
        const parent = this.get(question.reply_to);
        const final = question.root_id && question.message_id === `${question.root_id}:final`;
        if (question.body.current === false || (!final && parent?.attempt !== question.attempt)) throw new Error('source reply is no longer current');
        task.followup_key=key;
        task.followup_request_hash=hash;
      }
      if (question?.kind === "question" && question.root_id) {
        const parent = this.get(question.reply_to);
        const root = this.get(question.root_id);
        if(root.body.contract&&task.contract&&bindContract({...task,cwd:root.body.cwd,contract_review_ids:[]}).contract.hash!==root.body.contract.hash)throw new Error('chain answer contract replacement is not allowed');
        if (root.cancel_requested || this.get(`${root.message_id}:final`)
            || parent.status !== "blocked" || parent.attempt !== question.attempt
            || task.sender !== root.sender || task.recipient !== root.recipient) {
          throw new Error("question is no longer current or answer direction is invalid");
        }
        const answer = this.db.prepare("SELECT message_id FROM messages WHERE kind = 'task' AND reply_to = ?").get(question.message_id);
        if (answer && answer.message_id !== task.message_id) throw new Error("question already has an answer");
        // The answer changes instructions, never the original execution authority.
        task = { ...task, cwd: root.body.cwd, sandbox: root.body.sandbox,
          project_id:root.body.project_id,contract:root.body.contract,contract_review_ids:parent.body.contract_review_ids,
          write_files: root.write_files, file_refs: parent.body.file_refs,
          model: root.body.model, effort: root.body.effort, profile: root.body.profile,
          base_revision: root.body.base_revision, thread_id: parent.thread_id,
          root_id: root.message_id, round: parent.round, role: "implement", chain: root.body.chain,
          parent: { message_id: parent.message_id, attempt: parent.attempt, reply_id: question.message_id } };
      } else {
        if (task.parent || (task.root_id && task.root_id !== task.message_id)
            || (task.role && task.role !== "implement") || (task.round != null && task.round !== 1)) {
          throw new Error("chain descendants must be generated by the store or answer a current question");
        }
        if (task.chain) {
          if (task.sender !== "claude-code" || task.recipient !== "codex") throw new Error("chain starts with a Codex implementation");
          task = { ...task, chain: normaliseChain(task.chain), role: "implement", root_id: task.message_id, round: 1 };
        } else if (task.root_id) {
          throw new Error("root_id requires chain");
        }
      }
      const projectId=task.project_id ?? task.task_id;
      const registered=this.db.prepare('SELECT * FROM project_contracts WHERE project_id=?').get(projectId);
      if(registered&&!task.contract){
        if(task.contract_review_ids===undefined)throw new Error(`project ${projectId} already has a common contract, so this task inherits it: set contract_review_ids ([] for none) or use another project_id`);
        task.contract=JSON.parse(registered.contract);
      }
      const normalized=normaliseTask(task);
      validateHybridTask(normalized);
      if(normalized.contract){
        if(registered&&registered.contract_hash!==normalized.contract.hash)throw new Error('project common contract replacement is not allowed within the same run');
        this.db.prepare('INSERT OR IGNORE INTO project_contracts VALUES (?,?,?)').run(projectId,normalized.contract.hash,JSON.stringify(normalized.contract));
      }
      const saved = this._insertTask(normalized,{project:Object.hasOwn(input,'project_id')||question?normalized.project_id:null});
      if (question && !saved.sameContent) throw new Error('follow-up message id already exists with different content');
      if (question && saved.sameContent) this.db.prepare('UPDATE messages SET delivered_at=COALESCE(delivered_at,?) WHERE message_id=?').run(now(),question.message_id);
      return saved;
    });
  }

  _insertTask(task,{project=task.project_id}={}) {
    const ts = now();
    const parents=[...new Set([...(task.depends_on??[]),...(task.handoff_from??[])])];
    const lineage=parents.map(id=>this.db.prepare("SELECT message_id,body,attempt FROM messages WHERE reply_to=? AND kind='result' ORDER BY attempt DESC,rowid DESC LIMIT 1").get(id));
    // Unknown future inputs cannot safely be treated as the same request.
    const key=parents.every(id=>this.dependencyReady(this.get(id)))?workKey(task,lineage,project):null;
    const source=key?this.db.prepare("SELECT message_id FROM messages WHERE kind='task' AND message_id<>? AND work_key=? AND (status='working' OR cleanup_pending=1) ORDER BY rowid LIMIT 1").get(task.message_id,key):null;
    const res = this.db.prepare(
      `INSERT INTO messages (message_id, task_id, reply_to, sender, recipient, kind, status, body,
         write_files, thread_id, created_at, updated_at, root_id, parent_id, round,work_key,duplicate_of)
       VALUES (?, ?, ?, ?, ?, 'task', 'queued', ?, ?, ?, ?, ?, ?, ?, ?,?,?)
       ON CONFLICT (message_id) DO NOTHING`,
    ).run(task.message_id, task.task_id, task.reply_to, task.sender, task.recipient,
      JSON.stringify(task), JSON.stringify(task.write_files), task.thread_id, ts, ts,
      task.root_id ?? null, task.parent?.message_id ?? null, task.round ?? null,key,source?.message_id??null);
    const stored = this.get(task.message_id);
    return { message: stored, duplicate: res.changes === 0,
      sameContent: JSON.stringify(stored.body) === JSON.stringify(task) };
  }

  _browserSpace(task) {
    if(task.browser_context)return task.browser_context.space_id;
    const spaces=(task.handoff_from??task.depends_on??[]).flatMap(id=>{
      const parent=this.get(id);const reply=parent?.root_id?this.get(`${parent.root_id}:final`):this.db.prepare("SELECT body FROM messages WHERE reply_to=? AND kind='result' ORDER BY attempt DESC LIMIT 1").get(id);
      const body=typeof reply?.body==='string'?JSON.parse(reply.body):reply?.body;
      const context=body?.browser_context??body?.delivery?.browser_context;
      return context?[context.space_id]:[];
    });
    return new Set(spaces).size===1?spaces[0]:null;
  }

  _finishDuplicate(task,source) {
    const original=this.db.prepare("SELECT * FROM messages WHERE reply_to=? AND kind IN ('result','question') ORDER BY attempt DESC,rowid DESC LIMIT 1").get(source.message_id);
    const body=original?JSON.parse(original.body):null;
    const successful=this.dependencyReady(source);
    if(successful){
      const snapshot=this.listRuntime(source.message_id).find(row=>row.attempt===source.attempt)?.shared_hashes;
      const files=[...source.body.write_files,...source.body.file_refs.map(ref=>ref.path)];
      if(files.length&&!snapshot)throw new Error('shared source has no file-version evidence');
      for(const [file,hash] of Object.entries(snapshot??{}))if(hashFile(source.body.cwd,file)!==hash)throw new Error('shared source file changed: '+file);
    }
    const provenance={message_id:source.message_id,reply_id:original?.message_id??null,agent:source.recipient};
    const empty={reported:[],observed:[],outside_scope:[],changes:[]};
    const reply=successful?structuredClone(body):{status:'failed',summary:`Shared execution ${source.message_id}: ${[source.status_reason,body?.question].filter(Boolean).join('; ')||source.status}`,
      acceptance:task.body.acceptance.map(criterion=>({criterion,result:'unverified',evidence:'Shared execution did not complete'}))};
    reply.coalesced_from=provenance;reply.thread_id=null;reply.turn_id=null;reply.cwd=task.body.cwd;
    reply.input_hashes=snapshotHashes(task.body);
    if(successful)reply.reused_artifacts=reply.changed_files;
    reply.changed_files=empty;
    reply.communication_receipt={...reply.communication_receipt,execution:'coalesced',source_agent:source.recipient,native_runtime_inventory:'not-executed'};
    reply.delivery={...(reply.delivery??reply),status:reply.status,summary:reply.summary,thread_id:null,turn_id:null,
      changed_files:empty,coalesced_from:provenance,reused_artifacts:reply.reused_artifacts,communication_receipt:reply.communication_receipt};
    let environment;
    if(task.body.contract){
      environment=inspectContract(task.body);
      if(successful)validateContractReply(task.body,reply,environment);
      else reply.contract_receipt={contract_hash:task.body.contract.hash,environment_hash:environment.environment_hash,
        requirement_ids:task.body.contract.document.requirements.map(r=>r.id),review:task.body.contract_review_ids.map(criterion_id=>({criterion_id,result:'unverified',evidence:reply.summary}))};
      reply.delivery.contract_receipt=reply.contract_receipt;
    }
    this.db.prepare("UPDATE messages SET status='working',attempt=attempt+1,claimed_by=?,updated_at=? WHERE message_id=? AND status='queued'")
      .run('coalesced:'+source.message_id,now(),task.message_id);
    const claim=this.get(task.message_id),runtime={execution:'coalesced',coalesced_from:provenance};
    if(environment){const packet={...task.body,contract_environment:environment};Object.assign(runtime,{contract_environment:environment,contract_delivery:verifyWire(packet,wirePacket(packet))});this.bindContractEnvironment(task.body,environment);}
    this.saveRuntime(task.message_id,runtime,claim);
    const usage=zeroUsage('coalesced');this.saveUsage(task.message_id,usage,claim);
    return this.finishTask(task.message_id,{claim,outcome:'result',reply,usage});
  }

  /**
   * Atomically take the oldest queued task for `recipient` whose write scope does not
   * overlap a task already being worked on. Overlapping tasks stay queued.
   */
  claimTask(recipient, claimedBy) {
    return this.transaction(() => {
      const started = now();
      this.db.prepare("DELETE FROM agent_holds WHERE hold_until <= ?").run(started);
      const hold = this.db.prepare("SELECT hold_until FROM agent_holds WHERE recipient = ?").get(recipient);
      if (hold) {
        this.db.prepare(`UPDATE messages SET status_reason = ? WHERE kind = 'task' AND recipient = ? AND status = 'queued'
          AND (not_before IS NULL OR not_before <= ?)`).run(`waiting: ${recipient} usage limit until ${hold.hold_until}`, recipient, started);
        return null;
      }
      const busy = this.db
        .prepare(`SELECT message_id, root_id, status, cancel_requested, cleanup_pending, recipient, thread_id, write_files, body, runtime_reads,work_key,browser_space_id FROM messages WHERE kind = 'task'
          AND (status = 'working' OR scope_held = 1 OR cleanup_pending = 1 OR (root_id IS NOT NULL AND status = 'blocked' AND cancel_requested = 1))`)
        .all()
        .map((row) => {
          const body=JSON.parse(row.body),{ cwd, file_refs = [] }=body;
          return { id: row.message_id, root: row.root_id, status: row.status, stopping: row.cancel_requested === 1,
            cleanup: row.cleanup_pending, recipient:row.recipient, thread:row.thread_id,key:row.work_key,space:row.browser_space_id??this._browserSpace(body),
            reads:[...file_refs.map(ref => pathKey(ref.path,cwd)),...JSON.parse(row.runtime_reads)], files: JSON.parse(row.write_files).map((f) => pathKey(f, cwd)) };
        });
      const queued = this.db
        .prepare(
          `SELECT * FROM messages WHERE kind = 'task' AND recipient = ? AND status = 'queued' AND cleanup_pending = 0
           AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at, rowid`,
        )
        .all(recipient, started);
      for (const row of queued) {
        const queuedTask = decode(row);
        if(row.duplicate_of){
          const source=this.get(row.duplicate_of);
          if(source&&!['queued','working'].includes(source.status)&&!source.cleanup_pending&&!source.scope_held){
            try{this._finishDuplicate(queuedTask,source);}catch(error){this._setStatus(row.message_id,'blocked','shared result verification failed: '+error.message);}
            continue;
          }
          this.db.prepare('UPDATE messages SET status_reason=? WHERE message_id=?').run('waiting: same work '+row.duplicate_of,row.message_id);continue;
        }
        const pending=[...new Set([...(queuedTask.body.depends_on??[]),...(queuedTask.body.handoff_from??[])])].find(id=>{
          const dependency=this.get(id);
          return !this.dependencyReady(dependency);
        });
        if(pending){this.db.prepare('UPDATE messages SET status_reason=? WHERE message_id=?').run(`waiting: dependency ${pending}`,row.message_id);continue;}
        if (row.root_id && (this.get(row.root_id).cancel_requested || !this._parentCurrent(queuedTask))) {
          this._setStatus(row.message_id, "cancelled", "superseded");
          continue;
        }
        const { cwd } = JSON.parse(row.body);
        const files = JSON.parse(row.write_files).map((f) => pathKey(f, cwd));
        const reads = [...queuedTask.body.file_refs.map(ref => pathKey(ref.path,cwd)),...JSON.parse(row.runtime_reads)];
        const duplicate=row.work_key&&busy.find(b=>b.id!==row.message_id&&b.key===row.work_key);
        if(duplicate){this.db.prepare('UPDATE messages SET duplicate_of=?,status_reason=? WHERE message_id=?').run(duplicate.id,'waiting: same work '+duplicate.id,row.message_id);continue;}
        const space=this._browserSpace(queuedTask.body);
        const browserBusy=space&&busy.find(b=>b.id!==row.message_id&&b.space===space&&(!row.root_id||b.root!==row.root_id||b.status==='working'||b.cleanup));
        if(browserBusy){this.db.prepare('UPDATE messages SET status_reason=? WHERE message_id=?').run(`waiting: browser space ${space} held by ${browserBusy.id}`,row.message_id);continue;}
        const sessionBusy = row.thread_id && busy.find(b => b.id !== row.message_id && b.recipient === row.recipient && b.thread === row.thread_id
          && (b.status === 'working' || b.cleanup || (b.root && b.root !== row.root_id)));
        if (sessionBusy) {
          this.db.prepare('UPDATE messages SET status_reason=?,updated_at=? WHERE message_id=?')
            .run(`waiting: session busy ${sessionBusy.id}`,now(),row.message_id);
          continue;
        }
        const blocker = busy.find((b) => b.id !== row.message_id
          && (!row.root_id || b.root !== row.root_id || b.status === "working" || b.cleanup || (b.status === "blocked" && b.stopping))
          && (scopesOverlap(files, b.files) || scopesOverlap(files,b.reads) || scopesOverlap(reads,b.files)));
        if (blocker) {
          this.db
            .prepare("UPDATE messages SET status_reason = ?, updated_at = ? WHERE message_id = ?")
            .run(`waiting: write_files overlap ${blocker.id}`, now(), row.message_id);
          continue;
        }
        const ts = now();
        if(row.work_key)this.db.prepare("UPDATE messages SET duplicate_of=? WHERE kind='task' AND status='queued' AND work_key=? AND message_id<>? AND duplicate_of IS NULL").run(row.message_id,row.work_key,row.message_id);
        this.db
          .prepare(
            `UPDATE messages SET status = 'working', status_reason = NULL, claimed_by = ?,
               heartbeat_at = ?, updated_at = ?, attempt = attempt + 1,
               turn_id = NULL, usage = NULL, not_before = NULL,browser_space_id=? WHERE message_id = ?`,
          )
          .run(claimedBy, ts, ts,space??null,row.message_id);
        if (row.root_id) this.db.prepare("UPDATE messages SET scope_held = 1 WHERE message_id = ?").run(row.root_id);
        return this.get(row.message_id);
      }
      return null;
    });
  }

  heartbeat(messageId, claim) {
    this.db.prepare(`UPDATE messages SET heartbeat_at = ? WHERE message_id = ?
      AND status = 'working' AND attempt = ? AND claimed_by = ?`)
      .run(now(), messageId, claim.attempt, claim.claimed_by);
  }

  dependencyReady(task) {
    if(!task || task.status!=='ready'||task.cleanup_pending||task.cancel_requested)return false;
    const row=task.root_id?this.get(`${task.root_id}:final`):this.db.prepare("SELECT message_id FROM messages WHERE reply_to=? AND kind='result' ORDER BY attempt DESC LIMIT 1").get(task.message_id);
    const result=row && this.get(row.message_id);
    if(result?.body.status!=='done'||result.body.current===false||result.body.verdict==='reject')return false;
    const checks=result.body.acceptance ?? result.body.criteria ?? [];
    return Array.isArray(checks)&&(task.body.acceptance ?? []).every(criterion=>checks.some(check=>check?.criterion===criterion&&check.result==='pass'&&typeof check.evidence==='string'&&check.evidence.trim()));
  }

  bindReadScopes(messageId,files,claim) {
    return this.transaction(()=>{
      const task=this.get(messageId);
      if(task?.status!=='working'||task.attempt!==claim.attempt||task.claimed_by!==claim.claimed_by)throw new Error('invalid read scope claim');
      const reads=files.map(file=>pathKey(file,task.body.cwd));
      const busy=this.db.prepare("SELECT message_id,write_files,body FROM messages WHERE kind='task' AND message_id<>? AND (status='working' OR scope_held=1 OR cleanup_pending=1)").all(messageId);
      const blocker=busy.find(row=>scopesOverlap(reads,JSON.parse(row.write_files).map(file=>pathKey(file,JSON.parse(row.body).cwd))));
      this.db.prepare('UPDATE messages SET runtime_reads=? WHERE message_id=?').run(JSON.stringify(reads),messageId);
      if(blocker){this.db.prepare("UPDATE messages SET status='queued',status_reason=?,claimed_by=NULL,heartbeat_at=NULL WHERE message_id=?")
        .run(`waiting: program code writer ${blocker.message_id}`,messageId);return false;}
      return true;
    });
  }

  setTurn(messageId, threadId, turnId, claim) {
    this.db
      .prepare(`UPDATE messages SET thread_id = ?, turn_id = ?, updated_at = ? WHERE message_id = ?
        AND status = 'working' AND attempt = ? AND claimed_by = ?`)
      .run(threadId, turnId, now(), messageId, claim.attempt, claim.claimed_by);
  }

  setStatus(messageId, status, reason = null, claim = null) {
    requireOneOf(status, TASK_STATUSES, "status");
    return this.transaction(() => this._setStatus(messageId, status, reason, claim));
  }

  _setStatus(messageId, status, reason = null, claim = null) {
    const before = this.get(messageId);
    const res = this.db.prepare(`UPDATE messages SET status = ?, status_reason = ?, updated_at = ?,
      cleanup_pending = CASE WHEN ? THEN 1 ELSE cleanup_pending END WHERE message_id = ?
      ${claim ? "AND status = 'working' AND attempt = ? AND claimed_by = ?" : ""}`)
      .run(status, before?.status_reason === "superseded" ? "superseded" : reason, now(),
        status === 'blocked' && String(reason).startsWith('runner cleanup failed:') ? 1 : 0, messageId,
        ...(claim ? [claim.attempt, claim.claimed_by] : []));
    if (res.changes && before?.root_id && status !== "working") this._afterStopped(messageId);
  }

  saveUsage(messageId, usage, claim) {
    return this.transaction(() => {
      const task = this.get(messageId);
      if (task?.attempt !== claim.attempt || task?.claimed_by !== claim.claimed_by) return;
      const ts = now();
      const body = JSON.stringify(usage);
      this.db.prepare("UPDATE messages SET usage = ? WHERE message_id = ?").run(body, messageId);
      this.db.prepare(`INSERT INTO attempt_usage VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(message_id, attempt) DO UPDATE SET usage = excluded.usage, updated_at = excluded.updated_at`)
        .run(messageId, claim.attempt, task.thread_id, body, ts);
    });
  }

  listUsage(messageId) {
    return this.db.prepare("SELECT attempt, usage FROM attempt_usage WHERE message_id = ? ORDER BY attempt")
      .all(messageId).map((row) => ({ attempt: row.attempt, ...JSON.parse(row.usage) }));
  }

  projectUsage(projectId) {
    const tasks=this.db.prepare("SELECT message_id,recipient,body,attempt FROM messages WHERE kind='task'").all()
      .filter(row=>(JSON.parse(row.body).project_id ?? JSON.parse(row.body).task_id)===projectId);
    const rows=tasks.flatMap(task=>Array.from({length:task.attempt},(_,index)=>({recipient:task.recipient,
      usage:this.listUsage(task.message_id).find(usage=>usage.attempt===index+1)})));
    const external=this.db.prepare('SELECT body FROM external_usage WHERE project_id=?').all(projectId).map(row=>JSON.parse(row.body));
    return {project_id:projectId,tasks:tasks.length,external_events:external.length,...aggregateUsage([
      ...rows,...external.map(event=>({recipient:event.provider,usage:event.usage}))]),attempts:rows.length,
      coverage:external.length?'bridge-attempts-and-recorded-external-events':'bridge-attempts-only'};
  }

  recordExternalUsage(event) {
    for(const key of ['project_id','event_id','provider','source'])requireString(event[key],key);
    if(event.scope!=='separate-process' || !event.usage?.turn)throw new Error('external usage needs separate-process scope and measured turn fields');
    if(Object.values(event.usage.turn).some(value=>value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0)))throw new Error('invalid external usage counters');
    const old=this.db.prepare('SELECT body FROM external_usage WHERE project_id=? AND event_id=?').get(event.project_id,event.event_id);
    if(old && JSON.stringify(stable(JSON.parse(old.body)))!==JSON.stringify(stable(event)))throw new Error('external usage event conflicts');
    this.db.prepare('INSERT OR IGNORE INTO external_usage VALUES (?,?,?)').run(event.project_id,event.event_id,JSON.stringify(event));
    return {event_id:event.event_id,duplicate:!!old};
  }

  saveRuntime(messageId,receipt,claim) {
    const task=this.get(messageId);
    if (task?.attempt!==claim.attempt || task?.claimed_by!==claim.claimed_by) return;
    const previous=this.db.prepare('SELECT receipt FROM runtime_receipts WHERE message_id=? AND attempt=?').get(messageId,claim.attempt);
    this.db.prepare(`INSERT INTO runtime_receipts VALUES (?,?,?)
      ON CONFLICT(message_id,attempt) DO UPDATE SET receipt=excluded.receipt`)
      .run(messageId,claim.attempt,JSON.stringify({...(previous?JSON.parse(previous.receipt):{}),...receipt}));
  }

  bindContractEnvironment(task,environment){
    return this.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO contract_environments VALUES (?,?,?)').run(task.project_id,task.contract.hash,environment.environment_hash);
      const stored=this.db.prepare('SELECT environment_hash FROM contract_environments WHERE project_id=? AND contract_hash=?').get(task.project_id,task.contract.hash);
      if(stored.environment_hash!==environment.environment_hash)throw new Error('common contract environment differs from project baseline');
    });
  }

  listRuntime(messageId) {
    return this.db.prepare('SELECT attempt, receipt FROM runtime_receipts WHERE message_id=? ORDER BY attempt')
      .all(messageId).map(r=>({attempt:r.attempt,...JSON.parse(r.receipt)}));
  }

  /** Last cumulative token total recorded for a thread, used to derive per-turn usage. */
  lastThreadTotal(threadId,recipient=null) {
    const row = this.db
      .prepare(
        `SELECT a.usage FROM attempt_usage a JOIN messages m ON m.message_id=a.message_id WHERE a.thread_id = ?
         AND (? IS NULL OR m.recipient=?) ORDER BY a.updated_at DESC,a.rowid DESC LIMIT 1`,
      )
      .get(threadId,recipient,recipient);
    return row ? JSON.parse(row.usage).thread_total ?? null : null;
  }

  /**
   * Close a working task with a result or a question. Idempotent: the reply id is derived
   * from the task and attempt, so retries retain their own replies.
   */
  finishTask(messageId, { claim, outcome, reply, usage = null, reason = null,expectedHandoffs=[] }) {
    requireOneOf(outcome, ["result", "question"], "outcome");
    return this.transaction(() => {
      const task = this.get(messageId);
      if (!task || task.kind !== "task") throw new Error(`task ${messageId} not found`);
      if (!claim || claim.message_id !== messageId || task.attempt !== claim.attempt || task.claimed_by !== claim.claimed_by) {
        throw new Error(`stale or invalid claim for ${messageId}`);
      }
      const ts = now();
      const replyId = `${messageId}:attempt:${claim.attempt}` + (outcome === "result" ? RESULT_SUFFIX : QUESTION_SUFFIX);
      if (task.status !== "working") {
        const existing = this.get(replyId);
        if (existing) return existing;
        throw new Error(`claim for ${messageId} is no longer working`);
      }
      const root = task.root_id ? this.get(task.root_id) : null;
      if(task.body.contract){
        const runtime=this.listRuntime(messageId).find(row=>row.attempt===claim.attempt),environment=runtime?.contract_environment;
        const reused=runtime?.execution==='reused'&&runtime.reused_from?.message_id===reply.reused_from?.message_id;
        if(!reused&&(!runtime?.contract_delivery?.verified||runtime.contract_delivery.contract_hash!==task.body.contract.hash))throw new Error('contract wire delivery verification missing');
        const current=inspectContract(task.body);
        if(current.environment_hash!==environment?.environment_hash)throw new Error('contract environment changed before publication');
        if (task.body.role === 'review' && isHybrid(task.body)) verifyHybridPrograms(task.body,reply);
        reason=validateContractReply(task.body,reply,environment) ?? reason;
      }
      for(const expected of expectedHandoffs){
        const parent=this.get(expected.source_message_id),source=this.get(expected.message_id);
        if(!this.dependencyReady(parent)||parent.attempt!==expected.source_attempt||!source||source.attempt!==expected.attempt
          ||createHash('sha256').update(JSON.stringify(source.body)).digest('hex')!==expected.hash)throw new Error(`handoff changed during execution: ${expected.source_message_id}`);
      }
      const current = !root || (!root.cancel_requested && !task.cancel_requested && this._parentCurrent(task));
      if (root && task.body.role === "review" && current) {
        if (outcome !== "result") throw new Error("review cannot ask questions");
        reply = normaliseReview(reply, task.body.acceptance);
      }
      if (root) reply = { ...reply, current, parent: task.body.parent ?? null };
      this.db.prepare(
        `INSERT INTO messages (message_id, task_id, reply_to, sender, recipient, kind, status, body,
           thread_id, usage, created_at, updated_at, attempt, root_id, parent_id, round, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO NOTHING`,
      ).run(replyId, task.task_id, messageId, task.recipient,
        root && outcome === "question" ? root.sender : task.sender, outcome, JSON.stringify(reply),
        task.thread_id, usage ? JSON.stringify(usage) : null, ts, ts, claim.attempt,
        task.root_id, task.message_id, task.round, root && (outcome === "result" || !current) ? ts : null);
      const status = !current ? "cancelled" : outcome === "question" || reply.status === "failed" ? "blocked" : "ready";
      const statusReason = !current ? root.cancel_requested ? "chain cancelled" : "superseded"
        : outcome === "question" ? "question" : reply.status === "failed" ? reason ?? "agent reported failure" : reason;
      this.db.prepare(
        `UPDATE messages SET status = ?, status_reason = ?, usage = COALESCE(?, usage), updated_at = ?
         WHERE message_id = ?`,
      ).run(status, statusReason, usage ? JSON.stringify(usage) : null, ts, messageId);
      if (root && current && outcome === "result") this._advanceChain(root, this.get(messageId), this.get(replyId));
      if (root) this._afterStopped(messageId);
      if(task.work_key&&outcome==='result'&&!String(task.claimed_by).startsWith('coalesced:')){
        const files=[...new Set([...task.body.write_files,...task.body.file_refs.map(ref=>ref.path)])];
        try{this.saveRuntime(messageId,{shared_hashes:Object.fromEntries(files.map(file=>[file,hashFile(task.body.cwd,file)]))},claim);}
        catch(error){this.saveRuntime(messageId,{shared_hashes_error:error.message},claim);}
        const followers=this.db.prepare("SELECT * FROM messages WHERE kind='task' AND status='queued' AND work_key=? AND message_id<>? AND (duplicate_of IS NULL OR duplicate_of=?)").all(task.work_key,messageId,messageId);
        for(const follower of followers)try{this._finishDuplicate(decode(follower),this.get(messageId));}catch(error){this._setStatus(follower.message_id,'blocked','shared result verification failed: '+error.message);}
      }
      return this.get(replyId);
    });
  }

  /** Queued tasks are cancelled at once; working tasks only get a request the runner acts on. */
  requestCancel(messageId) {
    return this.transaction(() => {
      const task = this.get(messageId);
      if (!task || task.kind !== "task") throw new Error(`task ${messageId} not found`);
      if (task.root_id) {
        const rootId = task.root_id;
        if (this.get(`${rootId}:final`)) return `unchanged (${task.status})`;
        this.db.prepare(`UPDATE messages SET status = 'cancelled', status_reason = 'chain cancelled', updated_at = ?
          WHERE root_id = ? AND kind = 'task' AND status != 'working'
          AND NOT (status = 'blocked' AND cancel_requested = 1)`).run(now(), rootId);
        this.db.prepare(`UPDATE messages SET cancel_requested = 1, updated_at = ?
          WHERE root_id = ? AND kind = 'task'`).run(now(), rootId);
        this._releaseCancelled(rootId);
        return this.get(rootId).scope_held ? "requested" : "cancelled";
      }
      if (task.status === "queued") {
        this._setStatus(messageId, "cancelled", "cancelled before start");
        return "cancelled";
      }
      if (task.status === "working") {
        this.db
          .prepare("UPDATE messages SET cancel_requested = 1, updated_at = ? WHERE message_id = ?")
          .run(now(), messageId);
        return "requested";
      }
      return `unchanged (${task.status})`;
    });
  }

  isCancelRequested(messageId) {
    return this.db.prepare("SELECT cancel_requested FROM messages WHERE message_id = ?").get(messageId)
      ?.cancel_requested === 1;
  }

  /** Put a blocked task back in the queue, e.g. after checking an interrupted run. */
  requeue(messageId) {
    return this.transaction(() => {
      const task = this.get(messageId);
      if (!task || task.status !== "blocked") throw new Error(`only blocked tasks can be requeued`);
      if (task.cleanup_pending) throw new Error('confirm the current attempt stopped before requeue; cleanup is unconfirmed');
      if (task.root_id) {
        const root = this.get(task.root_id);
        if (root.cancel_requested || this.get(`${root.message_id}:final`)) throw new Error("chain is closed");
        this._supersedeDescendants(messageId);
        if (task.body.pending_review) {
          this._resetChainTask(task.body.pending_review, task);
          return this.get(messageId);
        }
      }
      this.db
        .prepare(
          `UPDATE messages SET status = 'queued', status_reason = NULL, cancel_requested = 0,
             claimed_by = NULL, heartbeat_at = NULL,duplicate_of=NULL, updated_at = ? WHERE message_id = ?`,
        )
        .run(now(), messageId);
      return this.get(messageId);
    });
  }

  /**
   * Apply a recovery decision (recovery.mjs) to the attempt that just stopped. A task that moved on since,
   * or whose stop is unconfirmed, is left as it is. Every decision is kept in the task's recovery history.
   */
  recoverTask(messageId, claim, decision) {
    return this.transaction(() => {
      const task = this.get(messageId);
      if (task?.kind !== "task" || task.status !== "blocked" || task.attempt !== claim.attempt
          || task.claimed_by !== claim.claimed_by || task.cleanup_pending || task.cancel_requested) return task;
      const ts = now();
      const history = JSON.stringify([...task.recovery, { ...decision, attempt: claim.attempt, at: ts }]);
      if (decision.hold) {
        this.db.prepare(`INSERT INTO agent_holds VALUES (?, ?, ?) ON CONFLICT(recipient)
          DO UPDATE SET hold_until = MAX(hold_until, excluded.hold_until), reason = excluded.reason`)
          .run(task.recipient, decision.hold, decision.kind);
      }
      if (decision.action === "retry") {
        this.db.prepare(`UPDATE messages SET status = 'queued', status_reason = ?, not_before = ?, recovery = ?,
          claimed_by = NULL, heartbeat_at = NULL, updated_at = ? WHERE message_id = ?`)
          .run(decision.kind==='quota' && decision.max===null?`waiting: ${task.recipient} usage limit until ${decision.retry_at}`
            :`waiting: automatic retry ${decision.retry}/${decision.max} after ${decision.kind} at ${decision.retry_at}`,
            decision.retry_at, history, ts, messageId);
      } else if (decision.action === "fallback") {
        // Only the agent and its model settings change; goal, scope, sandbox and profile stay as sent.
        const body = { ...task.body, recipient: decision.to, model: decision.model.after, effort: decision.effort.after, thread_id: null };
        this.db.prepare(`UPDATE messages SET recipient = ?, body = ?, thread_id = NULL, status = 'queued', status_reason = ?,
          not_before = NULL, recovery = ?, claimed_by = NULL, heartbeat_at = NULL, updated_at = ? WHERE message_id = ?`)
          .run(decision.to, JSON.stringify(body), `waiting: handed from ${decision.from} to ${decision.to} after ${decision.kind}`,
            history, ts, messageId);
      } else {
        this.db.prepare("UPDATE messages SET recovery = ?, updated_at = ? WHERE message_id = ?").run(history, ts, messageId);
      }
      return this.get(messageId);
    });
  }

  confirmStopped(messageId, attempt) {
    return this.transaction(() => {
      const task=this.get(messageId);
      if (!task || task.attempt !== attempt) throw new Error('stop confirmation attempt does not match');
      if (!task.cleanup_pending) return task;
      this.db.prepare(`UPDATE messages SET cleanup_pending=0, status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE status END,
        status_reason='process stop confirmed',updated_at=? WHERE message_id=?`).run(now(),messageId);
      if (task.root_id) this._afterStopped(messageId);
      return this.get(messageId);
    });
  }

  /**
   * Runner-claimed tasks whose heartbeat stopped are marked blocked, never re-run:
   * the runner may have edited files before it died.
   */
  recoverStale(staleMs) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const res = this.db
      .prepare(
        `UPDATE messages SET status = 'blocked', cleanup_pending = 1,
           status_reason = 'runner stopped during work; check changed files before requeue',
           updated_at = ?
         WHERE kind = 'task' AND status = 'working' AND claimed_by LIKE 'runner:%' AND heartbeat_at < ?`,
      )
      .run(now(), cutoff);
    return Number(res.changes);
  }

  _parentCurrent(task) {
    const target = task.body.parent;
    if (!target) return task.message_id === task.root_id;
    const parent = this.get(target.message_id);
    const reply = this.get(target.reply_id);
    if (!parent || parent.root_id !== task.root_id || parent.attempt !== target.attempt
        || !reply || reply.reply_to !== parent.message_id || reply.attempt !== target.attempt
        || reply.body.current === false || parent.cancel_requested) return false;
    if (reply.kind === "question") return parent.status === "blocked" && parent.status_reason === "question";
    return reply.kind === "result" && parent.status === "ready" && reply.body.status !== "failed"
      && (parent.message_id === parent.root_id || this._parentCurrent(parent));
  }

  _advanceChain(root, task, reply) {
    const step = nextStep(task, reply.body);
    if (step === "review") {
      const previous = this.db.prepare(`SELECT thread_id FROM messages
        WHERE root_id = ? AND kind = 'task' AND recipient = 'claude-code' AND thread_id IS NOT NULL
        ORDER BY round, rowid LIMIT 1`).get(root.message_id);
      const packet = reviewTask(root, task, reply, previous?.thread_id ?? null);
      packet.file_refs = [...new Map([...packet.file_refs, ...root.write_files.map(path => ({ path }))]
        .map(ref => [ref.path, ref])).values()];
      this._queueChainTask(packet);
    } else if (step === "rework") {
      const implementation = this.get(task.body.parent.message_id);
      const packet = reworkTask(root, task, reply, implementation.thread_id);
      const allowed = [...root.body.file_refs.map(ref => ref.path), ...root.write_files]
        .map(file => pathKey(file, root.body.cwd));
      packet.file_refs = packet.file_refs.filter(ref => {
        const key = pathKey(ref.path, root.body.cwd);
        return allowed.some(scope => key === scope || key.startsWith(scope.endsWith("/") ? scope : `${scope}/`));
      });
      this._queueChainTask(packet);
    } else if (step === "final" || step === "exhausted") {
      const message = finalReply(root, task, reply, step);
      const existing = this.get(message.message_id);
      if (existing && (existing.root_id !== root.message_id || existing.kind !== "result")) {
        throw new Error("final message id collision");
      }
      const ts = now();
      this.db.prepare(`INSERT INTO messages (message_id, task_id, reply_to, sender, recipient, kind,
        status, body, created_at, updated_at, root_id, parent_id, round)
        VALUES (?, ?, ?, ?, ?, 'result', 'ready', ?, ?, ?, ?, ?, ?)
        ON CONFLICT (message_id) DO NOTHING`)
        .run(message.message_id, message.task_id, message.reply_to, message.sender, message.recipient,
          JSON.stringify(message.body), ts, ts, root.message_id, task.message_id, task.round);
      this.db.prepare("UPDATE messages SET scope_held = 0 WHERE message_id = ?").run(root.message_id);
    }
  }

  _queueChainTask(input) {
    const task = normaliseTask(input);
    const existing = this.get(task.message_id);
    if (!existing) return this._insertTask(task);
    if (existing.kind !== "task" || existing.root_id !== task.root_id || existing.body.role !== task.role) {
      throw new Error("chain message id collision");
    }
    if (existing.body.parent?.reply_id === task.parent.reply_id) return;
    // Keep the old target intact until its connector confirms termination.
    if (existing.status === "working" || existing.cleanup_pending) {
      this.db.prepare(`UPDATE messages SET body = ?, cancel_requested = 1, status_reason = 'superseded',
        updated_at = ? WHERE message_id = ?`)
        .run(JSON.stringify({ ...existing.body, pending_review: task }), now(), task.message_id);
    } else {
      this._resetChainTask(task, existing);
    }
  }

  _resetChainTask(task, existing) {
    if (existing.cleanup_pending) throw new Error('process stop confirmation required before chain reset');
    if (!existing.root_id || task.message_id !== existing.message_id || task.root_id !== existing.root_id) {
      throw new Error("chain reset identity mismatch");
    }
    const root = this.get(existing.root_id);
    if (!root || typeof task.cwd !== "string" || pathKey(task.cwd) !== pathKey(root.body.cwd)
        || !SANDBOXES.includes(task.sandbox)
        || (task.sandbox !== "read-only" && task.sandbox !== root.body.sandbox)) {
      throw new Error("chain reset exceeds root cwd or sandbox scope");
    }
    const allowed = root.write_files.map(file => pathKey(file, root.body.cwd));
    if (!Array.isArray(task.write_files) || task.write_files.some(file => {
      if (typeof file !== "string") return true;
      const key = pathKey(file, task.cwd);
      return !allowed.some(scope => key === scope || key.startsWith(scope.endsWith("/") ? scope : `${scope}/`));
    })) throw new Error("chain reset exceeds root write_files scope");
    task = { ...task, thread_id: existing.thread_id ?? task.thread_id };
    this._invalidateReplies(existing.message_id);
    this.db.prepare(`UPDATE messages SET body = ?, parent_id = ?, reply_to = ?, thread_id = ?,
      write_files = ?, status = 'queued', status_reason = NULL, cancel_requested = 0,
      claimed_by = NULL, heartbeat_at = NULL, turn_id = NULL, usage = NULL, updated_at = ?
      WHERE message_id = ?`)
      .run(JSON.stringify(task), task.parent.message_id, task.reply_to, task.thread_id,
        JSON.stringify(task.write_files), now(), task.message_id);
  }

  _invalidateReplies(messageId) {
    const replies = this.db.prepare("SELECT * FROM messages WHERE reply_to = ? AND kind IN ('result', 'question')").all(messageId);
    for (const row of replies) {
      this.db.prepare("UPDATE messages SET body = ?, delivered_at = COALESCE(delivered_at, ?) WHERE message_id = ?")
        .run(JSON.stringify({ ...JSON.parse(row.body), current: false }), now(), row.message_id);
    }
  }

  _supersedeDescendants(messageId) {
    const pending = [messageId];
    const seen = new Set(pending);
    while (pending.length) {
      const parentId = pending.shift();
      const children = this.db.prepare("SELECT * FROM messages WHERE kind = 'task' AND parent_id = ?").all(parentId);
      for (const row of children) {
        if (seen.has(row.message_id)) continue;
        seen.add(row.message_id);
        pending.push(row.message_id);
        const body = JSON.parse(row.body);
        delete body.pending_review;
        this.db.prepare(`UPDATE messages SET status = ?, status_reason = 'superseded', cancel_requested = 1,
          body = ?, updated_at = ? WHERE message_id = ?`)
          .run(row.status === "working" ? "working" : "cancelled", JSON.stringify(body), now(), row.message_id);
        this._invalidateReplies(row.message_id);
      }
    }
  }

  _afterStopped(messageId) {
    const task = this.get(messageId);
    const root = this.get(task.root_id);
    if (!root.cancel_requested && !task.cleanup_pending && task.status !== "blocked" && task.body.pending_review) {
      const pending = task.body.pending_review;
      if (this._parentCurrent({ body: pending, root_id: task.root_id, message_id: messageId })) this._resetChainTask(pending, task);
    }
    this._releaseCancelled(task.root_id);
  }

  _releaseCancelled(rootId) {
    const root = this.get(rootId);
    if (!root?.cancel_requested) return;
    const working = this.db.prepare(`SELECT 1 FROM messages WHERE root_id = ? AND kind = 'task'
      AND (status = 'working' OR cleanup_pending = 1 OR (status = 'blocked' AND cancel_requested = 1))`).get(rootId);
    if (!working) this.db.prepare("UPDATE messages SET scope_held = 0, status = 'cancelled' WHERE message_id = ?").run(rootId);
  }

  /** Read-only projection for future CLI/UI integration; ACK is not a verdict. */
  getChain(rootId) {
    const root = this.get(rootId);
    if (!root || root.root_id !== rootId) return null;
    const tasks = this.db.prepare("SELECT * FROM messages WHERE root_id = ? AND kind = 'task' ORDER BY round, rowid").all(rootId).map(decode);
    const latest = this.db.prepare(`SELECT * FROM messages WHERE root_id = ? AND kind = 'result'
      AND sender = 'claude-code' ORDER BY round DESC, rowid DESC`).all(rootId).map(decode)
      .find(reply => reply.body.current !== false && reply.body.status === "done");
    return { root_id: rootId, scope_held: root.scope_held, tasks,
      verdict: latest?.body.verdict ?? null, review: latest ?? null, final: this.get(`${rootId}:final`) };
  }

  /** Replay until the recipient explicitly acknowledges successful processing. */
  takeReplies(agent) {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE recipient = ? AND kind IN ('result', 'question')
           AND delivered_at IS NULL ORDER BY created_at, rowid`,
      )
      .all(agent)
      .map(decode);
  }

  ackReplies(agent, messageIds) {
    requireOneOf(agent, AGENTS, "recipient");
    return this.transaction(() => {
      for (const id of messageIds) {
        const row = this.get(id);
        if (!row || row.recipient !== agent || !["result", "question"].includes(row.kind)) {
          throw new Error(`reply ${id} does not belong to recipient ${agent}`);
        }
        this.db.prepare("UPDATE messages SET delivered_at = COALESCE(delivered_at, ?) WHERE message_id = ?").run(now(), id);
      }
    });
  }

  listTasks({ taskId = null, limit = 20 } = {}) {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at, rowid").all(taskId)
      : this.db
          .prepare("SELECT * FROM messages WHERE kind = 'task' ORDER BY created_at DESC, rowid DESC LIMIT ?")
          .all(limit);
    return rows.map(decode);
  }
}

/** Hashes of every file a task refers to or may write, taken when its reply is produced. */
export function snapshotHashes(task) {
  const files = [...new Set([...task.file_refs.map((r) => r.path), ...task.write_files])];
  return Object.fromEntries(files.map((file) => [file, hashFile(task.cwd, file)]));
}

/** Files whose content changed since the reply was produced; a non-empty list means the reply is stale. */
export function staleInputs(reply) {
  const { input_hashes: hashes = {}, cwd } = reply?.body ?? {};
  return Object.entries(hashes)
    .filter(([file, hash]) => hashFile(cwd, file) !== hash)
    .map(([file]) => file);
}

function decode(row) {
  if (!row) return null;
  return {
    ...row,
    body: JSON.parse(row.body),
    write_files: JSON.parse(row.write_files),
    usage: row.usage ? JSON.parse(row.usage) : null,
    recovery: JSON.parse(row.recovery ?? "[]"),
    cancel_requested: row.cancel_requested === 1,
  };
}
