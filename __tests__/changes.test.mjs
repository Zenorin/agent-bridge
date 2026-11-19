import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { observeWorkspace, compareWorkspace } from '../changes.mjs';
import { BridgeStore } from '../store.mjs';
import { runAgentTask } from '../runner-core.mjs';
import { normaliseReview, reworkTask } from '../chain.mjs';

function fixture(t, git = false) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'bridge-changes-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = args => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, stdio: 'pipe' });
  writeFileSync(path.join(cwd, 'existing.txt'), 'original');
  if (git) {
    run(['init']); run(['add', '.']);
    run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  }
  return { cwd, run, task: { cwd, write_files: ['allowed.txt'] } };
}

for (const git of [false, true]) test(`observes actual edits and creations without model self-report (git=${git})`, t => {
  const { cwd, task } = fixture(t, git);
  writeFileSync(path.join(cwd, 'existing.txt'), 'user dirty content');
  const before = observeWorkspace(task);
  assert.equal(before.complete, true);
  writeFileSync(path.join(cwd, 'existing.txt'), 'changed while already dirty');
  writeFileSync(path.join(cwd, 'allowed.txt'), 'authorized');
  writeFileSync(path.join(cwd, 'unexpected 한글 file.txt'), 'unexpected');
  const result = compareWorkspace(task, before, observeWorkspace(task));
  assert.equal(result.complete, true);
  assert.deepEqual(result.observed, ['allowed.txt', 'existing.txt', 'unexpected 한글 file.txt']);
  assert.deepEqual(result.outside_scope, ['existing.txt', 'unexpected 한글 file.txt']);
});

test('git observation preserves existing dirty files, handles staged rename and ignored declared output', t => {
  const { cwd, task, run } = fixture(t, true);
  writeFileSync(path.join(cwd, '.gitignore'), 'ignored/\n');
  mkdirSync(path.join(cwd, 'ignored'));
  task.write_files = ['ignored/output.txt'];
  const before = observeWorkspace(task);
  renameSync(path.join(cwd, 'existing.txt'), path.join(cwd, 'new name.txt'));
  run(['add', 'existing.txt', 'new name.txt']);
  writeFileSync(path.join(cwd, 'ignored/output.txt'), 'authorized ignored output');
  const result = compareWorkspace(task, before, observeWorkspace(task));
  assert.equal(result.complete, true);
  assert.deepEqual(result.observed, ['existing.txt', 'ignored/output.txt', 'new name.txt']);
  assert.deepEqual(result.outside_scope, ['existing.txt', 'new name.txt']);
});

for (const git of [false, true]) test(`each observed change says whether it was created, deleted or modified and by how much (git=${git})`, t => {
  const { cwd, task, run } = fixture(t, git);
  writeFileSync(path.join(cwd, 'gone.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(cwd, 'image.bin'), Buffer.from([1, 0, 2]));
  if (git) { run(['add', '.']); run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'more']); }
  const before = observeWorkspace(task);
  // Clean tracked files are absent from git status before the run, so their old size comes from HEAD.
  writeFileSync(path.join(cwd, 'existing.txt'), 'original\nplus a line\n');
  rmSync(path.join(cwd, 'gone.txt'));
  writeFileSync(path.join(cwd, 'image.bin'), Buffer.from([1, 0, 2, 3]));
  writeFileSync(path.join(cwd, 'allowed.txt'), 'new\n');
  const { changes } = compareWorkspace(task, before, observeWorkspace(task));
  assert.deepEqual(changes, [
    { path: 'allowed.txt', change: 'created', bytes: { before: null, after: 4 }, lines: { before: null, after: 1 } },
    { path: 'existing.txt', change: 'modified', bytes: { before: 8, after: 21 }, lines: { before: 1, after: 2 } },
    { path: 'gone.txt', change: 'deleted', bytes: { before: 14, after: null }, lines: { before: 3, after: null } },
    { path: 'image.bin', change: 'modified', bytes: { before: 3, after: 4 }, lines: { before: null, after: null } },
  ]);
});

test('staging an unchanged file is reported as a state change, not an edit', t => {
  const { cwd, task, run } = fixture(t, true);
  writeFileSync(path.join(cwd, 'existing.txt'), 'dirty');
  const before = observeWorkspace(task);
  run(['add', 'existing.txt']);
  assert.deepEqual(compareWorkspace(task, before, observeWorkspace(task)).changes.map(c => c.change), ['state-only']);
});

test('nested cwd is the observation boundary and byte limits fail closed', t => {
  const { cwd, run } = fixture(t, true);
  mkdirSync(path.join(cwd, 'nested'));
  writeFileSync(path.join(cwd, 'nested/in.txt'), 'before');
  run(['add', '.']);
  run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'nested']);
  const task = { cwd: path.join(cwd, 'nested'), write_files: [] };
  const before = observeWorkspace(task);
  writeFileSync(path.join(cwd, 'nested/in.txt'), 'after');
  writeFileSync(path.join(cwd, 'existing.txt'), 'outside cwd');
  const after = observeWorkspace(task);
  assert.equal(after.complete, true);
  assert.deepEqual(compareWorkspace(task, before, after).observed, ['in.txt']);
  assert.equal(observeWorkspace(task, { maxBytes: 1 }).complete, false);
});

test('workspace HEAD change cannot claim a complete observation', t => {
  const { cwd, run, task } = fixture(t, true);
  const before = observeWorkspace(task);
  writeFileSync(path.join(cwd, 'existing.txt'), 'new'); run(['add', '.']);
  run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'changed']);
  assert.equal(compareWorkspace(task, before, observeWorkspace(task)).complete, false);
});

test('unreported out-of-scope write blocks publication and review dispatch with one mock execution', async t => {
  const { cwd } = fixture(t);
  const store = new BridgeStore(':memory:'); t.after(() => store.close());
  store.sendTask({ message_id: 'root', task_id: 'fixture', sender: 'claude-code', recipient: 'codex',
    cwd, goal: 'write allowed', acceptance: ['written'], sandbox: 'workspace-write', write_files: ['allowed.txt'], chain: { review: true } });
  const claim = store.claimTask('codex', 'mock-runner');
  let calls = 0;
  await runAgentTask(store, claim, {
    async execute() { calls++; writeFileSync(path.join(cwd, 'unexpected.txt'), 'not reported'); return {}; },
    parse() { return { outcome: 'result', reply: { status: 'done', changed_files: { reported: [], observed: [], outside_scope: [] } } }; },
    async close() {},
  }, { allowWrite: true });
  assert.equal(calls, 1);
  assert.equal(store.get('root').status, 'blocked');
  assert.match(store.get('root').status_reason, /observed writes outside task scope/);
  assert.equal(store.get('root:review:1'), null);
  assert.deepEqual(store.listRuntime('root')[0].change_observation.outside_scope, ['unexpected.txt']);
});

test('ordinary successful task retains automatic completion and unchanged pre-existing edits', async t => {
  const { cwd } = fixture(t, true);
  writeFileSync(path.join(cwd, 'existing.txt'), 'user dirty content');
  const store = new BridgeStore(':memory:'); t.after(() => store.close());
  store.sendTask({ message_id: 'task', task_id: 'fixture', sender: 'claude-code', recipient: 'codex',
    cwd, goal: 'write allowed', acceptance: [], sandbox: 'workspace-write', write_files: ['allowed.txt'] });
  const claim = store.claimTask('codex', 'mock-runner'); let calls = 0;
  await runAgentTask(store, claim, {
    async execute() { calls++; writeFileSync(path.join(cwd, 'allowed.txt'), 'output'); return {}; },
    parse() { return { outcome: 'result', reply: { status: 'done', changed_files: { reported: [] } } }; }, async close() {},
  }, { allowWrite: true });
  assert.equal(calls, 1); assert.equal(store.get('task').status, 'ready');
  assert.deepEqual(store.get('task:attempt:1:result').body.changed_files.observed, ['allowed.txt']);
});

const pass = { status: 'done', verdict: 'pass', summary: 'fixture',
  criteria: [{ criterion: 'original', result: 'pass', evidence: 'checked' }], findings: [],
  boundary_review: { paths: 'unchanged', exec: 'unchanged', auth_permissions: 'unchanged', notes: '' } };

test('a pass cannot hide missing, failed, duplicated or evidence-free original criteria', () => {
  for (const criteria of [[], [{ ...pass.criteria[0], result: 'fail' }], [{ ...pass.criteria[0], result: 'unverified' }],
    [{ ...pass.criteria[0], evidence: ' ' }], [...pass.criteria, ...pass.criteria]]) {
    assert.equal(normaliseReview({ ...pass, criteria }, ['original']).verdict, 'reject');
  }
  assert.equal(normaliseReview(pass, ['original']).verdict, 'pass');
});

test('contradictory findings reject and rework keeps the original goal and acceptance', () => {
  const findings = [{ criterion: 'additional check', problem: 'fixture', required_change: 'fix', files: ['allowed.txt'] }];
  assert.equal(normaliseReview({ ...pass, findings }, ['original']).verdict, 'reject');
  const root = { message_id: 'root', body: { goal: 'original objective', acceptance: ['original'], write_files: ['allowed.txt'],
    cwd: process.cwd(), sandbox: 'workspace-write', file_refs: [] } };
  const packet = reworkTask(root, { round: 1 }, { body: { findings } }, null);
  assert.equal(packet.goal, 'original objective');
  assert.deepEqual(packet.acceptance, ['original', 'additional check']);
  assert.deepEqual(packet.write_files, ['allowed.txt']);
});
