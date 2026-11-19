import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTray, trayArgs, TRAY_SCRIPT } from '../tray.mjs';

test('tray runs only on Windows and only against the local dashboard', () => {
  assert.throws(() => startTray('http://127.0.0.1:8787', { platform: 'linux' }), /Windows only/);
  for (const url of ['https://127.0.0.1:8787', 'http://example.com:8787', 'http://127.0.0.1.evil.test:8787']) {
    assert.throws(() => startTray(url, { platform: 'win32' }), /local dashboard/);
  }
});

test('tray arguments pass the dashboard address and the parent process to the script', () => {
  const args = trayArgs('http://127.0.0.1:8787', 4242);
  assert.deepEqual(args.slice(args.indexOf('-File')), ['-File', TRAY_SCRIPT, '-Url', 'http://127.0.0.1:8787', '-ParentPid', '4242']);
  assert.ok(args.includes('-STA') && args.includes('Hidden'));
});

test('tray script keeps its Korean labels readable by Windows PowerShell 5.1 (UTF-8 with BOM)', () => {
  const bytes = readFileSync(TRAY_SCRIPT);
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(bytes.toString('utf8'), /대시보드 열기/);
});

test('tray script uses only the dashboard local API', () => {
  const text = readFileSync(TRAY_SCRIPT, 'utf8');
  const urls = [...text.matchAll(/https?:\/\/[^\s'")]+/g)].map(m => m[0]);
  assert.deepEqual(urls, []);
  assert.match(text, /\$Url\/api\/runner/);
});
