export const TOKEN_KEYS=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const number=(...values)=>values.find(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0) ?? null;

export function normalizeUsage(provider,raw) {
  const separate=provider==='claude-code';
  const turn={inputTokens:number(raw.inputTokens,raw.input_tokens,raw.prompt_tokens),
    cachedInputTokens:number(raw.cachedInputTokens,raw.cache_read_input_tokens,raw.cache_read_tokens,raw.cached_tokens,raw.cached),
    cacheWriteInputTokens:number(raw.cacheWriteInputTokens,raw.cache_creation_input_tokens),
    outputTokens:number(raw.outputTokens,raw.output_tokens,raw.completion_tokens),
    reasoningOutputTokens:number(raw.reasoningOutputTokens,raw.reasoning_tokens,raw.thinking_tokens)};
  const components=separate?[turn.inputTokens,turn.cachedInputTokens,turn.cacheWriteInputTokens,turn.outputTokens]:[turn.inputTokens,turn.outputTokens];
  turn.totalTokens=number(raw.totalTokens,raw.total_tokens) ?? (provider!=='gemini'&&components.every(v=>v!==null)?components.reduce((a,b)=>a+b,0):null);
  return {provider,input_semantics:separate?'separate_buckets':provider==='gemini'?'provider_reported':'cached_subset',turn,raw};
}

// Model requests inside one attempt, keyed by request; the input is the whole prompt sent, cache included.
export function callTracker() {
  const calls=new Map();
  return {record(id,input){calls.set(id,Math.max(calls.get(id) ?? 0,number(input) ?? 0));},
    summary:()=>calls.size?{model_calls:calls.size,peak_call_input_tokens:Math.max(...calls.values())}:null};
}
export const claudeCallInput=usage=>['input_tokens','cache_read_input_tokens','cache_creation_input_tokens'].reduce((sum,key)=>sum+(number(usage?.[key]) ?? 0),0);

// Gemini reports each model request as a finished `agent_response` step with its own usage; cache reads are not part of input_tokens.
export function geminiStepCall(step) {
  if(step?.step_type!=='agent_response' || step.state!=='DONE')return null;
  const usage=step.usage;
  if(!usage || number(usage.input_tokens)===null)return {unmeasured:true};
  return {id:`${step.conversation_id}:${step.step_index}`,input:usage.input_tokens+(number(usage.cache_read_tokens) ?? 0)+(number(usage.cache_creation_tokens,usage.cache_write_tokens) ?? 0)};
}

export function zeroUsage(execution) {
  return {provider:'program',execution,input_semantics:'cached_subset',turn:Object.fromEntries(TOKEN_KEYS.map(k=>[k,0])),thread_total:null,
    calls:{model_calls:0,peak_call_input_tokens:0}};
}

export function aggregateUsage(rows) {
  const tokens=Object.fromEntries(TOKEN_KEYS.map(key=>[key,{known:0,measured:0,missing:0,total:null}]));
  for(const row of rows)for(const key of TOKEN_KEYS){const metric=tokens[key],v=row.usage?.turn?.[key];
    if(typeof v==='number'&&Number.isFinite(v)&&v>=0){metric.known+=v;metric.measured++;}else metric.missing++;}
  for(const metric of Object.values(tokens))if(!metric.missing)metric.total=metric.known;
  const counted=rows.map(row=>row.usage?.calls).filter(calls=>number(calls?.model_calls)!==null),known=counted.reduce((sum,calls)=>sum+calls.model_calls,0);
  const calls={model_calls:{known,measured:counted.length,missing:rows.length-counted.length,total:counted.length===rows.length?known:null},
    peak_call_input_tokens:counted.length?Math.max(...counted.map(c=>number(c.peak_call_input_tokens) ?? 0)):null};
  return {attempts:rows.length,tokens,calls,coverage:'bridge-attempts-only',unmetered_external_usage:true,
    by_agent:Object.fromEntries([...new Set(rows.map(r=>r.recipient))].map(agent=>[agent,rows.filter(r=>r.recipient===agent).length]))};
}
