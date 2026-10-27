import { L3InferenceEngine } from './inference.js';
import { nonNegativeInt, positiveInt } from '../utils/env.js';

/**
 * L3 client settings, all from the environment so any OpenAI-compatible
 * backend (llama.cpp, Ollama, vLLM, LM Studio, OpenRouter, OpenAI, ...) can be
 * plugged in without code changes. Backend-specific knobs (reasoning effort,
 * extra body/headers) are only sent when set.
 */
export function l3Config(env = process.env) {
  const value = (name) => (env[name] ?? '').trim();
  return {
    enabled: value('ORACLE_L3_ENABLED') === 'true',
    baseUrl: value('ORACLE_L3_BASE_URL'),
    apiKey: value('ORACLE_L3_API_KEY'),
    model: value('ORACLE_L3_MODEL') || 'default',
    timeoutMs: positiveInt(value('ORACLE_L3_TIMEOUT_MS'), 180_000),
    retries: nonNegativeInt(value('ORACLE_L3_RETRIES'), 1),
    maxTokens: positiveInt(value('ORACLE_L3_MAX_TOKENS'), 32768),
    // Prompt budget for facts: each 1K tokens costs a few seconds of prefill
    // on small local hardware, so it is tunable.
    contextTokens: positiveInt(value('ORACLE_L3_CONTEXT_TOKENS'), 1500),
    temperature: value('ORACLE_L3_TEMPERATURE') === '' ? 0.2 : Number(value('ORACLE_L3_TEMPERATURE')),
    reasoningEffort: value('ORACLE_L3_REASONING_EFFORT'),
    extraBody: parseJsonObject(value('ORACLE_L3_EXTRA_BODY')),
    extraHeaders: parseJsonObject(value('ORACLE_L3_EXTRA_HEADERS')),
    output: value('ORACLE_L3_OUTPUT') === 'text' ? 'text' : 'claims',
  };
}

/** An engine when L3 is enabled and has a base URL, otherwise null. */
export function createL3Engine(env = process.env) {
  const config = l3Config(env);
  if (!config.enabled || !config.baseUrl) return null;
  return new L3InferenceEngine(config);
}

function parseJsonObject(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
