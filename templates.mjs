// Templates expand before queueing, so the agent never spends a tool call reading them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TEMPLATES = fileURLToPath(new URL('./templates.json', import.meta.url));
const SLOT = /\{\{(\w+)\}\}/g;
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);

export function loadTemplates(file = DEFAULT_TEMPLATES) {
  return JSON.parse(readFileSync(file,'utf8').replace(/^﻿/,''));
}

/** Fill {{slots}} from vars; fields given in the envelope win over the template's. */
export function expandTemplate(input, templates) {
  if (!own(input,'template')) return input;
  const { template, vars = {}, ...given } = input;
  if (!own(templates,template)) throw new Error(`unknown template: ${template}`);
  const used = new Set();
  const fill = (v) => {
    if (typeof v === 'string') return v.replace(SLOT,(_,k) => {
      if (!own(vars,k) || typeof vars[k] !== 'string') throw new Error(`template variable missing: ${k}`);
      used.add(k);
      return vars[k];
    });
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,fill(x)]));
    return v;
  };
  const task = { ...fill(templates[template]), ...given };
  for (const k of Object.keys(vars)) if (!used.has(k)) throw new Error(`unused template variable: ${k}`);
  return task;
}
