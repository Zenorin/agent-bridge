// Names why a task stopped, for display only. Nothing here retries, switches agent or changes a status.

// Our own checks come first: their wording is fixed, so they are matched exactly instead of by keyword.
const OWN = [
  [/needs a runner started with --allow-write/, 'setup', 'not_started'],
  [/^connector setup failed/, 'setup', 'not_started'],
  [/before execution|reuse dependency changed/, 'input_changed', 'not_started'],
  [/^input changed during execution|^context source changed/, 'input_changed', 'ran'],
  [/outside task scope|^agent reported writes/, 'scope', 'ran'],
  [/^change observation unavailable/, 'observation', 'unknown'],
  [/required hook not observed|^[\w-]+ permission denied(?::|$)|disallowed tool|communication (payload|delivery)/, 'rule', 'ran'],
  [/^runner cleanup failed|^runner stopped during work/, 'cleanup', 'unknown'],
  [/invalid agent reply|invalid \w+ stream|result was not successful|did not complete|returned an empty reply/, 'format', 'ran'],
  [/^review timeout$|^turn exceeded|timed out|ETIMEDOUT/i, 'timeout', 'unknown'],
];

// Provider wording is matched by keyword, most specific first.
const PROVIDER = [
  ['auth', /unauthori[sz]ed|\b401\b|\b403\b|not logged in|log ?in required|please (log|sign) ?in|authenticat|invalid (api key|token|credentials)|token (has )?expired|session expired|permission_denied/i],
  ['quota', /rate.?limit|\b429\b|quota|usage limit|(?:hit your |reached (?:your )?)(?:session|weekly|usage) limit|too many requests|insufficient (credits|quota)|credit balance|resource_exhausted|limit reached|exceeded your/i],
  ['outage', /\b50[0-4]\b|overloaded|service unavailable|temporarily unavailable|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|connection (reset|refused|closed)|server error/i],
  ['process_exit', /app-server exited|\w+ exited \(/i],
];

export const FAILURE_KINDS = ['setup', 'input_changed', 'scope', 'observation', 'rule', 'cleanup', 'format',
  'timeout', 'auth', 'quota', 'outage', 'process_exit', 'unknown'];

/**
 * Returns null unless the task is blocked by a failure. `execution` says whether the agent can have started:
 * "not_started" and "ran" are certain from our own wording, "unknown" means the reason cannot tell.
 */
export function classifyFailure(status, reason) {
  if (status !== 'blocked' || typeof reason !== 'string' || !reason.trim() || reason === 'question') return null;
  const text = reason.replace(/^runner error: /, '');
  for (const [pattern, kind, execution] of OWN) if (pattern.test(text)) return { kind, execution };
  for (const [kind, pattern] of PROVIDER) if (pattern.test(text)) return { kind, execution: 'unknown' };
  return { kind: 'unknown', execution: 'unknown' };
}

/** Structured Claude quota information; never treat model-authored prose as a reset signal. */
export function claudeQuota(event) {
  if(event.type!=='assistant' || event.error!=='rate_limit')return null;
  const seconds=event.quotaLimits?.resetsAt;
  const valid=typeof seconds==='number' && Number.isFinite(seconds) && seconds>0 && seconds<=253402300799;
  return {kind:'quota',reset_at:valid?new Date(seconds*1000).toISOString():null};
}
