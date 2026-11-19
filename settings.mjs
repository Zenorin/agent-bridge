// User settings kept in ~/.agent-bridge/clients.json: which agents take part, and how Gemini signs in.
// The file holds executable paths and choices only, never keys or tokens.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AGENTS } from './store.mjs';
import { GEMINI_AUTH_MODES, GEMINI_KEY_URL, GEMINI_TERMS_URL, normaliseGeminiAuth } from './gemini-auth.mjs';

export const clientsPath = (home = os.homedir()) => path.join(home, '.agent-bridge', 'clients.json');

export function readClientsConfig(home = os.homedir()) {
  const file = clientsPath(home);
  if (!existsSync(file)) return {};
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('clients.json must contain an object');
  return config;
}

function writeClientsConfig(config, home) {
  const file = clientsPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n');
  renameSync(temp, file);
}

const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

/**
 * Applies a settings change and saves it. Other entries in clients.json are kept as they are.
 * update.enabled: { agent: true|false }
 * update.gemini_auth: null to clear, or { mode, default?, accept_account_risk? }
 * Personal-account sign-in needs accept_account_risk: true once; the acceptance time is recorded.
 */
export function updateSettings(update, { home = os.homedir(), now = () => new Date().toISOString() } = {}) {
  if (!plainObject(update)) throw new Error('settings update must be an object');
  const config = readClientsConfig(home);
  if (update.enabled !== undefined) {
    if (!plainObject(update.enabled)) throw new Error('enabled must map agent names to true or false');
    for (const [agent, on] of Object.entries(update.enabled)) {
      if (!AGENTS.includes(agent)) throw new Error(`unknown agent: ${agent}`);
      if (typeof on !== 'boolean') throw new Error(`enabled.${agent} must be true or false`);
      const entry = { ...(config[agent] ?? {}) };
      if (on) delete entry.enabled; else entry.enabled = false;
      if (Object.keys(entry).length) config[agent] = entry; else delete config[agent];
    }
  }
  if (update.gemini_auth !== undefined) {
    const entry = { ...(config.gemini ?? {}) };
    if (update.gemini_auth === null) delete entry.auth;
    else {
      const choice = update.gemini_auth;
      if (!plainObject(choice) || !GEMINI_AUTH_MODES.includes(choice.mode)) throw new Error(`gemini_auth.mode must be one of: ${GEMINI_AUTH_MODES.join(', ')}`);
      let previous = null;
      try { previous = normaliseGeminiAuth(entry.auth ?? null); } catch { /* replaced below */ }
      const usesAccount = choice.mode !== 'api-key';
      const accepted = usesAccount ? (choice.accept_account_risk === true ? now() : previous?.account_risk_accepted_at ?? null) : null;
      if (usesAccount && !accepted) {
        throw new Error('개인 Google 계정 방식은 약관 위반이 될 수 있어요. 위험 안내를 읽고 동의한 경우에만 고를 수 있어요.');
      }
      const auth = { mode: choice.mode, default: choice.default ?? (choice.mode === 'both' ? 'api-key' : choice.mode) };
      if (accepted) auth.account_risk_accepted_at = accepted;
      normaliseGeminiAuth(auth);
      entry.auth = auth;
    }
    if (Object.keys(entry).length) config.gemini = entry; else delete config.gemini;
  }
  writeClientsConfig(config, home);
  return config;
}

/** What the dashboard and `settings` command show. Never includes key values. */
export function settingsView(found, { env = process.env } = {}) {
  const agents = Object.fromEntries(AGENTS.map((agent) => {
    const client = found.clients[agent];
    return [agent, { installed: client.installed, enabled: client.enabled, available: found.agents.includes(agent), error: client.error }];
  }));
  const auth = found.clients.gemini.auth;
  return {
    agents,
    gemini_auth: {
      mode: auth?.mode ?? null,
      default: auth?.default ?? null,
      account_risk_accepted: !!auth?.account_risk_accepted_at,
      api_key_present: !!String(env.GEMINI_API_KEY ?? '').trim(),
      error: found.clients.gemini.auth_error ?? null,
    },
    links: { gemini_terms: GEMINI_TERMS_URL, gemini_api_key: GEMINI_KEY_URL },
  };
}
