import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { BridgeStore } from '../store.mjs';
import { DEFAULT_PROFILES } from '../profiles.mjs';
import { REVIEW_SCHEMA } from '../chain.mjs';
import { startDashboard } from '../server.mjs';
import { fixtureLog } from './fixtures/fixture-log.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const codexFixture = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const runner = env => ({ command: process.execPath, args: [fixture], env, pollMs: 10, cancelPollMs: 10 });
function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(path.join(dir, 'a.txt'), 'before\n');
  git('add', 'a.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  writeFileSync(path.join(dir, 'a.txt'), 'after\n');
  const store = new BridgeStore(path.join(dir, 'queue.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = { message_id: 'root', task_id: 'AB02', sender: 'claude-code', recipient: 'codex',
    goal: 'fixture implementation', acceptance: ['fixture criterion'], cwd: dir, base_revision: 'HEAD',
    file_refs: [{ path: 'a.txt' }], write_files: ['a.txt'], sandbox: 'workspace-write', chain: { review: true } };
  const review = () => {
    store.sendTask(task);
    const claim = store.claimTask('codex', 'fixture');
    store.finishTask('root', { claim, outcome: 'result', reply: { status: 'done', summary: 'implemented',
      changed_files: { reported: ['a.txt'], observed: ['a.txt'] } } });
    return 'root:review:1';
  };
  return { dir, store, task, review };
}

test('Claude workspace-write is accepted; execution still requires runner write permission', t => {
  const { store, task } = setup(t);
  store.sendTask({ ...task,chain:undefined,sender:'codex',recipient:'claude-code'});
  assert.equal(store.get('root').status,'queued');
});

test('11: fixed Claude arguments, stdin packet and bridge-generated scoped diff', async t => {
  const { runClaudeWorker, buildClaudeArgs } = await import('../claude-runner.mjs');
  const { store, dir, review } = setup(t);
  const id = review();
  const log = fixtureLog(t, 'claude.jsonl');
  await runClaudeWorker(store, { once: true, ...runner({ FAKE_CLAUDE_LOG: log }) });
  assert.equal(store.get(id).status, 'ready');
  assert.equal(store.get('root:final').body.verdict, 'pass');
  const call = JSON.parse(readFileSync(log, 'utf8').trim());
  // A bare Read allow rule would open every path, so reads stay limited to cwd and the diff folder.
  assert.ok(!call.args.includes('--allowedTools'));
  assert.equal(call.args[call.args.indexOf('--add-dir') + 1], path.dirname(call.packet.file_refs.at(-1).path));
  for (const [flag, value] of [['--tools', 'Read,Grep,Glob'],
    ['--permission-mode', 'dontAsk'], ['--model', 'claude-sonnet-5-5'], ['--effort', 'high'],
    ['--output-format', 'stream-json']]) assert.equal(call.args[call.args.indexOf(flag) + 1], value);
  for (const flag of ['-p', '--verbose', '--include-hook-events', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(call.args.includes(flag));
  assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]), REVIEW_SCHEMA);
  assert.match(call.args[call.args.indexOf('--session-id') + 1], /^[\da-f-]{36}$/);
  assert.equal(call.packet.goal, 'fixture implementation');
  assert.match(call.diff[0], /-before\s+\+after/);
  assert.equal(call.diff.length, 1);
  const reply = store.get(`${id}:attempt:1:result`).body;
  assert.deepEqual(reply.tool_log.map(x => x.name), ['Read', 'StructuredOutput']);
  assert.equal(store.listUsage(id)[0].total_cost_usd, 0.001);
  assert.equal(store.listUsage(id)[0].costBasis, 'list');
  assert.equal(store.listUsage(id)[0].turn.inputTokens, 12);
  for (const args of [['--bare'], ['--settings', '{}'], ['--settings={}'], ['--setting-sources='],
    ['--tools', 'Read,Grep,Glob,Write'], ['--permission-mode', 'plan'], ['--allowedTools', 'Write']]) {
    assert.throws(() => buildClaudeArgs(store.get(id).body, { args }), /argument/);
    const next = `bad-args-${args.join('|')}`;
    store.sendTask({ message_id: next, task_id: 'args', sender: 'codex', recipient: 'claude-code',
      goal: 'review', cwd: dir, sandbox: 'read-only' });
    // Argument checks must happen before spawning.
    await runClaudeWorker(store, { once: true, ...runner({ FAKE_CLAUDE_LOG: log }), args: [fixture, ...args] });
    assert.equal(store.get(next).status, 'blocked');
  }
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('11: bridge diff includes files the implementation created but did not commit', async t => {
  const { runClaudeWorker } = await import('../claude-runner.mjs');
  const { store, dir, task } = setup(t);
  writeFileSync(path.join(dir, 'b.mjs'), 'export const added = 1;\n');
  store.sendTask({ ...task, write_files: ['a.txt', 'b.mjs'] });
  const claim = store.claimTask('codex', 'fixture');
  store.finishTask('root', { claim, outcome: 'result', reply: { status: 'done', summary: 'implemented',
    changed_files: { reported: ['a.txt', 'b.mjs'], observed: ['a.txt', 'b.mjs'] } } });
  const log = fixtureLog(t, 'claude.jsonl');
  await runClaudeWorker(store, { once: true, ...runner({ FAKE_CLAUDE_LOG: log }) });
  const call = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.match(call.diff[0], /-before\s+\+after/);
  assert.match(call.diff[0], /b\.mjs[\s\S]*\+export const added = 1;/);
});

for (const mode of ['disallowed', 'denial-only', 'result-denial']) test(`11: ${mode} blocks regardless of pass verdict`, async t => {
  const { runClaudeWorker } = await import('../claude-runner.mjs');
  const { store, dir, review } = setup(t); const id = review();
  await runClaudeWorker(store, { once: true, ...runner({ FAKE_CLAUDE_MODE: mode }) });
  assert.equal(store.get(id).status, 'blocked');
  assert.equal(store.get(id).status_reason, 'reviewer attempted disallowed tool');
  assert.equal(store.get('root:final'), null);
  assert.ok(store.listRuntime(id)[0].tool_log.some(x => x.name === 'Write' && x.denied));
  assert.equal(existsSync(path.join(dir, 'intruder.txt')), false);
});

for (const mode of ['pass', 'no-hooks', 'started-only']) test(`12: hook receipts and required hook check (${mode})`, async t => {
  const { runClaudeWorker } = await import('../claude-runner.mjs');
  const { store, dir, review } = setup(t); const id = review();
  const profilesPath = path.join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({ ...JSON.parse(readFileSync(DEFAULT_PROFILES, 'utf8')), claude_required_hooks: ['UserPromptSubmit'] }));
  await runClaudeWorker(store, { once: true, profilesPath, ...runner({ FAKE_CLAUDE_MODE: mode }) });
  assert.equal(store.get(id).status, mode === 'pass' ? 'ready' : 'blocked');
  const receipt = store.listRuntime(id)[0];
  assert.equal(receipt.hook_events.length, mode === 'pass' ? 2 : mode === 'started-only' ? 1 : 0);
  if (mode !== 'pass') assert.equal(store.get(id).status_reason, 'required hook not observed');
});

test('13: CLI run drains fake Codex → reject → rework → resumed Claude pass in one service', async t => {
  const { main } = await import('../cli.mjs');
  const { store, dir, task } = setup(t);
  store.sendTask(task);
  const log = fixtureLog(t, 'claude.jsonl'); const codexLog = fixtureLog(t, 'codex.jsonl');
  assert.equal(await main(['run', '--once', '--allow-write', '--db', path.join(dir, 'queue.db')], {
    codex: { command: process.execPath, args: [codexFixture], env: { FAKE_LOG: codexLog } },
    claude: runner({ FAKE_CLAUDE_MODE: 'roundtrip', FAKE_CLAUDE_LOG: log }),
  }), 0);
  assert.equal(store.get('root:final').body.verdict, 'pass');
  assert.equal(store.get('root:final').body.round, 2);
  assert.equal(store.get('root').scope_held, 0);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], calls[0].args[calls[0].args.indexOf('--session-id') + 1]);
  assert.match(readFileSync(codexLog, 'utf8'), /thread\/resume/);
  assert.equal(store.listUsage('root:review:2')[0].turn.inputTokens, 12);
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const invoke = args => execFileSync(process.execPath, [cli, ...args, '--db', path.join(dir, 'queue.db')],
    { encoding: 'utf8', windowsHide: true }).trim().split('\n').map(JSON.parse);
  const status = invoke(['status']).find(row => row.message_id === 'root');
  assert.equal(status.chain.verdict, 'pass');
  assert.equal(status.chain.final_status, 'done');
  const replies = invoke(['receive', '--as', 'claude-code']);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message_id, 'root:final');
  assert.equal(replies[0].verdict, 'pass');
  assert.equal(replies[0].criteria[0].evidence, 'fake Claude only');
});

test('13: serve starts and stops the same two-agent pool', async t => {
  const { store, dir, task } = setup(t);
  const app = await startDashboard({ store, repo: dir, allowWrite: true, workerOptions: {
    pollMs: 10, codex: { command: process.execPath, args: [codexFixture] },
    claude: runner({ FAKE_CLAUDE_MODE: 'roundtrip' }),
  } });
  try {
    store.sendTask(task);
    const boot = await (await fetch(app.url + '/api/bootstrap')).json();
    const post = route => fetch(app.url + route, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': boot.token }, body: '{}' });
    assert.equal((await post('/api/runner/start')).status, 200);
    for (let i = 0; i < 300 && !store.get('root:final'); i++) await sleep(20);
    assert.equal(store.get('root:final')?.body.verdict, 'pass');
    assert.equal(store.get('root:final').body.round, 2);
    assert.equal((await post('/api/runner/stop')).status, 200);
    let state;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(app.url + '/api/state')).json();
      if (!state.runner.running) break;
      await sleep(10);
    }
    assert.equal(state.runner.running, false);
    assert.equal(state.runner.error, null);
  } finally { await app.close(); }
});

for (const mode of ['malformed', 'crash', 'text-result']) test(`Claude stream completion: ${mode}`, async t => {
  const { runClaudeWorker } = await import('../claude-runner.mjs');
  const { store, review } = setup(t); const id = review();
  await runClaudeWorker(store, { once: true, ...runner({ FAKE_CLAUDE_MODE: mode }) });
  assert.equal(store.get(id).status, mode === 'text-result' ? 'ready' : 'blocked');
});

for (const reason of ['cancel', 'timeout', ...(process.platform === 'win32' ? ['tree-failure'] : [])]) test(`Claude ${reason} confirms child exit before terminal state`, async t => {
  if (process.platform === 'win32') {
    const original = childProcess.spawnSync;
    t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
      if (command !== 'taskkill') return original(command, args, options);
      assert.deepEqual([args[0], ...args.slice(2)], ['/pid', '/T', '/F']);
      if (reason === 'tree-failure') return { status: 1 };
      process.kill(Number(args[1]), 'SIGKILL'); // Fixture has no descendants; no real taskkill permission needed.
      return { status: 0 };
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  }
  const { runClaudeWorker } = await import('../claude-runner.mjs');
  const { store, dir, task, review } = setup(t);
  if (reason === 'timeout') task.chain.review_timeout_ms = 500;
  const id = review(); const log = fixtureLog(t, 'claude.jsonl');
  const running = runClaudeWorker(store, { once: true, ...runner({ FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_LOG: log }) });
  for (let i = 0; i < 100 && !existsSync(log); i++) await sleep(10);
  assert.ok(existsSync(log));
  const { pid } = JSON.parse(readFileSync(log, 'utf8').trim());
  if (reason !== 'timeout') store.requestCancel('root');
  await running;
  assert.equal(store.get(id).status, reason === 'cancel' ? 'cancelled' : 'blocked');
  if (reason === 'timeout') assert.equal(store.get(id).status_reason, 'review timeout');
  if (reason === 'tree-failure') assert.match(store.get(id).status_reason, /cleanup failed: Claude process tree termination failed/);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.equal(store.get('root:final'), null);
});
