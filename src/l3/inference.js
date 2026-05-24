import http from 'http';
import https from 'https';
import { URL } from 'url';

const BASE_SYSTEM_PROMPT = `You are a codebase oracle. Answer using ONLY the provided context. Be concise.

Rules:
1. Every answer must be factual and grounded in the provided context.
2. End every answer with: evidence: [{"path": "file/path", "line_range": [start, end]}]
3. Only reference paths and line ranges from the context below.
4. If the context does not contain the answer, say so.`;

export class L3InferenceEngine {
  constructor({ baseUrl, model, apiKey }) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = apiKey;
  }

  isAvailable() {
    return !!this.baseUrl;
  }

  async query(prompt, { maxTokens = 1024, temperature = 0.2, l1Context = '' } = {}) {
    if (!this.baseUrl) {
      throw new Error('L3 inference not configured: missing baseUrl');
    }

    const systemPrompt = l1Context
      ? `${BASE_SYSTEM_PROMPT}\n\nContext:\n${l1Context}`
      : BASE_SYSTEM_PROMPT;

    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
    });

    const parsed = new URL(this.baseUrl);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + '/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        timeout: 60000,
      };

      const req = client.request(reqOpts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(json.error.message || JSON.stringify(json.error)));
              return;
            }
            const content = json.choices?.[0]?.message?.content || '';
            const evidence = this._extractEvidence(content);
            resolve({
              text: content,
              evidence,
              raw: json,
            });
          } catch (err) {
            reject(new Error(`Failed to parse inference response: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Inference request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  _extractEvidence(text) {
    const evidence = [];
    const match = text.match(/evidence:\s*(\[.*?\])/s);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed)) {
          for (const e of parsed) {
            if (e.path && Array.isArray(e.line_range) && e.line_range.length === 2) {
              evidence.push({ path: e.path, line_range: e.line_range });
            }
          }
        }
      } catch {
        // ignore malformed evidence
      }
    }
    return evidence;
  }
}
