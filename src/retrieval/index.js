import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { URL } from 'url'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteFileSync } from '../utils/atomic-write.js'
import { Bm25Index } from './bm25.js'
import { nonNegativeInt } from '../utils/env.js'

const EMBED_MODEL = process.env.ORACLE_EMBED_MODEL || ''
const EMBED_API_URL = process.env.ORACLE_EMBED_API_URL || ''
const EMBED_API_KEY = process.env.ORACLE_EMBED_API_KEY || ''
const EMBED_DIMENSIONS = nonNegativeInt(process.env.ORACLE_EMBED_DIMENSIONS, 0)
const EMBEDDINGS_ENV = process.env.ORACLE_EMBEDDINGS || ''
// Max nodes to embed; 0 = embed all nodes
const EMBED_MAX_NODES = nonNegativeInt(process.env.ORACLE_EMBED_MAX_NODES, 0)
// Chunk size for remote embedding API requests
const EMBED_API_BATCH = 256
const EMBED_REQUEST_TIMEOUT_MS = 30_000

export class L2Index {
  constructor(store, { indexPath, embeddings } = {}) {
    this.store = store
    this.indexPath = indexPath
    this.bm25 = new Bm25Index()
    this.vectors = new Map()
    this._norms = new Map()
    // Incremental embedding cache, keyed by content hash so it survives
    // node id churn across rebuilds: hash -> vec, plus id -> hash for save()
    this._hashToVec = new Map()
    this._idToHash = new Map()
    this.loaded = false
    this.embeddingsEnabled = embeddings !== undefined
      ? embeddings
      : (EMBEDDINGS_ENV === 'true' || EMBEDDINGS_ENV === '1')
  }

  async build(subprojectId) {
    const nodes = this.store.findNodes({ subprojectId })
    this.bm25 = new Bm25Index()
    this.vectors.clear()
    this.lastEmbedStats = null

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
    return {
      indexed: nodes.length,
      vectors: this.vectors.size,
      ...(this.lastEmbedStats ? { embedded: this.lastEmbedStats.embedded, reused: this.lastEmbedStats.reused } : {}),
    }
  }

  async _buildVectors(nodes) {
    const capped = EMBED_MAX_NODES > 0 ? nodes.slice(0, EMBED_MAX_NODES) : nodes
    const entries = []
    for (const node of capped) {
      const text = nodeToSearchText(node)
      entries.push({ id: String(node.id), hash: textHash(text), text })
    }

    if (entries.length === 0) {
      this.vectors = new Map()
      this._idToHash = new Map()
      this._norms = new Map()
      return
    }

    const newVectors = new Map()
    const newIdToHash = new Map()
    const toEmbed = []
    const queuedHashes = new Set()
    let reused = 0

    for (const entry of entries) {
      newIdToHash.set(entry.id, entry.hash)
      const cached = this._hashToVec.get(entry.hash)
      if (cached) {
        newVectors.set(entry.id, cached)
        reused++
      } else if (!queuedHashes.has(entry.hash)) {
        queuedHashes.add(entry.hash)
        toEmbed.push(entry)
      }
    }

    if (toEmbed.length > 0) {
      let embedFn
      if (EMBED_API_URL && EMBED_MODEL) {
        embedFn = (texts) => fetchEmbeddings(texts)
      } else {
        const { embed } = await import('./embeddings.js')
        embedFn = (texts) => embed(texts)
      }

      for (let i = 0; i < toEmbed.length; i += EMBED_API_BATCH) {
        const chunk = toEmbed.slice(i, i + EMBED_API_BATCH)
        const embeddings = await embedFn(chunk.map(e => e.text))
        for (let j = 0; j < chunk.length && j < embeddings.length; j++) {
          this._hashToVec.set(chunk[j].hash, Float32Array.from(embeddings[j]))
        }
      }

      for (const entry of entries) {
        const vec = this._hashToVec.get(entry.hash)
        if (vec) newVectors.set(entry.id, vec)
      }
    }

    this.vectors = newVectors
    this._idToHash = newIdToHash
    this._computeNorms()
    this.lastEmbedStats = { total: entries.length, reused, embedded: toEmbed.length }
  }

  async search(query, opts = {}) {
    if (!this.loaded) this.load()

    const bm25Results = this.bm25.search(query, opts)

    // Vectors need a configured embedding model to embed the query; without
    // one (e.g. embeddings turned off after an ingest) BM25 alone answers.
    if (this.vectors.size === 0 || !EMBED_MODEL) {
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

      const queryNorm = vectorNorm(queryVec)
      for (const [id, vec] of this.vectors) {
        const sim = cosineSimilarity(queryVec, queryNorm, vec, this._norms.get(id))
        if (!scores.has(id)) {
          const doc = this.bm25.documents.get(id)
          if (doc && (!opts.kinds || opts.kinds.length === 0 || opts.kinds.includes(doc.node.kind))) {
            scores.set(id, { bm25: 0, vec: sim, node: doc.node })
          }
        } else {
          scores.get(id).vec = sim
        }
      }

      // Loop rather than Math.max(...spread): spreading 100k+ values overflows the stack.
      let bm25Max = 1
      let vecMax = 1
      for (const s of scores.values()) {
        if (s.bm25 > bm25Max) bm25Max = s.bm25
        if (s.vec > vecMax) vecMax = s.vec
      }

      const combined = []
      for (const [id, s] of scores) {
        const normalized = (s.bm25 / bm25Max) * 0.4 + (s.vec / vecMax) * 0.6
        combined.push({ id, score: normalized, node: s.node })
      }

      combined.sort((a, b) => b.score - a.score)
      const limit = opts.limit || 10
      return combined.slice(0, limit)
    } catch (err) {
      console.error(`[l2] semantic search failed, using BM25 only: ${err.message}`)
      return bm25Results
    }
  }

  async searchByKind(query, kind, opts = {}) {
    return this.search(query, { ...opts, kinds: [kind] })
  }

  /**
   * On-disk layout (directory):
   *   vectors.<gen>.bin        Float32 little-endian, vectors back to back
   *   vectors.<gen>.meta.json  { dim, ids[], hashes[] }
   *   bm25.json                BM25 data + `vectorsGeneration: <gen>`
   * Vector files are written first and bm25.json last, so the atomic rename
   * of bm25.json commits both together; a crash never pairs BM25 data with
   * vectors keyed to different node ids. The previous generation is kept for
   * readers that already hold the old bm25.json.
   */
  save(outputPath) {
    const baseDir = outputPath || this.indexPath
    if (!baseDir) throw new Error('No indexPath configured')

    const dir = baseDir.replace(/\.json$/, '')
    fs.mkdirSync(dir, { recursive: true })

    let generation = null
    if (this.vectors.size > 0) {
      generation = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
      const ids = [...this.vectors.keys()]
      const dim = this.vectors.get(ids[0]).length
      const packed = new Float32Array(ids.length * dim)
      ids.forEach((id, i) => packed.set(this.vectors.get(id).subarray(0, dim), i * dim))
      atomicWriteFileSync(path.join(dir, `vectors.${generation}.bin`), Buffer.from(packed.buffer))
      atomicWriteFileSync(path.join(dir, `vectors.${generation}.meta.json`), JSON.stringify({
        dim,
        ids,
        hashes: ids.map(id => this._idToHash.get(id) || null),
      }))
    }

    const bm25Data = { ...this.bm25.serialize(), vectorsGeneration: generation }
    atomicWriteFileSync(path.join(dir, 'bm25.json'), JSON.stringify(bm25Data))
    pruneVectorGenerations(dir, generation, this._loadedGeneration)
    this._loadedGeneration = generation
  }

  load(inputPath) {
    const baseDir = inputPath || this.indexPath
    if (!baseDir) {
      this.loaded = false
      return false
    }

    const dir = baseDir.replace(/\.json$/, '')

    // Pre-directory indexes were a single `<dir>.json` file.
    const legacyFile = `${dir}.json`
    const bm25File = path.join(dir, 'bm25.json')

    const dataFile = [bm25File, legacyFile].find(file => fs.existsSync(file))
    if (!dataFile) {
      this.loaded = false
      return false
    }

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'))
    this.bm25.load(data)

    this.vectors.clear()
    this._hashToVec.clear()
    this._idToHash.clear()
    if (data.vectorsGeneration) {
      this._loadBinaryVectors(dir, data.vectorsGeneration)
    } else if (!('vectorsGeneration' in data)) {
      // Index written before binary vectors existed.
      const vecFile = path.join(dir, 'vectors.json')
      const legacyVectors = fs.existsSync(vecFile)
        ? JSON.parse(fs.readFileSync(vecFile, 'utf-8'))
        : (data.vectors || [])
      for (const { id, hash, vec } of legacyVectors) this._setVector(id, hash, Float32Array.from(vec))
    }
    this._loadedGeneration = data.vectorsGeneration || null
    this._computeNorms()

    this.loaded = true
    return true
  }

  _loadBinaryVectors(dir, generation) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `vectors.${generation}.meta.json`), 'utf-8'))
    const raw = fs.readFileSync(path.join(dir, `vectors.${generation}.bin`))
    // Copy into a fresh, 4-byte-aligned buffer (pooled Buffers may be unaligned).
    const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    const { dim, ids, hashes } = meta
    if (all.length !== ids.length * dim) throw new Error(`Corrupt vector index: ${generation}`)
    ids.forEach((id, i) => this._setVector(id, hashes[i], all.subarray(i * dim, (i + 1) * dim)))
  }

  _setVector(id, hash, vec) {
    this.vectors.set(id, vec)
    if (hash) {
      this._hashToVec.set(hash, vec)
      this._idToHash.set(id, hash)
    }
  }

  _computeNorms() {
    this._norms = new Map()
    for (const [id, vec] of this.vectors) this._norms.set(id, vectorNorm(vec))
  }

  isLoaded() {
    return this.loaded
  }
}

function textHash(text) {
  return createHash('sha1').update(text).digest('hex')
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
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error('Embedding API URL must use http or https'))
      return
    }
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
      // Total deadline, not an idle timeout: this also runs inside MCP queries
      // (hybrid search), where a slowly trickling response must not hang them.
      signal: AbortSignal.timeout(EMBED_REQUEST_TIMEOUT_MS),
    }

    const req = mod.request(reqOpts, (res) => {
      let data = ''
      let size = 0
      const maxResponseBytes = 16 * 1024 * 1024
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > maxResponseBytes) {
          req.destroy(new Error('Embedding response exceeded 16 MiB'))
          return
        }
        data += chunk
      })
      res.on('end', () => {
        try {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Embedding server returned HTTP ${res.statusCode || 'unknown'}`))
            return
          }
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

    req.on('error', (err) => {
      reject(err.name === 'AbortError' || err.name === 'TimeoutError'
        ? new Error(`Embedding request timed out after ${EMBED_REQUEST_TIMEOUT_MS}ms`, { cause: err })
        : err)
    })
    req.write(body)
    req.end()
  })
}

function vectorNorm(vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  return Math.sqrt(sum)
}

function cosineSimilarity(a, normA, b, normB) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  const denom = normA * (normB ?? vectorNorm(b))
  return denom === 0 ? 0 : dot / denom
}

// Drops vector generations other than the current and the one this process
// last loaded, plus the legacy vectors.json (superseded by any new save).
function pruneVectorGenerations(dir, current, previous) {
  const keep = new Set([current, previous].filter(Boolean))
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^vectors\.(.+?)\.(?:bin|meta\.json)$/)
    if (match && !keep.has(match[1])) {
      try { fs.unlinkSync(path.join(dir, name)) } catch {}
    }
  }
  if (fs.existsSync(path.join(dir, 'vectors.json'))) {
    try { fs.unlinkSync(path.join(dir, 'vectors.json')) } catch {}
  }
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
