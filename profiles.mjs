import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_PROFILES = fileURLToPath(new URL('./profiles.json', import.meta.url));
const INPUT = ['goal','acceptance','write_files','sandbox','file_refs','base_revision','handoff_ref','short_summary','contract','contract_review_ids','contract_environment'];
const OUTPUT = ['status','summary','question','acceptance','changed_files','thread_id','turn_id','final_text','contract_receipt'];
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const strings = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
// Codex settings a profile may override: each only changes how much is loaded into every model call, never access.
const CODEX_CONFIG = {
  project_doc_max_bytes: v => Number.isInteger(v) && v >= 0,
  'skills.include_instructions': v => typeof v === 'boolean',
};
const configValue = (config, key) => key.split('.').reduce((v,k) => v && typeof v === 'object' ? v[k] : undefined, config);

export function loadProfiles(file = DEFAULT_PROFILES) {
  const config = JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  validateProfiles(config);
  return config;
}

export function validateProfiles(config) {
  if (!config || !strings(config.required_plugins) || !config.profiles || Array.isArray(config.profiles)) throw new Error('invalid profiles config');
  if (!strings(config.optional_hooks ?? [])) throw new Error('invalid optional_hooks');
  for (const id of Object.keys(config.profiles)) resolveProfile(config,id);
  for (const [name,a] of Object.entries(config.adapters ?? {})) {
    if (!/^[\w-]+$/.test(name) || typeof a.command !== 'string' || !strings(a.args ?? []) || !strings(a.input_fields) || !strings(a.output_fields)) throw new Error('invalid adapter config');
    projectFields({},[...a.input_fields,...a.output_fields]);
  }
  return config;
}

export function saveProfiles(file, config, expectedHash) {
  validateProfiles(config);
  const before = loadProfiles(file);
  if (expectedHash && digest(before) !== expectedHash) throw new Error('profiles changed; reload before saving');
  for (const id of before.required_plugins) if (!config.required_plugins.includes(id)) throw new Error(`required plugin must be preserved: ${id}`);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp,JSON.stringify(config,null,2)+'\n'); renameSync(temp,file);
}

export function resolveProfile(config, id = 'standard') {
  if (!own(config.profiles,id)) throw new Error(`unknown profile: ${id}`);
  const p = config.profiles[id];
  if (!p || (p.plugins !== '*' && !strings(p.plugins))) throw new Error('invalid profile plugins');
  for (const [key,allowed] of [['input_fields',INPUT],['output_fields',OUTPUT]]) {
    if (!strings(p[key]) || p[key].some(x=>!allowed.includes(x))) throw new Error(`invalid ${key} field`);
  }
  if (p.hooks && (typeof p.hooks !== 'object' || Object.values(p.hooks).some(x=>typeof x!=='boolean'))) throw new Error('invalid profile hooks');
  if (p.adapters && (!strings(p.adapters) || p.adapters.some(name=>!own(config.adapters ?? {},name)))) throw new Error('invalid profile adapters');
  if (p.codex_config !== undefined && (!p.codex_config || typeof p.codex_config !== 'object' || Array.isArray(p.codex_config)
    || Object.entries(p.codex_config).some(([key,value]) => !own(CODEX_CONFIG,key) || !CODEX_CONFIG[key](value)))) {
    throw new Error(`invalid profile codex_config: allowed keys are ${Object.keys(CODEX_CONFIG).join(', ')}`);
  }
  return {...p,id,required_plugins:config.required_plugins,optional_hooks:config.optional_hooks ?? [],config_hash:digest(config)};
}

export function projectFields(source, fields) {
  const out = {};
  for (const field of fields) {
    if (typeof field!=='string' || !field || field.split('.').some(k=>!k || ['__proto__','prototype','constructor'].includes(k))) throw new Error('invalid field path');
    const keys=field.split('.'); let v=source;
    for (const k of keys) { if (!v || typeof v!=='object' || !own(v,k)) { v=undefined; break; } v=v[k]; }
    if (v===undefined) continue;
    let target=out;
    for (const k of keys.slice(0,-1)) target=target[k] ??= {};
    target[keys.at(-1)]=structuredClone(v);
  }
  return out;
}

export function taskPacket(task, profile) {
  return projectFields(task,[...new Set(['goal','acceptance','write_files','sandbox','context','handoffs','contract','contract_review_ids','contract_environment','communication','browser_context',...profile.input_fields])]);
}
export function replyPacket(reply, profile) {
  return projectFields(reply,[...new Set(['status','question','acceptance','changed_files','contract_receipt','communication_receipt','browser_context','verdict','criteria','findings','boundary_review','coalesced_from','reused_artifacts',...profile.output_fields])]);
}

export function planRuntime(profile, runtime) {
  if (runtime.errors?.length) throw new Error('hook inventory incomplete: '+runtime.errors.map(e=>e.message).join('; '));
  const required = new Set(profile.required_plugins);
  const protectedHooks=runtime.hooks.filter(h=>h.enabled && (h.isManaged || required.has(h.pluginId) || !profile.optional_hooks.includes(h.key)));
  for (const h of protectedHooks) if (h.pluginId) required.add(h.pluginId);
  const overrides={};
  const selected = new Set(profile.plugins === '*' ? Object.keys(runtime.plugins).filter(k=>runtime.plugins[k].enabled!==false) : profile.plugins);
  for (const k of required) selected.add(k);
  for(const [key,enabled] of Object.entries(profile.hooks ?? {})) {
    const hook=runtime.hooks.find(h=>h.key===key);
    if(enabled && hook?.pluginId) selected.add(hook.pluginId);
  }
  for (const id of new Set([...Object.keys(runtime.plugins),...selected])) overrides[`plugins.${JSON.stringify(id)}.enabled`]=selected.has(id);
  for (const [key,enabled] of Object.entries(profile.hooks ?? {})) {
    if (!profile.optional_hooks.includes(key) || protectedHooks.some(h=>h.key===key) || runtime.hooks.some(h=>h.key===key && (h.isManaged || required.has(h.pluginId)))) throw new Error(`required hook cannot be overridden: ${key}`);
    if (!runtime.hooks.some(h=>h.key===key)) throw new Error(`unknown hook: ${key}`);
    overrides[`hooks.state.${JSON.stringify(key)}.enabled`]=enabled;
  }
  return {profile:profile.id,config_hash:profile.config_hash,overrides,codex_config:{...profile.codex_config},protected_hooks:protectedHooks.map(({key,currentHash,trustStatus,pluginId,enabled})=>({key,currentHash,trustStatus,pluginId,enabled})),retained_plugins:[...required]};
}

export function verifyRuntime(plan, runtime) {
  if (runtime.errors?.length) throw new Error('hook inventory incomplete');
  for (const h of plan.protected_hooks) {
    const current=runtime.hooks.find(x=>x.key===h.key);
    if (!current || !current.enabled || current.currentHash!==h.currentHash || current.trustStatus!==h.trustStatus) throw new Error(`required hook changed: ${h.key}`);
  }
  for (const [key,enabled] of Object.entries(plan.overrides)) {
    if (key.startsWith('plugins.')) {
      const id=JSON.parse(key.slice(8,-8));
      if (runtime.plugins[id]?.enabled!==enabled) throw new Error(`plugin override not applied: ${id}`);
    } else {
      const id=JSON.parse(key.slice('hooks.state.'.length,-8));
      if (runtime.hooks.find(h=>h.key===id)?.enabled!==enabled) throw new Error(`hook override not applied: ${id}`);
    }
  }
  for (const [key,value] of Object.entries(plan.codex_config ?? {})) {
    if (configValue(runtime.config,key) !== value) throw new Error(`codex config override not applied: ${key}`);
  }
  return {...plan,config_verified:true,verified_at:new Date().toISOString(),hook_events:[],warnings:runtime.hooks.filter(h=>h.enabled && !['trusted','managed'].includes(h.trustStatus)).map(h=>`hook not trusted: ${h.key}`)};
}

// Codex splits CLI keys on dots literally; quoted segments are not TOML keys there.
export function runtimeFlags(plan) {
  const groups = {plugins:[], 'hooks.state':[]};
  for (const [key,value] of Object.entries(plan.overrides)) {
    const group=key.startsWith('plugins.')?'plugins':'hooks.state';
    const id=JSON.parse(key.slice(group.length+1,-8));
    groups[group].push(`${JSON.stringify(id)} = { enabled = ${value} }`);
  }
  return [...Object.entries(groups).filter(([,entries])=>entries.length)
    .flatMap(([key,entries])=>['-c',`${key}={ ${entries.join(', ')} }`]),
    ...Object.entries(plan.codex_config ?? {}).flatMap(([key,value])=>['-c',`${key}=${JSON.stringify(value)}`])];
}

export async function inspectRuntime(client, cwd) {
  const cfg=await client.request('config/read',{cwd,includeLayers:false});
  const listed=await client.request('hooks/list',{cwds:[cwd]});
  return {plugins:cfg.config.plugins ?? {},config:cfg.config,hooks:listed.data.flatMap(e=>e.hooks),errors:listed.data.flatMap(e=>e.errors)};
}

export function profileSummary(config) {
  return {config,hash:digest(config),profiles:Object.keys(config.profiles).map(id=>resolveProfile(config,id))};
}
