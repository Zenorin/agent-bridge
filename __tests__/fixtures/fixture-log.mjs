import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Test transport telemetry is not an agent write to its task workspace.
export function fixtureLog(t, name = 'calls.jsonl') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-transport-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}
