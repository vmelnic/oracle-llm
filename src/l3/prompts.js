import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every text sent to the model lives in prompts/l3/*.txt (or the directory in
// ORACLE_L3_PROMPTS_DIR), with Twig-style {{placeholders}}. Templates are read
// once per process; restart the server after editing them.
const DEFAULT_DIR = fileURLToPath(new URL('../../prompts/l3/', import.meta.url));
const cache = new Map();

function promptsDir(env = process.env) {
  const dir = (env.ORACLE_L3_PROMPTS_DIR || '').trim();
  if (!dir) return DEFAULT_DIR;
  return dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : path.resolve(dir);
}

function loadTemplate(name) {
  const file = path.join(promptsDir(), name);
  if (!cache.has(file)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new Error(`Prompt template not found: ${file}`, { cause: err });
    }
    cache.set(file, text.replace(/\r?\n$/, ''));
  }
  return cache.get(file);
}

/**
 * Fills {{name}} placeholders in one pass (values are never re-scanned). A
 * placeholder without a value is an error, so a typo in a template fails
 * loudly instead of reaching the model as literal braces.
 */
export function renderTemplate(name, vars = {}) {
  return loadTemplate(name).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key) => {
    if (!(key in vars) || vars[key] === undefined || vars[key] === null) {
      throw new Error(`Prompt template ${name} uses {{${key}}}, which was not provided`);
    }
    return String(vars[key]);
  });
}

/** JSON templates (e.g. bench tasks): placeholders are filled in every string. */
export function loadJsonTemplate(name) {
  return JSON.parse(loadTemplate(name));
}

export function fillPlaceholders(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
  }
  if (Array.isArray(value)) return value.map(v => fillPlaceholders(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, vars)]));
  }
  return value;
}

/**
 * The tag that fences {{context}} in user.txt (e.g. repository_context), so
 * repository text can be stopped from closing it early.
 */
export function contextFenceTag() {
  const match = loadTemplate('user.txt').match(/<([A-Za-z][\w-]*)>\s*\{\{\s*context\s*\}\}/);
  return match ? match[1] : null;
}
