import test from 'node:test';
import assert from 'node:assert/strict';
import { extractImagePath, buildEnvelope, STAGING } from '../image-job.mjs';
import { expandTemplate, loadTemplates } from '../templates.mjs';

test('요약에서 첫 절대 PNG 경로를 뽑는다', () => {
  const summary = '생성 파일: C:\\Users\\a\\.codex-image\\generated_images\\t\\exec-1.png\n해상도: 1024×1536';
  assert.equal(extractImagePath(summary), 'C:\\Users\\a\\.codex-image\\generated_images\\t\\exec-1.png');
  assert.equal(extractImagePath('경로 없음'), null);
  assert.equal(extractImagePath(null), null);
});

test('이미지 봉투는 image-photo 템플릿으로 펼쳐지고 model·effort를 싣는다', () => {
  const envelope = buildEnvelope({ name: 'x-01', prompt: 'a cat', stamp: 's' });
  assert.equal(envelope.model, 'gpt-6-luna');
  assert.equal(envelope.effort, 'low');
  const task = expandTemplate(envelope, loadTemplates());
  assert.equal(task.profile, 'image');
  assert.deepEqual(task.write_files, [`${STAGING}/x-01.png`]);
  assert.equal(task.cwd, STAGING);
  assert.ok(!STAGING.includes('\\'));
});

test('하루 장수·토큰 한도에 닿으면 새 이미지 작업을 거부한다', async () => {
  const { assertWithinBudget, readLedger } = await import('../image-job.mjs');
  assert.doesNotThrow(() => assertWithinBudget({ date: 'd', images: 7, tokens: 100 }, 8, 1000));
  assert.throws(() => assertWithinBudget({ date: 'd', images: 8, tokens: 100 }, 8, 1000), /daily image limit/);
  assert.throws(() => assertWithinBudget({ date: 'd', images: 1, tokens: 1000 }, 8, 1000), /daily token limit/);
  assert.deepEqual(readLedger('C:/no/such/ledger.json', '2026-11-02'), { date: '2026-11-02', images: 0, tokens: 0 });
});

test('경로 보고가 없으면 스레드 폴더의 가장 최근 PNG를 쓴다', async () => {
  const { newestThreadImage } = await import('../image-job.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'img-home-'));
  const dir = join(home, 'generated_images', 't1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'old.png'), 'a'); writeFileSync(join(dir, 'new.png'), 'b');
  utimesSync(join(dir, 'old.png'), new Date(1000), new Date(1000));
  assert.equal(newestThreadImage('t1', home), join(dir, 'new.png'));
  assert.equal(newestThreadImage('none', home), null);
  assert.equal(newestThreadImage(null, home), null);
});


test('image lookup follows the runner CODEX_HOME instead of a separate image login', async () => {
  const { newestThreadImage } = await import('../image-job.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'bridge-default-home-'));
  const dir = join(home, 'generated_images', 'default-auth-test');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'result.png'); writeFileSync(file, 'image');
  const before = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = home;
    assert.equal(newestThreadImage('default-auth-test'), file);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
  }
});
