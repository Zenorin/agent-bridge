import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRecovery, loadFallbacks, resetDelay, BACKOFF_MS, MAX_RETRIES } from '../recovery.mjs';
import { BridgeStore } from '../store.mjs';
import { runAgentTask } from '../runner-core.mjs';
import { runCodexWorker } from '../codex-runner.mjs';
import { runGeminiWorker } from '../gemini-runner.mjs';
import { fixtureLog } from './fixtures/fixture-log.mjs';

const NOW = Date.parse('2026-11-11T00:00:00.000Z');
const at = ms => new Date(NOW + ms).toISOString();
const clean = { activity: { tool_calls: 0 }, change_observation: { complete: true, observed: [] } };
const blocked = (reason, overrides = {}) => ({ status: 'blocked', status_reason: reason, recipient: 'codex', sender: 'claude-code',
  root_id: null, cancel_requested: false, cleanup_pending: 0, body: {}, recovery: [], ...overrides });
const QUOTA = 'runner error: codex exited (1): 429 Too Many Requests';
const decide = (row, receipt = clean, extra = {}) => decideRecovery({ row, receipt, now: NOW, ...extra });

test('a provider failure with proof that nothing ran is retried after 5 then 30 minutes, at most twice', () => {
  const first = decide(blocked(QUOTA));
  assert.deepEqual(first, { action: 'retry', kind: 'quota', retry: 1, max: MAX_RETRIES, retry_at: at(BACKOFF_MS[0]), hold: at(BACKOFF_MS[0]) });
  const second = decide(blocked(QUOTA, { recovery: [{ action: 'retry' }] }));
  assert.equal(second.retry_at, at(BACKOFF_MS[1]));
  const third = decide(blocked(QUOTA, { recovery: [{ action: 'retry' }, { action: 'retry' }] }));
  assert.equal(third.action, 'stay');
  assert.equal(third.code, 'retries_used');
  // Only a usage limit holds the agent's other tasks.
  assert.equal(decide(blocked('runner error: codex exited (1): 503 Service Unavailable')).hold, null);
  assert.equal(decide(blocked('runner error: app-server exited (3)')).action, 'retry');
});

test('auth, timeouts, our own checks and unclassified failures are never retried', () => {
  for (const reason of ['runner error: codex exited (1): 401 Unauthorized', 'review timeout', 'runner error: turn exceeded 600000ms',
    'observed writes outside task scope: x.txt', 'turn failed: boom', 'question']) {
    assert.equal(decide(blocked(reason)), null, reason);
  }
  assert.equal(decide({ ...blocked(QUOTA), status: 'ready' }), null);
});

test('missing proof that the attempt did nothing keeps the task blocked and says why', () => {
  const cases = [
    [{ ...clean, activity: { tool_calls: 1 } }, 'tools_ran'],
    [{ ...clean, activity: { tool_calls: null } }, 'tools_unmeasured'],
    [{ change_observation: clean.change_observation }, 'tools_unmeasured'],
    [{ ...clean, change_observation: { complete: false, observed: [] } }, 'observation_missing'],
    [{ activity: clean.activity }, 'observation_missing'],
    [{ ...clean, change_observation: { complete: true, observed: ['a.txt'] } }, 'workspace_changed'],
  ];
  for (const [receipt, code] of cases) assert.equal(decide(blocked(QUOTA), receipt).code, code);
  assert.equal(decide(blocked(QUOTA, { cleanup_pending: 1 })).code, 'cleanup');
  // The agent is still at its limit, so its other tasks wait even when this one stays blocked.
  assert.equal(decide(blocked(QUOTA), { ...clean, activity: { tool_calls: 2 } }).hold, at(BACKOFF_MS[0]));
});

test('opted-out, chain, contract, program, image and cancelled tasks are left for a person', () => {
  const cases = [
    [blocked(QUOTA, { body: { recovery: false } }), 'off'],
    [blocked(QUOTA, { root_id: 'root' }), 'chain'],
    [blocked(QUOTA, { body: { contract: { hash: 'x' } } }), 'contract'],
    [blocked(QUOTA, { body: { execution: { adapter: 'tool' } } }), 'program'],
    [blocked(QUOTA, { cancel_requested: true }), 'cancel'],
  ];
  for (const [row, code] of cases) assert.equal(decide(row).code, code);
  assert.equal(decide(blocked(QUOTA), clean, { profile: 'image' }).code, 'image');
});

test('a wait the provider names is used; one past six hours is not waited for', () => {
  assert.equal(resetDelay('rate limit, try again in 2 hours'), 2 * 3_600_000);
  assert.equal(resetDelay('Retry-After: 90'), 90_000);
  assert.equal(resetDelay('please retry after 5s'), 60_000);
  assert.equal(resetDelay('usage limit reached, resets at 3pm'), null);
  assert.equal(decide(blocked(`${QUOTA}; try again in 2 hours`)).retry_at, at(2 * 3_600_000));
  const far = decide(blocked(`${QUOTA}; resets in 7h`));
  assert.equal(far.code, 'wait_too_long');
  assert.equal(far.hold, at(6 * 3_600_000));
});

test('handover follows only the user allowlist, once, never to the sender or out of a resumed thread', () => {
  const fallbacks = { entries: [{ from: 'gemini', to: 'codex', on: ['quota'], profiles: ['light'], model: 'gpt-6-luna', effort: 'low' }] };
  const gemini = blocked('runner error: gemini exited (1): 429 RESOURCE_EXHAUSTED', { recipient: 'gemini', body: { model: 'g-1', effort: null } });
  const handed = decide(gemini, clean, { fallbacks, profile: 'light' });
  assert.deepEqual(handed, { action: 'fallback', kind: 'quota', from: 'gemini', to: 'codex', hold: at(BACKOFF_MS[0]),
    model: { before: 'g-1', after: 'gpt-6-luna' }, effort: { before: null, after: 'low' } });
  assert.equal(decide(gemini, clean, { fallbacks, profile: 'standard' }).action, 'retry');
  assert.equal(decide({ ...gemini, sender: 'codex' }, clean, { fallbacks, profile: 'light' }).action, 'retry');
  assert.equal(decide({ ...gemini, body: { thread_id: 't' } }, clean, { fallbacks, profile: 'light' }).action, 'retry');
  assert.equal(decide({ ...gemini, recovery: [{ action: 'fallback' }] }, clean, { fallbacks, profile: 'light' }).action, 'retry');
  assert.equal(decide(gemini, { ...clean, activity: { tool_calls: 1 } }, { fallbacks, profile: 'light' }).code, 'tools_ran');
});

test('the allowlist is off when missing and ignored as a whole when any entry is invalid', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'recovery.json');
  assert.deepEqual(loadFallbacks(file), { entries: [] });
  const valid = { from: 'gemini', to: 'codex', on: ['quota', 'outage'], profiles: ['light'] };
  writeFileSync(file, JSON.stringify({ fallback: [valid] }));
  assert.deepEqual(loadFallbacks(file).entries, [{ ...valid, model: null, effort: null }]);
  for (const bad of [{ ...valid, to: 'gemini' }, { ...valid, on: ['auth'] }, { ...valid, profiles: [] }, { ...valid, from: 'someone' }]) {
    writeFileSync(file, JSON.stringify({ fallback: [valid, bad] }));
    const loaded = loadFallbacks(file);
    assert.deepEqual(loaded.entries, []);
    assert.match(loaded.error, /recovery\.json ignored/);
  }
  writeFileSync(file, '{not json');
  assert.match(loadFallbacks(file).error, /recovery\.json ignored/);
});

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-general-cli.mjs', import.meta.url));

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-recovery-run-'));
  writeFileSync(path.join(dir, 'a.txt'), 'original');
  const store = new BridgeStore(path.join(dir, 'bridge.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const recoveryFile = path.join(fixtureLog(t, 'recovery'), '..', 'recovery.json');
  const codex = env => ({ once: true, command: process.execPath, args: [FAKE_CODEX], recoveryFile, heartbeatMs: 50, cancelPollMs: 20,
    env: { FAKE_LOG: fixtureLog(t, 'codex.jsonl'), ...env } });
  const task = overrides => ({ message_id: 'm', task_id: 'T', sender: 'claude-code', recipient: 'codex', goal: 'work', cwd: dir, ...overrides });
  // Lets the wait pass without sleeping: the retry time and any agent hold move into the past.
  const elapse = () => { store.db.exec("UPDATE messages SET not_before = '2000-01-01T00:00:00.000Z' WHERE not_before IS NOT NULL; DELETE FROM agent_holds"); };
  return { dir, store, recoveryFile, codex, task, elapse };
}

test('a Codex usage-limit turn with no tool call is queued again, holds Codex, and stops after two retries', async t => {
  const { store, codex, task, elapse } = setup(t);
  store.sendTask(task());
  const env = { FAKE_MODE: 'failed', FAKE_ERROR: '429 Too Many Requests' };
  const started = Date.now();
  await runCodexWorker(store, codex(env));
  let row = store.get('m');
  assert.equal(row.status, 'queued');
  assert.match(row.status_reason, /^waiting: automatic retry 1\/2 after quota at /);
  assert.ok(Date.parse(row.not_before) - started >= BACKOFF_MS[0] - 1_000);
  assert.equal(store.listRuntime('m')[0].activity.tool_calls, 0);
  assert.equal(store.listRuntime('m')[0].change_observation.complete, true);
  // Neither the waiting task nor another Codex task starts while Codex is at its limit.
  store.sendTask(task({ message_id: 'other' }));
  assert.equal(store.claimTask('codex', 'manual:test'), null);
  assert.match(store.get('other').status_reason, /^waiting: codex usage limit until /);
  assert.equal(store.claimTask('gemini', 'manual:test'), null);
  store.requestCancel('other');

  elapse();
  await runCodexWorker(store, codex(env));
  row = store.get('m');
  assert.equal(row.attempt, 2);
  assert.match(row.status_reason, /automatic retry 2\/2/);
  assert.ok(Date.parse(row.not_before) - Date.now() >= BACKOFF_MS[1] - 5_000);

  elapse();
  await runCodexWorker(store, codex(env));
  row = store.get('m');
  assert.equal(row.status, 'blocked');
  assert.match(row.status_reason, /429 Too Many Requests/);
  assert.deepEqual(row.recovery.map(entry => [entry.action, entry.attempt, entry.code]), [['retry', 1, undefined], ['retry', 2, undefined], ['stay', 3, 'retries_used']]);
});

test('a turn that already ran a tool, or opted out, stays blocked as reported', async t => {
  const { store, codex, task } = setup(t);
  store.sendTask(task());
  await runCodexWorker(store, codex({ FAKE_MODE: 'failed', FAKE_ERROR: '429 Too Many Requests', FAKE_TOOL: '1' }));
  assert.equal(store.get('m').status, 'blocked');
  assert.equal(store.listRuntime('m')[0].activity.tool_calls, 1);
  assert.equal(store.get('m').recovery[0].code, 'tools_ran');

  store.sendTask(task({ message_id: 'off', recovery: false }));
  store.db.exec('DELETE FROM agent_holds');
  await runCodexWorker(store, codex({ FAKE_MODE: 'crash' }));
  assert.equal(store.get('off').status, 'blocked');
  assert.equal(store.get('off').recovery[0].code, 'off');
  assert.throws(() => store.sendTask(task({ message_id: 'bad', recovery: 'no' })), /recovery must be true or false/);
});

test('a failed run is compared with the workspace too, so a change it left behind prevents a retry', async t => {
  const { dir, store, recoveryFile, task } = setup(t);
  store.sendTask(task({ sandbox: 'workspace-write', write_files: ['a.txt'] }));
  const claim = store.claimTask('codex', 'runner:test');
  const finished = await runAgentTask(store, claim, {
    async execute() { writeFileSync(path.join(dir, 'a.txt'), 'half done'); throw new Error('codex exited (1): 503 Service Unavailable'); },
    activity: () => ({ tool_calls: 0 }), async close() {},
  }, { allowWrite: true, recoveryFile });
  assert.equal(finished.status, 'blocked');
  assert.deepEqual(store.listRuntime('m')[0].change_observation.observed, ['a.txt']);
  assert.equal(finished.recovery[0].code, 'workspace_changed');
});

test('a connector that cannot count tool calls is never retried', async t => {
  const { store, recoveryFile, task } = setup(t);
  store.sendTask(task());
  const claim = store.claimTask('codex', 'runner:test');
  const finished = await runAgentTask(store, claim, {
    async execute() { throw new Error('codex exited (1): 503 Service Unavailable'); }, async close() {},
  }, { recoveryFile });
  assert.equal(finished.status, 'blocked');
  assert.equal(finished.recovery[0].code, 'tools_unmeasured');
});

test('a Gemini usage-limit failure is handed to Codex only through the allowlist, keeping goal, scope and profile', async t => {
  const { store, recoveryFile, task } = setup(t);
  writeFileSync(recoveryFile, JSON.stringify({ fallback: [{ from: 'gemini', to: 'codex', on: ['quota'], profiles: ['light'], model: 'gpt-6-luna', effort: 'low' }] }));
  const gemini = mode => ({ once: true, command: process.execPath, args: [FAKE_CLI], recoveryFile, env: { FAKE_GENERAL_MODE: mode } });
  store.sendTask(task({ recipient: 'gemini', profile: 'light', acceptance: ['reply'], sandbox: 'workspace-write', write_files: ['a.txt'], model: 'gemini-x' }));
  await runGeminiWorker(store, { ...gemini('quota'), allowWrite: true });
  const row = store.get('m');
  assert.equal(row.status, 'queued');
  assert.equal(row.recipient, 'codex');
  assert.equal(row.status_reason, 'waiting: handed from gemini to codex after quota');
  assert.deepEqual([row.body.model, row.body.effort, row.body.thread_id], ['gpt-6-luna', 'low', null]);
  assert.deepEqual([row.body.goal, row.body.profile, row.body.write_files, row.body.sandbox, row.body.acceptance],
    ['work', 'light', ['a.txt'], 'workspace-write', ['reply']]);
  assert.equal(row.recovery[0].model.before, 'gemini-x');
  // Gemini is held at its limit; Codex takes the task at once.
  assert.equal(store.claimTask('gemini', 'manual:test'), null);
  assert.equal(store.claimTask('codex', 'manual:test').message_id, 'm');

  store.sendTask(task({ message_id: 'ran', recipient: 'gemini', profile: 'light' }));
  store.db.exec('DELETE FROM agent_holds');
  await runGeminiWorker(store, gemini('quota-after-tool'));
  assert.equal(store.get('ran').recipient, 'gemini');
  assert.equal(store.get('ran').status, 'blocked');
  assert.equal(store.get('ran').recovery[0].code, 'tools_ran');
});
