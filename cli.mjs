#!/usr/bin/env node
// agent-bridge CLI: queue tasks between Claude Code and Codex and read replies.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from "node:util";

import { runCodexWorker, openProfileRuntime } from "./codex-runner.mjs";
import { runClaudeWorker, runBridgeWorkers } from './claude-runner.mjs';
import { AGENTS, BridgeStore, defaultDbPath, snapshotHashes, staleInputs,hashFile,pathKey } from "./store.mjs";
import { loadProfiles, resolveProfile, profileSummary, taskPacket, replyPacket, DEFAULT_PROFILES } from './profiles.mjs';
import { listWorktrees, createWorktree, setWorktreeLocked, verifyWorktree } from './worktrees.mjs';
import { startDashboard } from './server.mjs';
import { callAdapter } from './adapters.mjs';
import { loadTemplates, expandTemplate } from './templates.mjs';
import {runGeminiWorker} from './gemini-runner.mjs';
import {communicationPolicy,snapshotNativeSettings,verifyNativeSettings,verifyCommunication} from './communication.mjs';
import {observeWorkspace,compareWorkspace} from './changes.mjs';
import {applyWorkflow,compilePlan,sendPlan} from './workflow.mjs';
import {bindContract,inspectContract,wirePacket,verifyWire} from './contracts.mjs';
import {prepareContext} from './context.mjs';
import {classifyFailure} from './failures.mjs';

const USAGE = `사용법: agent-bridge <명령> [옵션]   (소스에서 실행: node cli.mjs <명령>)

  send <file.json|->            작업 봉투를 큐에 넣는다 (message_id가 같으면 다시 넣지 않음)
  status [--task <task_id>]     작업 상태와 사용량을 본다
  usage --project <project_id>  프로젝트의 시도별 사용량을 합산한다 (미측정 항목 별도)
  record-usage <file.json>      별도 프로세스의 실제 사용량 증거를 중복 없이 기록한다
  send-plan <file.json> [--workflow <외부 역할 JSON>]  단계 의존성이 있는 프로젝트를 큐에 넣는다
  contract-inspect <file.json> --repo <작업 폴더>  공통 계약과 선언된 원본·실행환경을 검증한다
  receive --as <agent>          ACK 전 결과·질문을 받는다 (--take-tasks: 나에게 온 작업도 맡는다)
  ack <reply_id> --as <agent>   결과를 처리한 뒤 수신 확인한다
  reply --to <message_id> --attempt <n> --summary <text> [--status done|failed|question]
        [--question <text>] [--acceptance <json>] [--changed a,b] [--contract-receipt <json>]
                                직접 맡은 작업에 회신한다
  cancel <message_id>           대기 작업은 바로 취소, 진행 중이면 중단을 요청한다
  requeue <message_id>          blocked 작업을 다시 대기열에 넣는다
  confirm-stopped <message_id> --attempt <n>  실제 프로세스 종료를 확인한 시도의 잠금을 해제한다
  run-codex [--once] [--allow-write] [--allow-full-access] [--profile name] [--poll-ms n] [--stale-ms n]
                                Codex 실행기를 돌린다
  run [--once] [--workers n] [--allow-write]  Codex·Claude 실행기를 함께 돌린다
  run-claude [--once] [--allow-write]  Claude 일반 작업·검토 실행기를 돌린다
  run-gemini [--once] [--gemini-cli path]  Google 계정의 Antigravity CLI로 Gemini 실행기를 돌린다
  profiles                      프로필과 입출력 설정을 본다
  inspect-profile [--profile name]  모델 호출 없이 실제 훅·플러그인 적용을 확인한다
  serve [--repo path] [--port n] [--workers n] [--allow-write]  로컬 작업 현황 화면을 연다
  worktrees [--repo path]        Git worktree를 조회한다
  worktree-create <name> [--repo path] [--base ref]  별도 작업 폴더를 만든다
  worktree-lock <path> [--repo path]  worktree를 잠근다
  worktree-unlock <path> [--repo path]  worktree 잠금을 해제한다
  call-adapter <name> <file.json|-> --profile name  선택 필드만 로컬 어댑터에 전달한다

공통: --db <path> (기본 ${defaultDbPath()}, 환경변수 AGENT_BRIDGE_DB), --profiles <path>
agent: ${AGENTS.join(", ")}
send 옵션: --workflow <외부 JSON> --workflow-role <역할 이름>
공통 계약: send/send-plan --contract <외부 계약 JSON> 또는 봉투/계획의 contract 필드
회신 후속 작업: send task.json --reply-to <reply_id> [--followup-key <단계 이름>]
Gemini 경로: --gemini-cli <agy 실행 파일> 또는 ~/.agent-bridge/clients.json의 gemini.executable`;

const OPTIONS = {
  db: { type: "string" },
  task: { type: "string" },
  project: {type:'string'},
  contract:{type:'string'},
  'contract-receipt':{type:'string'},
  limit: { type: "string" },
  as: { type: "string" },
  "take-tasks": { type: "boolean" },
  to: { type: "string" },
  attempt: { type: "string" },
  summary: { type: "string" },
  status: { type: "string" },
  question: { type: "string" },
  acceptance: { type: "string" },
  changed: { type: "string" },
  once: { type: "boolean" },
  "allow-write": { type: "boolean" },
  "allow-full-access": { type: "boolean" },
  lean: { type: "boolean" },
  profiles: { type: 'string' },
  profile: { type: 'string' },
  workflow: { type: 'string' },
  'reply-to': { type: 'string' },
  'followup-key': { type: 'string' },
  'workflow-role': { type: 'string' },
  'gemini-cli': { type: 'string' },
  repo: { type: 'string' },
  port: { type: 'string' },
  workers: { type: 'string' },
  base: { type: 'string' },
  worktree: { type: 'string' },
  "poll-ms": { type: "string" },
  "stale-ms": { type: "string" },
  help: { type: "boolean", short: "h" },
};

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readEnvelope(source) {
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  return JSON.parse(text.replace(/^﻿/, ""));
}

function contractOption(task,file){
  if(!file)return task;
  // Only the contract hashes are compared here; review selection is checked when each task is bound.
  const selected=bindContract({...task,contract:file,contract_review_ids:[]});
  if(task.contract&&bindContract({...task,contract_review_ids:[]}).contract.hash!==selected.contract.hash)throw new Error('contract option conflicts with envelope');
  return {...task,contract:file};
}

/** Short reply view for the receiving agent: no raw logs, only what it needs to act. */
function replyView(row) {
  const b = row.body.delivery ?? row.body;
  return {
    message_id: row.message_id,
    attempt: row.attempt,
    task_id: row.task_id,
    reply_to: row.reply_to,
    kind: row.kind,
    from: row.sender,
    status: b.status,
    summary: b.summary,
    verdict: b.verdict,
    criteria: b.criteria,
    findings: b.findings,
    boundary_review: b.boundary_review,
    root_id: b.root_id,
    round: b.round,
    question: b.question,
    acceptance: b.acceptance,
    contract_receipt:b.contract_receipt,
    communication_receipt:b.communication_receipt,
    browser_context:b.browser_context,
    coalesced_from:b.coalesced_from,
    reused_artifacts:b.reused_artifacts,
    changed_files: b.changed_files,
    final_text: b.final_text ?? undefined,
    thread_id: b.thread_id,
    turn_id: b.turn_id,
    stale_inputs: staleInputs(row),
    turn_usage: row.usage?.turn ?? null,
    calls: row.usage?.calls ?? null,
    projection: row.body.projection,
  };
}

function taskView(row) {
  return {
    message_id: row.message_id,
    attempt: row.attempt,
    task_id: row.task_id,
    route: `${row.sender}->${row.recipient}`,
    project_id:row.body.project_id ?? row.task_id,
    depends_on:row.body.depends_on?.length?row.body.depends_on:undefined,
    status: row.status,
    reason: row.status_reason,
    failure: classifyFailure(row.status,row.status_reason) ?? undefined,
    retry_at: row.status==='queued' && row.not_before ? row.not_before : undefined,
    recovery: row.recovery?.length ? row.recovery : undefined,
    cancel_requested: row.cancel_requested || undefined,
    cleanup_pending: !!row.cleanup_pending,
    thread_id: row.thread_id,
    turn_usage: row.usage?.turn ?? null,
    calls: row.usage?.calls ?? null,
    updated_at: row.updated_at,
  };
}

export async function main(argv, workerOptions = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, arg] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const store = new BridgeStore(values.db ?? defaultDbPath());
  const profilesPath=values.profiles ?? DEFAULT_PROFILES;
  const repo=path.resolve(values.repo ?? process.cwd());
  try {
    switch (command) {
      case "send": {
        if (!arg) throw new Error("send에는 봉투 파일 경로나 -가 필요합니다");
        let envelope = readEnvelope(arg);
        if (Object.hasOwn(envelope, 'template')) envelope = expandTemplate(envelope, loadTemplates());
        if(values.workflow) envelope=applyWorkflow(envelope,values.workflow,values['workflow-role']);
        if(values['reply-to']) envelope.reply_to=values['reply-to'];
        if(values['followup-key']) envelope.followup_key=values['followup-key'];
        if(values.profile) envelope.profile=values.profile;
        envelope=contractOption(envelope,values.contract);
        resolveProfile(loadProfiles(profilesPath),envelope.profile ?? 'standard');
        if(values.worktree) {envelope.cwd=verifyWorktree(repo,values.worktree);envelope.worktree=envelope.cwd;}
        if (!envelope.message_id) {
          envelope.message_id = `msg-${randomUUID()}`;
          console.error(`message_id가 없어 ${envelope.message_id}로 만들었습니다. 재전송 시 같은 값을 써야 중복이 막힙니다.`);
        }
        const out = store.sendTask(envelope);
        if (out.duplicate && !out.sameContent) {
          console.error("같은 message_id로 내용이 다른 작업이 이미 있습니다. 기존 작업을 유지했습니다.");
        }
        print({ duplicate: out.duplicate, ...taskView(out.message) });
        return 0;
      }
      case 'usage':
        if(!values.project)throw new Error('--project is required');
        print(store.projectUsage(values.project));return 0;
      case 'record-usage':
        print(store.recordExternalUsage(readEnvelope(arg)));return 0;
      case 'send-plan': {
        const tasks=compilePlan(contractOption(readEnvelope(arg),values.contract),{workflowFile:values.workflow});
        print(sendPlan(store,tasks).map(saved=>({duplicate:saved.duplicate,...taskView(saved.message)})));return 0;
      }
      case 'contract-inspect': {
        const task=bindContract({contract:arg,cwd:repo,goal:'inspect',acceptance:[],file_refs:[],write_files:[],sandbox:'read-only',contract_review_ids:[]});
        print({contract_hash:task.contract.hash,requirement_ids:task.contract.document.requirements.map(r=>r.id),review_ids:task.contract.document.review.criteria.map(c=>c.id),...inspectContract(task)});return 0;
      }
      case "status": {
        const rows = store.listTasks({ taskId: values.task ?? null, limit: Number(values.limit ?? 20) });
        for (const row of rows) {
          const chain = row.root_id ? store.getChain(row.root_id) : null;
          print(row.kind === "task" ? { ...taskView(row), attempt_usage: store.listUsage(row.message_id), runtime:store.listRuntime(row.message_id),
            ...(chain ? { chain: { root_id: chain.root_id, round: row.round, scope_held: chain.scope_held,
              verdict: chain.verdict, final_status: chain.final?.body.status ?? null } } : {}) } : replyView(row));
        }
        return 0;
      }
      case "receive": {
        if (!AGENTS.includes(values.as)) throw new Error(`--as는 ${AGENTS.join(", ")} 중 하나여야 합니다`);
        for (const row of store.takeReplies(values.as)) print(replyView(row));
        if (values["take-tasks"]) {
          let claimed;
          while ((claimed = store.claimTask(values.as, `manual:${values.as}`))) {
            const profile=resolveProfile(loadProfiles(profilesPath),claimed.body.profile ?? 'standard');
            const metadata=Object.fromEntries(['message_id','task_id','sender','recipient','cwd','model','effort','thread_id'].map(k=>[k,claimed.body[k]]));
            const packet={ ...metadata, ...taskPacket(claimed.body,profile), profile:profile.id, kind: "task", attempt: claimed.attempt };
            try{
              const task={...prepareContext(store,claimed.body),profile:profile.id};
              if(task.browser_context&&claimed.browser_space_id!==task.browser_context.space_id)throw new Error('browser context changed before execution');
              const settings=snapshotNativeSettings(task,{profilesPath,profiles:loadProfiles(profilesPath)});
              task.communication=communicationPolicy(task,settings.required_hooks,settings.files);
              Object.assign(packet,taskPacket(task,profile));
              const file=store.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
              const exclusions=file?[file,file+'-wal',file+'-shm']:[];
              const workspace=observeWorkspace(task,{exclusions});if(!workspace.complete)throw new Error('change observation unavailable: '+workspace.reason);
              store.saveRuntime(claimed.message_id,{manual_native_settings:settings,manual_communication:task.communication,
                manual_browser_context:task.browser_context,manual_workspace:workspace,manual_exclusions:exclusions,
                communication_delivery:verifyCommunication(task,packet),manual_handoffs:task.handoffs.map(({result,...marker})=>marker)},claimed);
            }catch(error){store.setStatus(claimed.message_id,'blocked','manual communication preflight: '+error.message,claimed);print(taskView(store.get(claimed.message_id)));continue;}
            if(claimed.body.contract){
              try{
                const task=prepareContext(store,claimed.body),environment=inspectContract(task);task.contract_environment=environment;
                store.bindContractEnvironment(task,environment);
                Object.assign(packet,taskPacket(task,profile),wirePacket(task));
                const exclusions=task.write_files.map(file=>pathKey(file,task.cwd));
                const manual_input_hashes=Object.fromEntries(task.file_refs.map(ref=>[ref.path,hashFile(task.cwd,ref.path,exclusions)]));
                for(const ref of task.context)if(hashFile(task.cwd,ref.path)!==ref.hash)throw new Error('contract context changed before manual delivery');
                store.saveRuntime(claimed.message_id,{contract_environment:environment,contract_delivery:verifyWire(task,packet),manual_input_hashes,
                  contract_handoffs:task.handoffs.map(({result,...marker})=>marker)},claimed);
              }catch(error){store.setStatus(claimed.message_id,'blocked',`manual contract preflight: ${error.message}`,claimed);print(taskView(store.get(claimed.message_id)));continue;}
            }
            print(packet);
          }
        }
        return 0;
      }
      case "ack": {
        if (!arg) throw new Error("ack에는 회신 message_id가 필요합니다");
        store.ackReplies(values.as, [arg]);
        print({ message_id: arg, acknowledged: true });
        return 0;
      }
      case "reply": {
        const task = store.get(values.to ?? "");
        if (!task || task.kind !== "task") throw new Error("--to에 작업 message_id가 필요합니다");
        if (task.status !== "working" || !String(task.claimed_by).startsWith("manual:")) {
          throw new Error(`직접 맡은 진행 중 작업에만 회신할 수 있습니다 (현재 ${task.status}, ${task.claimed_by ?? "미할당"})`);
        }
        if (Number(values.attempt) !== task.attempt) throw new Error("--attempt가 현재 실행 시도와 일치해야 합니다");
        const status = values.status ?? "done";
        const reply = {
          status,
          summary: values.summary ?? null,
          question: values.question ?? null,
          acceptance: values.acceptance ? JSON.parse(values.acceptance) : [],
          changed_files: { reported: values.changed ? values.changed.split(",").map((s) => s.trim()) : [] },
          cwd: task.body.cwd,
          input_hashes: snapshotHashes(task.body),
          ...(values['contract-receipt']?{contract_receipt:JSON.parse(values['contract-receipt'])}:{}),
        };
        const outcome = status === "question" ? "question" : "result";
        const profile=resolveProfile(loadProfiles(profilesPath),task.body.profile ?? 'standard');
        const runtime=store.listRuntime(task.message_id).find(row=>row.attempt===task.attempt);
        if(runtime?.manual_native_settings){
          verifyNativeSettings({...runtime.manual_native_settings,required_hooks:[]},runtime);
          const observation=compareWorkspace(task.body,runtime.manual_workspace,observeWorkspace(task.body,{exclusions:runtime.manual_exclusions}));
          if(!observation.complete||observation.outside_scope.length)throw new Error('manual writes outside task scope or change observation unavailable');
          reply.changed_files={...reply.changed_files,observed:observation.observed,changes:observation.changes};
          const policy=runtime.manual_communication;
          reply.communication_receipt={version:1,rules_hash:policy.rules_hash,task_hash:policy.task_hash,profile:policy.profile,
            delivery_verified:runtime.communication_delivery?.verified===true,settings_preserved:true,required_hooks:[],native_runtime_inventory:'not-exposed',
            usage_coverage:'bridge-attempts-and-explicit-external-events',execution:'manual'};
          if(runtime.manual_browser_context)reply.browser_context=runtime.manual_browser_context;
        }
        reply.delivery=replyPacket(reply,profile);
        reply.projection={profile:profile.id};
        if(runtime?.manual_input_hashes){
          const exclusions=task.body.write_files.map(file=>pathKey(file,task.body.cwd));
          if(Object.entries(runtime.manual_input_hashes).some(([file,hash])=>hashFile(task.body.cwd,file,exclusions)!==hash))throw new Error('contract input changed since manual delivery');
          store.saveRuntime(task.message_id,{contract_response:reply},task);
        }
        const saved = store.finishTask(task.message_id, { claim: task, outcome, reply,expectedHandoffs:runtime?.contract_handoffs ?? runtime?.manual_handoffs ?? [] });
        print(replyView(saved));
        return 0;
      }
      case "cancel":
        print({ message_id: arg, cancel: store.requestCancel(arg) });
        return 0;
      case "requeue":
        print(taskView(store.requeue(arg)));
        return 0;
      case 'confirm-stopped':
        print(taskView(store.confirmStopped(arg,Number(values.attempt))));
        return 0;
      case "run": case "run-claude": case "run-codex": case "run-gemini": {
        if (values.lean) console.error('--lean은 이제 필수 훅을 유지하는 review 프로필 별칭입니다.');
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        try {
          const run = command === 'run' ? runBridgeWorkers : command === 'run-claude' ? runClaudeWorker : command==='run-gemini'?runGeminiWorker:runCodexWorker;
          await run(store, {
            ...workerOptions,
            ...(command==='run-gemini'?{cliPath:values['gemini-cli']}:{gemini:{...workerOptions.gemini,cliPath:values['gemini-cli'] ?? workerOptions.gemini?.cliPath}}),
            once: values.once,
            allowWrite: values["allow-write"],
            allowFullAccess: values["allow-full-access"],
            workers: Number(values.workers ?? 1),
            profilesPath,
            profile:values.profile ?? (values.lean?'review':'standard'),
            pollMs: Number(values["poll-ms"] ?? 2000),
            staleMs: Number(values["stale-ms"] ?? 120000),
            signal: controller.signal,
            log: (line) => console.error(line),
          });
        } finally {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
        return 0;
      }
      case 'profiles': print(profileSummary(loadProfiles(profilesPath))); return 0;
      case 'inspect-profile': {
        const profile=resolveProfile(loadProfiles(profilesPath),values.profile ?? 'standard');
        const runtime=await openProfileRuntime({cwd:repo,profile});
        try {print(runtime.receipt);} finally {await runtime.client.close();}
        return 0;
      }
      case 'serve': {
        const port=Number(values.port ?? 0);
        if(!Number.isInteger(port)||port<0||port>65535) throw new Error('invalid port');
        const app=await startDashboard({store,repo,port,profilesPath,workers:Number(values.workers ?? 1),allowWrite:!!values['allow-write'],workerOptions});
        print({url:app.url,allow_write:!!values['allow-write']});
        await new Promise(resolve=>{
          const stop=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);resolve();};
          process.once('SIGINT',stop);process.once('SIGTERM',stop);
        });
        await app.close(); return 0;
      }
      case 'worktrees': print(listWorktrees(repo)); return 0;
      case 'worktree-create': print(createWorktree(repo,{name:arg,base:values.base ?? 'HEAD'})); return 0;
      case 'worktree-lock': case 'worktree-unlock':
        if(!arg) throw new Error('worktree path required');
        print(setWorktreeLocked(repo,arg,command==='worktree-lock')); return 0;
      case 'call-adapter': {
        if(!positionals[2]) throw new Error('adapter input file required');
        const result=await callAdapter(loadProfiles(profilesPath),values.profile ?? 'standard',arg,readEnvelope(positionals[2]),{cwd:repo});
        const dir=path.join(path.dirname(path.resolve(values.db ?? defaultDbPath())),'adapter-runs'); mkdirSync(dir,{recursive:true});
        const receiptPath=path.join(dir,`${result.id}.json`); writeFileSync(receiptPath,JSON.stringify(result,null,2));
        const {full_output,stderr,...output}=result; print({...output,receipt_path:receiptPath});
        return result.status==='completed'?0:1;
      }
      default:
        console.error(`알 수 없는 명령: ${command}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`오류: ${err.message}`);
    process.exitCode = 1;
  },
);
