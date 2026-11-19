// Shared queue lifecycle. Only an injected connector may execute an agent.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {hashFile,pathKey} from './store.mjs';
import {prepareContext} from './context.mjs';
import {createProgramConnector,programConfig} from './program-runner.mjs';
import {reuseKey,findReusable,rememberResult} from './reuse.mjs';
import {zeroUsage} from './usage.mjs';
import {inspectContract,verifyProgramEnvironment} from './contracts.mjs';
import {observeWorkspace,compareWorkspace} from './changes.mjs';
import {decideRecovery,loadFallbacks} from './recovery.mjs';
import {communicationPolicy,snapshotNativeSettings,verifyNativeSettings} from './communication.mjs';
import {loadProfiles,resolveProfile,replyPacket,DEFAULT_PROFILES} from './profiles.mjs';

export async function runAgentTask(store, claimed, connector, options = {}) {
  const finished = await runAttempt(store, claimed, connector, options);
  return finished?.status === "blocked" ? recoverBlocked(store, claimed, options) : finished;
}

/** A blocked attempt may go back to the queue by itself only when the recovery rules allow it. */
function recoverBlocked(store, claimed, options) {
  const row = store.get(claimed.message_id);
  if (row?.attempt !== claimed.attempt || row.claimed_by !== claimed.claimed_by) return row;
  const receipt = store.listRuntime(row.message_id).find(entry => entry.attempt === row.attempt);
  const decision = decideRecovery({ row, receipt, profile: row.body.profile ?? options.profile ?? "standard",
    fallbacks: loadFallbacks(options.recoveryFile) });
  return decision ? store.recoverTask(row.message_id, claimed, decision) : row;
}

async function runAttempt(store, claimed, connector, options = {}) {
  const { signal, heartbeatMs = 15_000, cancelPollMs = 1_000, turnTimeoutMs = 0 } = options;
  const id = claimed.message_id;
  const task = claimed.root_id ? { ...claimed.body, thread_id: claimed.thread_id } : claimed.body;
  if (task.sandbox !== "read-only" && !options.allowWrite) {
    store.setStatus(id, "blocked", "write task needs a runner started with --allow-write", claimed);
    return store.get(id);
  }
  if (task.sandbox === "danger-full-access" && !options.allowFullAccess) {
    store.setStatus(id, "blocked", "full access task needs a runner started with --allow-full-access", claimed);
    return store.get(id);
  }

  let interrupting = false;
  let timeout;
  let closing;
  let executing=false;
  const close = () => closing ??= Promise.resolve().then(() => connector?.close?.()).then(() => {
    const current=store.get(id);
    if (current?.cleanup_pending && current.attempt===claimed.attempt && current.claimed_by===claimed.claimed_by)
      store.confirmStopped(id,claimed.attempt);
  });
  const timers = [];
  const interrupt = () => {
    if (interrupting || !store.isCancelRequested(id)) return;
    interrupting = true;
    Promise.resolve().then(() => connector.interrupt()).catch(() => {}).finally(() => {
      interrupting = false;
    });
  };
  const abort = () => {
    const current = store.get(id);
    if (current?.status !== "working" || current.attempt !== claimed.attempt || current.claimed_by !== claimed.claimed_by) return;
    store.requestCancel(id);
    interrupt();
  };
  const context = { store, claimed, task, options, signal, ready: interrupt };
  const saveUsage = () => {
    if(!executing)return null;
    const usage = connector?.usage?.();
    if (usage?.thread_total || usage?.turn) store.saveUsage(id, usage, claimed);
    return usage ?? null;
  };
  // A connector that cannot count tool calls leaves the count unknown, never zero.
  const saveActivity = () => {
    if (executing) store.saveRuntime(id, { activity: { tool_calls: connector?.activity?.()?.tool_calls ?? null } }, claimed);
  };
  let workspaceBefore, changeExclusions, observedAfter = false;
  const observeAfter = () => {
    if (!workspaceBefore || observedAfter) return null;
    observedAfter = true;
    const observation = compareWorkspace(task, workspaceBefore, observeWorkspace(task, { exclusions: changeExclusions }));
    store.saveRuntime(id, { change_observation: observation }, claimed);
    return observation;
  };
  try {
    if (signal?.aborted) {
      if (claimed.root_id) store.requestCancel(id);
      store.setStatus(id, "cancelled", "runner stopped before start", claimed);
      return store.get(id);
    }
    timers.push(setInterval(() => store.heartbeat(id, claimed), heartbeatMs));
    timers.push(setInterval(interrupt, cancelPollMs));
    signal?.addEventListener("abort", abort, { once: true });
    Object.assign(task,prepareContext(store,task));
    if(task.browser_context&&claimed.browser_space_id!==task.browser_context.space_id)throw new Error('browser context changed before execution; claim again with the current browser reference');
    task.profile ??= options.profile ?? 'standard';
    const profileConfig=loadProfiles(options.profilesPath);
    const nativeSettings=snapshotNativeSettings(task,{...options,profilesPath:options.profilesPath??DEFAULT_PROFILES,profiles:profileConfig});
    task.communication=communicationPolicy(task,nativeSettings.required_hooks,nativeSettings.files);
    store.saveRuntime(id,{communication:{...task.communication,native_settings:nativeSettings.files,
      usage_coverage:'bridge-attempts-and-explicit-external-events'}},claimed);
    if(task.contract){
      task.contract_environment=inspectContract(task);store.bindContractEnvironment(task,task.contract_environment);
      store.saveRuntime(id,{contract_environment:task.contract_environment},claimed);
    }
    let executionFiles=[];
    let resolvedProgram;
    if(task.execution?.adapter){
      resolvedProgram=programConfig(task,options);
      const sharedProgram=verifyProgramEnvironment(task,resolvedProgram);
      if(sharedProgram)store.saveRuntime(id,{contract_program:sharedProgram},claimed);
      executionFiles=Object.keys(resolvedProgram.code_hashes);
      if(!store.bindReadScopes(id,executionFiles,claimed))return store.get(id);
    }
    Object.assign(claimed.body,task);
    const key=reuseKey(task,{...options,resolvedProgram}),cached=findReusable(store,key,task);
    if(store.isCancelRequested(id)){store.setStatus(id,'cancelled','cancelled before execution',claimed);return store.get(id);}
    if(cached){
      if(reuseKey(task,options)!==key)throw new Error('reuse dependency changed before reuse');
      const usage=zeroUsage('reused');
      store.saveUsage(id,usage,claimed);store.saveRuntime(id,{execution:'reused',reused_from:cached.source,fingerprint:cached.fingerprint},claimed);
      const {thread_id,delivery,input_versions,changed_files,...result}=cached.reply;
      store.finishTask(id,{claim:claimed,outcome:'result',usage,reply:{...result,reused_artifacts:changed_files,
        changed_files:{reported:[],observed:[],outside_scope:[],changes:[]},reused_from:cached.source},expectedHandoffs:task.handoffs});
      return store.get(id);
    }
    connector=task.execution?.adapter?createProgramConnector(claimed,{...options,resolvedProgram}):typeof connector==='function'?connector():connector;
    const dbFile=store.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
    const concurrent=store.db.prepare("SELECT message_id,root_id,body FROM messages WHERE kind='task' AND (status='working' OR scope_held=1 OR cleanup_pending=1)").all()
      .filter(row=>row.message_id!==id && row.message_id!==claimed.root_id && !(claimed.root_id && row.root_id===claimed.root_id))
      .flatMap(row=>{const body=JSON.parse(row.body);return body.write_files.map(file=>pathKey(file,body.cwd));});
    changeExclusions=[...concurrent,...(dbFile?[dbFile,dbFile+'-wal',dbFile+'-shm']:[])];
    const observedBefore=observeWorkspace(task,{exclusions:changeExclusions});
    if(!observedBefore.complete)throw new Error(`change observation unavailable: ${observedBefore.reason}`);
    workspaceBefore=observedBefore;
    const exclusions=[...task.write_files,...(dbFile?[dbFile,dbFile+'-wal',dbFile+'-shm']:[])].map(file=>pathKey(file,task.cwd));
    const inputs=[...new Set([...task.file_refs.map(ref=>ref.path),...executionFiles])];
    const snapshot=()=>Object.fromEntries(inputs.map(file=>[file,hashFile(task.cwd,file,exclusions)]));
    const inputBefore=snapshot();
    for(const ref of task.context)if(hashFile(task.cwd,ref.path)!==ref.hash)throw new Error(`context source changed before execution: ${ref.path}`);
    const execute = task.thread_id ? connector.resume : connector.execute;
    executing=true;
    const running = execute.call(connector, context);
    const waits = [running];
    const timeoutMs = task.role === "review" ? task.chain?.review_timeout_ms ?? turnTimeoutMs : turnTimeoutMs;
    if (timeoutMs > 0) {
      waits.push(new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(task.role === "review" ? "review timeout" : `turn exceeded ${timeoutMs}ms`)), timeoutMs);
      }));
    }
    const output = await Promise.race(waits);
    const parsed = await connector.parse(output, context);
    if(task.contract&&parsed.reply)store.saveRuntime(id,{contract_response:structuredClone(parsed.reply)},claimed);
    saveUsage();
    // Cancellation becomes terminal only after the connector has stopped.
    await close();
    const observation=observeAfter();
    if(parsed.status==='cancelled'){
      store.setStatus(id,'cancelled',parsed.reason ?? null,claimed);
      return store.get(id);
    }
    const inputAfter=snapshot();
    const changed=inputs.filter(file=>inputBefore[file]!==inputAfter[file]);
    const receipt=store.listRuntime(id).find(row=>row.attempt===claimed.attempt) ?? {};
    verifyNativeSettings(parsed.status||connector.communication!==true?{...nativeSettings,required_hooks:[]}:nativeSettings,receipt);
    if(connector.communication===true&&!receipt.communication_delivery?.verified&&receipt.execution!=='program-review')throw new Error('communication delivery verification missing');
    if(parsed.reply){
      parsed.reply.communication_receipt={version:1,rules_hash:task.communication.rules_hash,task_hash:task.communication.task_hash,
        profile:task.profile,delivery_verified:receipt.communication_delivery?.verified===true||receipt.execution==='program-review',settings_preserved:true,
        required_hooks:nativeSettings.required_hooks,usage_coverage:'bridge-attempts-and-explicit-external-events'};
      parsed.reply.communication_receipt.native_runtime_inventory=receipt.config_verified===true?'verified':'not-exposed';
      if(task.browser_context)parsed.reply.browser_context=task.browser_context;
      if(parsed.reply.delivery)Object.assign(parsed.reply.delivery,{communication_receipt:parsed.reply.communication_receipt,
        ...(task.browser_context?{browser_context:task.browser_context}:{})});
      else parsed.reply.delivery=replyPacket(parsed.reply,resolveProfile(profileConfig,task.profile));
      store.saveRuntime(id,{communication_verification:parsed.reply.communication_receipt},claimed);
    }
    const inputVersions={before:inputBefore,after:inputAfter,changed,exclusions};
    store.saveRuntime(id,{...receipt,input_versions:inputVersions},claimed);
    if (changed.length) {
      store.setStatus(id,'blocked',`input changed during execution: ${changed.join(', ')}`,claimed);
      return store.get(id);
    }
    if(!observation.complete || observation.outside_scope.length){
      store.setStatus(id,'blocked',!observation.complete?`change observation unavailable: ${observation.reason}`
        :`observed writes outside task scope: ${observation.outside_scope.join(', ')}`,claimed);
      return store.get(id);
    }
    if(parsed.reply){
      const reported=parsed.reply.changed_files?.reported ?? [];
      const writes=task.write_files.map(file=>pathKey(file,task.cwd));
      const outside=reported.filter(file=>{const key=pathKey(file,task.cwd);return !writes.some(scope=>key===scope || key.startsWith(`${scope}/`));});
      // An observed write outside scope has already blocked above; a reported-only one stays visible for review.
      parsed.reply.changed_files={reported,observed:observation.observed,outside_scope:outside,changes:observation.changes};
      if(parsed.reply.delivery)parsed.reply.delivery.changed_files=parsed.reply.changed_files;
    }
    if(parsed.reply)parsed.reply.input_versions=inputVersions;
    if (parsed.status) {
      const cancelled = claimed.root_id && store.isCancelRequested(id);
      store.setStatus(id, cancelled ? "cancelled" : parsed.status, parsed.reason ?? null, claimed);
    } else {
      store.finishTask(id, { claim: claimed, ...parsed,expectedHandoffs:task.handoffs });
      if(key&&reuseKey(task,options)===key)rememberResult(store,key,task,claimed);
    }
    return store.get(id);
  } catch (error) {
    let cleanupError;
    await close().catch(failure => { cleanupError = failure; });
    // A failed run is also compared, so recovery can tell whether it left any change behind.
    try { observeAfter(); } catch {}
    saveUsage();
    const cancelled = !cleanupError && task.chain?.review && store.isCancelRequested(id);
    store.setStatus(id, cancelled ? "cancelled" : "blocked",
      cleanupError ? `runner cleanup failed: ${cleanupError.message}` : cancelled ? "interrupted on request"
        : error.message === "review timeout" ? "review timeout" : `runner error: ${error.message}`, claimed);
    return store.get(id);
  } finally {
    clearTimeout(timeout);
    for (const timer of timers) clearInterval(timer);
    signal?.removeEventListener("abort", abort);
    await close().catch(() => {});
    saveUsage();
    saveActivity();
    await connector?.settled?.(context);
  }
}

/** One shared polling loop; idle checks never invoke the model. */
export async function runAgentWorker(store, options) {
  const { recipient, createConnector, once = false, pollMs = 2_000, staleMs = 120_000,
    log = () => {}, signal } = options;
  const runnerId = `runner:${recipient}:${process.pid}:${randomUUID().slice(0, 8)}`;
  while (!signal?.aborted) {
    const recovered = store.recoverStale(staleMs);
    if (recovered) log(`중단된 작업 ${recovered}건을 blocked로 표시했습니다. 변경 파일을 확인한 뒤 requeue하세요.`);
    const claimed = store.claimTask(recipient, runnerId);
    if (!claimed) {
      if (once) break;
      await sleep(pollMs, undefined, { signal }).catch(() => {});
      continue;
    }
    log(`작업 시작: ${claimed.message_id}`);
    let finished;
    try {
      finished = await runAgentTask(store, claimed, ()=>createConnector(claimed, options), options);
    } catch(error) {
      store.setStatus(claimed.message_id,'blocked',`connector setup failed: ${error.message}`,claimed);
      finished=store.get(claimed.message_id);
    }
    log(`작업 종료: ${finished.message_id} → ${finished.status}${finished.status_reason ? ` (${finished.status_reason})` : ""}`);
  }
}

