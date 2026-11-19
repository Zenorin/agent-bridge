#!/usr/bin/env node
// Image job: send an image-photo task, run the image runner once, copy the generated file to staging.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
// Work folder for image tasks. Override with AGENT_BRIDGE_IMAGE_DIR.
export const STAGING = (process.env.AGENT_BRIDGE_IMAGE_DIR || path.join(homedir(), '.agent-bridge', 'images')).replace(/\\/g, '/');

// Returns the first absolute .png path in a reply summary, or null.
export function extractImagePath(summary) {
  const match = String(summary ?? '').match(/[A-Za-z]:[\\/][^\r\n"'<>|*?]*?\.png/i);
  return match ? match[0] : null;
}

// Newest PNG the image tool saved for a thread, or null.
export function newestThreadImage(threadId, home = process.env.CODEX_HOME || path.join(homedir(), '.codex')) {
  if (!threadId) return null;
  const dir = path.join(home, 'generated_images', threadId);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.png'))
    .map((name) => ({ file: path.join(dir, name), time: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files[0]?.file ?? null;
}

export function buildEnvelope({ name, prompt, outDir = STAGING, model = 'gpt-6-luna', effort = 'low', stamp = Date.now().toString(36) }) {
  const out = `${outDir.replace(/\\/g, '/')}/${name}.png`;
  return { message_id: `img-${name}-${stamp}`, task_id: `IMG-${name}-${stamp}`, sender: 'claude-code', recipient: 'codex',
    template: 'image-photo', model, effort, vars: { out, prompt, work_dir: STAGING } };
}

function cli(args, input) {
  const result = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cli ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const LEDGER = path.join(STAGING, '.image-job-ledger.json');
const DAILY_MAX_IMAGES = Number(process.env.IMAGE_JOB_DAILY_MAX ?? 4);
const DAILY_MAX_TOKENS = Number(process.env.IMAGE_JOB_DAILY_TOKENS ?? 800_000);

export function readLedger(file = LEDGER, today = new Date().toISOString().slice(0, 10)) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data.date === today) return data;
  } catch { /* first run of the day or unreadable ledger */ }
  return { date: today, images: 0, tokens: 0 };
}

// Throws when today's image count or token total has reached its cap.
export function assertWithinBudget(ledger, maxImages = DAILY_MAX_IMAGES, maxTokens = DAILY_MAX_TOKENS) {
  if (ledger.images >= maxImages) throw new Error(`daily image limit reached (${ledger.images}/${maxImages}); raise IMAGE_JOB_DAILY_MAX to continue`);
  if (ledger.tokens >= maxTokens) throw new Error(`daily token limit reached (${ledger.tokens}/${maxTokens}); raise IMAGE_JOB_DAILY_TOKENS to continue`);
}

export function runImageJob(options) {
  const ledger = readLedger();
  assertWithinBudget(ledger);
  const envelope = buildEnvelope(options);
  mkdirSync(STAGING, { recursive: true });
  cli(['send', '-'], JSON.stringify(envelope));
  cli(['run-codex', '--once', '--allow-write', '--profile', 'image']);
  const reply = cli(['status', '--task', envelope.task_id]).split('\n')
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((row) => row?.from === 'codex');
  if (!reply) throw new Error(`no Codex reply for ${envelope.task_id}`);
  // Count the attempt before judging the reply, so failed or question replies also use the budget.
  mkdirSync(path.dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify({ ...ledger, images: ledger.images + 1, tokens: ledger.tokens + (reply.turn_usage?.totalTokens ?? 0) }));
  // Codex sometimes reports no path although the tool saved the image; look in the thread's folder before failing.
  const source = extractImagePath(reply.summary) ?? newestThreadImage(reply.thread_id);
  if (!source && reply.status !== 'done') throw new Error(`Codex ${reply.status}: ${reply.question ?? reply.summary}`);
  if (!source || !existsSync(source)) throw new Error(`generated file not found in summary: ${reply.summary}`);
  const target = envelope.vars.out;
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error(`target already exists: ${target}`);
  copyFileSync(source, target);
  return { task_id: envelope.task_id, source, target, usage: reply.turn_usage ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { name: { type: 'string' }, prompt: { type: 'string' },
    'out-dir': { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' } } });
  if (!values.name || !values.prompt) {
    console.error('usage: node image-job.mjs --name <file-stem> --prompt <text> [--out-dir dir] [--model m] [--effort e]');
    process.exit(2);
  }
  const result = runImageJob({ name: values.name, prompt: values.prompt, outDir: values['out-dir'], model: values.model, effort: values.effort });
  console.log(JSON.stringify(result));
}
