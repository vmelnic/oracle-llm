/**
 * Pure-JS BM25 implementation for AST node retrieval (L2).
 *
 * Reference: Robertson et al., "Okapi at TREC-3"
 * Simplified for single-field documents (AST node summaries).
 */

const DEFAULT_K1 = parseFloat(process.env.ORACLE_BM25_K1 || '1.2')
const DEFAULT_B = parseFloat(process.env.ORACLE_BM25_B || '0.75')
const EPSILON = 0.25

function tokenize(text) {
  if (!text) return []
  // Split camelCase, PascalCase, snake_case, kebab-case, and non-alphanumeric
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
  return normalized
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

function buildFrequencyMap(tokens) {
  const map = new Map()
  for (const t of tokens) {
    map.set(t, (map.get(t) || 0) + 1)
  }
  return map
}

export class Bm25Index {
  constructor({ k1 = DEFAULT_K1, b = DEFAULT_B } = {}) {
    this.k1 = k1
    this.b = b
    this.documents = new Map() // id -> { tokens, length, node }
    this.docCount = 0
    this.avgDocLen = 0
    this.totalDocLen = 0
    this.invertedIndex = new Map() // term -> { docId -> freq }
    this.idfCache = new Map()
  }

  addDocument(id, text, nodeMeta) {
    if (this.documents.has(id)) {
      this.removeDocument(id)
    }

    const tokens = tokenize(text)
    const length = tokens.length
    const freqMap = buildFrequencyMap(tokens)

    this.documents.set(id, { tokens, length, node: nodeMeta })
    this.docCount++
    this.totalDocLen += length
    this.avgDocLen = this.totalDocLen / this.docCount

    for (const [term, freq] of freqMap) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Map())
      }
      this.invertedIndex.get(term).set(id, freq)
    }

    this.idfCache.clear()
  }

  removeDocument(id) {
    const doc = this.documents.get(id)
    if (!doc) return

    const freqMap = buildFrequencyMap(doc.tokens)
    for (const [term] of freqMap) {
      const postings = this.invertedIndex.get(term)
      if (postings) {
        postings.delete(id)
        if (postings.size === 0) {
          this.invertedIndex.delete(term)
        }
      }
    }

    this.documents.delete(id)
    this.docCount--
    this.totalDocLen -= doc.length
    this.avgDocLen = this.docCount > 0 ? this.totalDocLen / this.docCount : 0
    this.idfCache.clear()
  }

  idf(term) {
    if (this.idfCache.has(term)) return this.idfCache.get(term)

    const postings = this.invertedIndex.get(term)
    const n = postings ? postings.size : 0

    // idf with smoothing
    const idfValue = Math.log(1 + (this.docCount - n + 0.5) / (n + 0.5))
    this.idfCache.set(term, idfValue)
    return idfValue
  }

  search(query, { limit = 10, kinds = [] } = {}) {
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const scores = new Map()

    for (const term of queryTokens) {
      const postings = this.invertedIndex.get(term)
      if (!postings) continue

      for (const [docId, termFreq] of postings) {
        const doc = this.documents.get(docId)
        if (!doc) continue

        if (kinds.length > 0 && !kinds.includes(doc.node.kind)) continue

        const idf = this.idf(term)
        const docLen = doc.length || 1
        const avgLen = this.avgDocLen || 1
        const denom =
          termFreq + this.k1 * (1 - this.b + this.b * (docLen / avgLen))
        const score = idf * ((termFreq * (this.k1 + 1)) / denom)

        scores.set(docId, (scores.get(docId) || 0) + score)
      }
    }

    const results = []
    for (const [docId, score] of scores) {
      results.push({ id: docId, score, node: this.documents.get(docId).node })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  serialize() {
    const docs = []
    for (const [id, doc] of this.documents) {
      docs.push({ id, node: doc.node })
    }
    return {
      k1: this.k1,
      b: this.b,
      docCount: this.docCount,
      totalDocLen: this.totalDocLen,
      avgDocLen: this.avgDocLen,
      documents: docs,
      invertedIndex: Array.from(this.invertedIndex.entries()).map(
        ([term, postings]) => [term, Array.from(postings.entries())]
      ),
    }
  }

  load(data) {
    this.k1 = data.k1 ?? DEFAULT_K1
    this.b = data.b ?? DEFAULT_B
    this.docCount = data.docCount || 0
    this.totalDocLen = data.totalDocLen || 0
    this.avgDocLen = data.avgDocLen || 0
    this.documents = new Map()
    this.invertedIndex = new Map()
    this.idfCache = new Map()

    if (data.invertedIndex) {
      for (const [term, postingsArr] of data.invertedIndex) {
        this.invertedIndex.set(term, new Map(postingsArr))
      }
    }

    if (data.documents) {
      for (const { id, node } of data.documents) {
        // Reconstruct tokens from inverted index for length bookkeeping
        const tokens = []
        for (const [term, postings] of this.invertedIndex) {
          const freq = postings.get(id)
          if (freq) {
            for (let i = 0; i < freq; i++) tokens.push(term)
          }
        }
        this.documents.set(id, { tokens, length: tokens.length, node })
      }
    }
  }
}
