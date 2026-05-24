import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { URL } from 'url'
import { Bm25Index } from './bm25.js'

const EMBED_MODEL = process.env.ORACLE_EMBED_MODEL || ''
const EMBED_API_URL = process.env.ORACLE_EMBED_API_URL || ''
const EMBED_API_KEY = process.env.ORACLE_EMBED_API_KEY || ''
const EMBED_DIMENSIONS = parseInt(process.env.ORACLE_EMBED_DIMENSIONS || '0', 10)
const EMBEDDINGS_ENV = process.env.ORACLE_EMBEDDINGS || ''

export class L2Index {
  constructor(store, { indexPath, embeddings } = {}) {
    this.store = store
    this.indexPath = indexPath
    this.bm25 = new Bm25Index()
    this.vectors = new Map()
    this.loaded = false
    this.embeddingsEnabled = embeddings !== undefined
      ? embeddings
      : (EMBEDDINGS_ENV === 'true' || EMBEDDINGS_ENV === '1')
  }

  async build(subprojectId) {
    const nodes = this.store.findNodes({ subprojectId })
    this.bm25 = new Bm25Index()
    this.vectors.clear()

    for (const node of nodes) {
      const text = nodeToSearchText(node)
      const id = String(node.id)
      this.bm25.addDocument(id, text, {
        id: node.id,
        kind: node.kind,
        symbol: node.symbol,
        path: node.path,
        start_line: node.start_line,
        end_line: node.end_line,
        signature: node.signature,
        exported: !!node.exported,
      })
    }

    if (this.embeddingsEnabled) {
      try {
        await this._buildVectors(nodes)
      } catch (err) {
        console.error(`  [embeddings] ${err.message}`)
      }
    }

    this.loaded = true
    return { indexed: nodes.length, vectors: this.vectors.size }
  }

  async _buildVectors(nodes) {
    const texts = []
    const ids = []
    for (const node of nodes.slice(0, 2000)) {
      texts.push(nodeToSearchText(node))
      ids.push(String(node.id))
    }

    if (texts.length === 0) return

    let embeddings
    if (EMBED_API_URL && EMBED_MODEL) {
      embeddings = await fetchEmbeddings(texts)
    } else {
      const { embed } = await import('./embeddings.js')
      embeddings = await embed(texts)
    }

    for (let i = 0; i < ids.length && i < embeddings.length; i++) {
      this.vectors.set(ids[i], embeddings[i])
    }
  }

  async search(query, opts = {}) {
    if (!this.loaded) this.load()

    const bm25Results = this.bm25.search(query, opts)

    if (this.vectors.size === 0) {
      return bm25Results
    }

    return this._hybridSearch(query, bm25Results, opts)
  }

  async _hybridSearch(query, bm25Results, opts) {
    try {
      let queryVec
      if (EMBED_API_URL && EMBED_MODEL) {
        ;[queryVec] = await fetchEmbeddings([query])
      } else {
        const { embedSingle } = await import('./embeddings.js')
        queryVec = await embedSingle(query)
      }
      if (!queryVec) return bm25Results

      const scores = new Map()
      for (const r of bm25Results) {
        scores.set(r.id, { bm25: r.score, vec: 0, node: r.node })
      }

      for (const [id, vec] of this.vectors) {
        const sim = cosineSimilarity(queryVec, vec)
        if (!scores.has(id)) {
          const doc = this.bm25.documents.get(id)
          if (doc && (!opts.kinds || opts.kinds.length === 0 || opts.kinds.includes(doc.node.kind))) {
            scores.set(id, { bm25: 0, vec: sim, node: doc.node })
          }
        } else {
          scores.get(id).vec = sim
        }
      }

      const bm25Max = Math.max(...[...scores.values()].map((s) => s.bm25), 1)
      const vecMax = Math.max(...[...scores.values()].map((s) => s.vec), 1)

      const combined = []
      for (const [id, s] of scores) {
        const normalized = (s.bm25 / bm25Max) * 0.4 + (s.vec / vecMax) * 0.6
        combined.push({ id, score: normalized, node: s.node })
      }

      combined.sort((a, b) => b.score - a.score)
      const limit = opts.limit || 10
      return combined.slice(0, limit)
    } catch {
      return bm25Results
    }
  }

  async searchByKind(query, kind, opts = {}) {
    return this.search(query, { ...opts, kinds: [kind] })
  }

  save(outputPath) {
    const baseDir = outputPath || this.indexPath;
    if (!baseDir) throw new Error('No indexPath configured');

    const dir = baseDir.replace(/\.json$/, '');
    fs.mkdirSync(dir, { recursive: true });

    const bm25Data = this.bm25.serialize();
    fs.writeFileSync(path.join(dir, 'bm25.json'), JSON.stringify(bm25Data, null, 2));

    if (this.vectors.size > 0) {
      const vecData = [];
      for (const [id, vec] of this.vectors) {
        vecData.push({ id, vec });
      }
      fs.writeFileSync(path.join(dir, 'vectors.json'), JSON.stringify(vecData, null, 2));
    } else if (fs.existsSync(path.join(dir, 'vectors.json'))) {
      fs.unlinkSync(path.join(dir, 'vectors.json'));
    }
  }

  load(inputPath) {
    const baseDir = inputPath || this.indexPath;
    if (!baseDir) {
      this.loaded = false;
      return false;
    }

    const dir = baseDir.replace(/\.json$/, '');

    const legacyFile = baseDir.endsWith('.json') && fs.existsSync(baseDir) ? baseDir : null;
    const bm25File = path.join(dir, 'bm25.json');

    const dataFile = fs.existsSync(bm25File) ? bm25File : legacyFile;
    if (!dataFile || !fs.existsSync(dataFile)) {
      this.loaded = false;
      return false;
    }

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    this.bm25.load(data);

    const vecFile = path.join(dir, 'vectors.json');
    if (fs.existsSync(vecFile)) {
      const vecData = JSON.parse(fs.readFileSync(vecFile, 'utf-8'));
      this.vectors.clear();
      for (const { id, vec } of vecData) {
        this.vectors.set(id, vec);
      }
    } else if (data.vectors) {
      this.vectors.clear();
      for (const { id, vec } of data.vectors) {
        this.vectors.set(id, vec);
      }
    }

    this.loaded = true;
    return true;
  }

  isLoaded() {
    return this.loaded
  }
}

function nodeToSearchText(node) {
  const meta = safeParse(node.metadata)
  const kind = node.kind

  if (kind === 'route' || kind === 'api_endpoint') {
    return [
      kind,
      node.symbol,
      meta.method || '',
      meta.path || '',
      meta.auth ? 'auth' : '',
      meta.handler || '',
      meta.type || '',
      node.signature || '',
      node.doc || '',
      ...Object.entries(meta).flatMap(([k, v]) => [k, String(v)]),
    ].filter(Boolean).join(' ')
  }

  if (kind === 'component') {
    return [
      kind,
      node.symbol,
      meta.api || '',
      ...(meta.props || []).map(p => typeof p === 'string' ? p : p.name || ''),
      ...(meta.emits || []).map(e => typeof e === 'string' ? e : e.name || ''),
      ...(meta.imports || []),
      node.signature || '',
      node.doc || '',
    ].filter(Boolean).join(' ')
  }

  if (kind === 'migration') {
    return [
      kind,
      node.symbol,
      meta.table || '',
      meta.operation || '',
      ...(meta.columns || []).map(c => typeof c === 'string' ? c : c.name || ''),
      node.signature || '',
      node.doc || '',
    ].filter(Boolean).join(' ')
  }

  if (kind === 'function' || kind === 'method') {
    return [
      kind,
      node.symbol,
      node.signature || '',
      meta.returnType || '',
      meta.async ? 'async' : '',
      ...(meta.params || []).map(p => typeof p === 'string' ? p : p.name || ''),
      node.doc || '',
      ...Object.entries(meta).filter(([k]) => !['params', 'returnType', 'async'].includes(k)).flatMap(([k, v]) => [k, String(v)]),
    ].filter(Boolean).join(' ')
  }

  if (kind === 'db_table') {
    return [
      kind,
      node.symbol,
      meta.table || '',
      meta.model || '',
      ...(meta.columns || []).map(c => typeof c === 'string' ? c : c.name || ''),
      meta.type || '',
      node.doc || '',
    ].filter(Boolean).join(' ')
  }

  if (kind === 'class') {
    return [
      kind,
      node.symbol,
      meta.extends || '',
      ...(meta.implements || []),
      ...(meta.traits || []),
      node.signature || '',
      node.doc || '',
    ].filter(Boolean).join(' ')
  }

  if (kind === 'doc_section') {
    return [
      kind,
      node.symbol,
      node.doc || '',
      node.signature || '',
      ...(meta.references || []),
      ...(meta.example_langs || []),
    ].filter(Boolean).join(' ')
  }

  const parts = [kind, node.symbol]
  if (node.signature) parts.push(node.signature)
  if (node.doc) parts.push(node.doc)
  if (node.metadata) {
    for (const [k, v] of Object.entries(meta)) {
      parts.push(String(k))
      if (v != null) parts.push(String(v))
    }
  }
  return parts.join(' ')
}

async function fetchEmbeddings(texts) {
  if (!EMBED_API_URL || !EMBED_MODEL) return []

  const body = JSON.stringify({
    model: EMBED_MODEL,
    input: texts,
    ...(EMBED_DIMENSIONS > 0 ? { dimensions: EMBED_DIMENSIONS } : {}),
  })

  return new Promise((resolve, reject) => {
    const parsed = new URL(EMBED_API_URL)
    const mod = parsed.protocol === 'https:' ? https : http
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(EMBED_API_KEY ? { Authorization: `Bearer ${EMBED_API_KEY}` } : {}),
      },
      timeout: 30000,
    }

    const req = mod.request(reqOpts, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const embeddings = (json.data || json.embeddings || [])
            .sort((a, b) => a.index - b.index)
            .map((e) => e.embedding || e)
          resolve(embeddings)
        } catch (err) {
          reject(new Error(`Failed to parse embedding response: ${err.message}`))
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Embedding request timed out')) })
    req.write(body)
    req.end()
  })
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

function safeParse(json) {
  if (!json) return {}
  if (typeof json === 'object') return json
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

export { Bm25Index }
