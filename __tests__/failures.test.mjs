import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyFailure, FAILURE_KINDS } from '../failures.mjs';

const cases = [
  ['write task needs a runner started with --allow-write', 'setup', 'not_started'],
  ['connector setup failed: Gemini executable must be an absolute native path', 'setup', 'not_started'],
  ['context source changed before execution: a.txt', 'input_changed', 'not_started'],
  ['input changed during execution: a.txt', 'input_changed', 'ran'],
  ['observed writes outside task scope: x.txt', 'scope', 'ran'],
  ['runner error: agent reported writes outside task scope: x.txt', 'scope', 'ran'],
  ['change observation unavailable: byte limit exceeded', 'observation', 'unknown'],
  ['required hook not observed', 'rule', 'ran'],
  ['runner error: gemini permission denied', 'rule', 'ran'],
  ['reviewer attempted disallowed tool', 'rule', 'ran'],
  ['runner cleanup failed: Claude exit was not confirmed', 'cleanup', 'unknown'],
  ['runner stopped during work; check changed files before requeue', 'cleanup', 'unknown'],
  ['runner error: invalid agent reply', 'format', 'ran'],
  ['runner error: invalid gemini stream: Unexpected token', 'format', 'ran'],
  ['review timeout', 'timeout', 'unknown'],
  ['runner error: turn exceeded 600000ms', 'timeout', 'unknown'],
  ['runner error: claude exited (1): Invalid API key · Please run /login', 'auth', 'unknown'],
  ['runner error: codex exited (1): 401 Unauthorized', 'auth', 'unknown'],
  ['runner error: gemini exited (1): You are not logged in', 'auth', 'unknown'],
  ['runner error: claude exited (1): usage limit reached', 'quota', 'unknown'],
  ['runner error: gemini exited (1): 429 RESOURCE_EXHAUSTED', 'quota', 'unknown'],
  ['turn failed: rate limit exceeded, retry later', 'quota', 'unknown'],
  ['runner error: claude exited (1): API Error: 529 Overloaded', 'outage', 'unknown'],
  ['runner error: gemini exited (1): 503 Service Unavailable', 'outage', 'unknown'],
  ['runner error: connect ECONNRESET 1.2.3.4:443', 'outage', 'unknown'],
  ['runner error: app-server exited (1)', 'process_exit', 'unknown'],
  ['runner error: claude exited (1): ', 'process_exit', 'unknown'],
  ['turn failed: boom', 'unknown', 'unknown'],
];

for (const [reason, kind, execution] of cases) {
  test(`classifies "${reason}"`, () => {
    assert.deepEqual(classifyFailure('blocked', reason), { kind, execution });
  });
}

test('only a blocked failure is classified; a question and other states are not', () => {
  assert.equal(classifyFailure('blocked', 'question'), null);
  assert.equal(classifyFailure('blocked', null), null);
  assert.equal(classifyFailure('blocked', '  '), null);
  for (const status of ['queued', 'working', 'ready', 'cancelled']) assert.equal(classifyFailure(status, 'review timeout'), null);
});

test('our own wording wins over provider keywords it happens to contain', () => {
  // A scope violation whose file name looks like an HTTP code is still a scope violation.
  assert.equal(classifyFailure('blocked', 'observed writes outside task scope: 429.txt').kind, 'scope');
});

test('every kind and execution value has dashboard copy', () => {
  const copy = JSON.parse(readFileSync(new URL('../ui/copy.ko.json', import.meta.url), 'utf8'));
  for (const kind of FAILURE_KINDS) assert.ok(copy[`failureKind_${kind}`], kind);
  for (const run of ['not_started', 'ran', 'unknown']) assert.ok(copy[`failureRun_${run}`], run);
});
