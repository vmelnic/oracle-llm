import http from 'http';
import https from 'https';
import { URL } from 'url';
import { nonNegativeInt, positiveInt } from '../utils/env.js';
import { contextFenceTag, renderTemplate } from './prompts.js';

const RETRYABLE_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN']);

export class L3InferenceEngine {
  /**
   * Works with any OpenAI-compatible /chat/completions endpoint. Optional,
   * backend-specific settings are sent only when set: `reasoningEffort`
   * (`reasoning_effort`, e.g. "none" to disable thinking), `extraBody` (merged
   * into the request, e.g. `{"chat_template_kwargs": {...}}`) and
   * `extraHeaders`. See l3Config() for the environment variables.
   */
  constructor({ baseUrl, model, apiKey, timeoutMs, retries, maxTokens, contextTokens, temperature, reasoningEffort, extraBody, extraHeaders, output } = {}) {
    this.baseUrl = baseUrl;
    this.model = model || 'default';
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs ?? positiveInt(process.env.ORACLE_L3_TIMEOUT_MS, 180_000);
    this.retries = retries ?? nonNegativeInt(process.env.ORACLE_L3_RETRIES, 1);
    this.maxTokens = maxTokens ?? 32768;
    this.contextTokens = contextTokens ?? 1500;
    this.temperature = Number.isFinite(temperature) ? temperature : 0.2;
    this.reasoningEffort = reasoningEffort || '';
    this.extraBody = extraBody || {};
    this.extraHeaders = extraHeaders || {};
    // `claims`: JSON sentences with their claims, checked one by one
    // (system.claims.txt); `text`: prose with an evidence line (system.txt).
    this.output = output === 'text' ? 'text' : 'claims';
  }

  isAvailable() {
    return !!this.baseUrl;
  }

  /**
   * One chat completion. `timeoutMs` is a deadline for the whole call,
   * retries included; `signal` lets the caller (e.g. a cancelled MCP request)
   * abort it early. Retries only transient failures: 429, 5xx, connection resets.
   * Resolves to { text, evidence, usage, latencyMs, raw }.
   */
  async query(prompt, { maxTokens = this.maxTokens, temperature = this.temperature, l1Context = '', signal } = {}) {
    if (!this.baseUrl) {
      throw new Error('L3 inference not configured: missing baseUrl');
    }

    // Repository-derived text goes in the user turn (prompts/l3/user.txt),
    // fenced, with any closing fence tag neutralised so it cannot pose as
    // instructions. Short answers are the main latency lever on local
    // hardware, so system.txt asks for them.
    const tag = contextFenceTag();
    const context = tag ? l1Context.replaceAll(`</${tag}`, `<\\/${tag}`) : l1Context;
    const userContent = renderTemplate('user.txt', { context, question: prompt });

    const body = JSON.stringify({
      ...this.extraBody,
      model: this.model,
      messages: [
        { role: 'system', content: renderTemplate(this.output === 'claims' ? 'system.claims.txt' : 'system.txt') },
        { role: 'user', content: userContent },
      ],
      max_tokens: maxTokens,
      temperature,
      // JSON mode where the backend supports it (llama.cpp, vLLM, OpenAI...);
      // ORACLE_L3_EXTRA_BODY can override, ORACLE_L3_OUTPUT=text avoids it.
      ...(this.output === 'claims' && !('response_format' in this.extraBody) ? { response_format: { type: 'json_object' } } : {}),
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
    });

    const parsed = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('L3 base URL must use http or https');

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
    const started = performance.now();

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this._post(parsed, body, combined);
        return { ...result, latencyMs: Math.round(performance.now() - started) };
      } catch (err) {
        if (combined.aborted) {
          throw new Error(deadline.aborted ? `Inference request timed out after ${this.timeoutMs}ms` : 'Inference request cancelled', { cause: err });
        }
        if (!err.retryable || attempt >= this.retries) throw err;
        await sleep(250 * 2 ** attempt, combined);
      }
    }
  }

  _post(parsed, body, signal) {
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname.replace(/\/$/, '')}/chat/completions${parsed.search}`,
        method: 'POST',
        headers: {
          ...this.extraHeaders,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal,
      };

      const req = client.request(reqOpts, (res) => {
        let data = '';
        let size = 0;
        const maxResponseBytes = 2 * 1024 * 1024;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            req.destroy(new Error('Inference response exceeded 2 MiB'));
            return;
          }
          data += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`Inference server returned HTTP ${res.statusCode || 'unknown'}`);
            err.retryable = res.statusCode === 429 || res.statusCode >= 500;
            reject(err);
            return;
          }
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(json.error.message || JSON.stringify(json.error)));
              return;
            }
            const message = json.choices?.[0]?.message || {};
            // Some servers inline the model's thinking as <think>...</think>.
            const content = String(message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            if (!content) {
              const thinking = message.reasoning_content || message.reasoning;
              reject(new Error(thinking
                ? 'Model returned only reasoning and no answer; disable thinking (ORACLE_L3_REASONING_EFFORT=none or the server equivalent) or raise ORACLE_L3_MAX_TOKENS'
                : 'Model returned an empty answer'));
              return;
            }
            resolve({
              text: content,
              evidence: this._extractEvidence(content),
              usage: json.usage || null,
              // llama.cpp reports server-side speeds; other backends omit them.
              timings: json.timings || null,
              finishReason: json.choices?.[0]?.finish_reason || null,
              raw: json,
            });
          } catch (err) {
            reject(new Error(`Failed to parse inference response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        if (RETRYABLE_CODES.has(err.code) || err.message === 'socket hang up') err.retryable = true;
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Citations after the last "evidence" marker. Small models wrap them in many
   * ways (a JSON array, backticks, a ```json fence, one object per line), so
   * every {"path", "line_range"} object there is taken; each one is still
   * checked exactly against the verified facts afterwards.
   */
  _extractEvidence(text) {
    const markers = [...text.matchAll(/evidence\s*:?/gi)];
    const marker = markers[markers.length - 1];
    if (!marker) return [];
    const tail = text.slice(marker.index);

    const evidence = [];
    const seen = new Set();
    const add = (p, start, end) => {
      const key = `${p}:${start}:${end}`;
      if (seen.has(key)) return;
      seen.add(key);
      evidence.push({ path: p, line_range: [Number(start), Number(end)] });
    };
    const pathFirst = /\{\s*"path"\s*:\s*"([^"]+)"\s*,\s*"line_range"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*\}/g;
    const rangeFirst = /\{\s*"line_range"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*,\s*"path"\s*:\s*"([^"]+)"\s*\}/g;
    for (const m of tail.matchAll(pathFirst)) add(m[1], m[2], m[3]);
    for (const m of tail.matchAll(rangeFirst)) add(m[3], m[1], m[2]);
    return evidence;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
