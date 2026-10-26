import { nonNegativeInt } from '../utils/env.js'

let _extractor = null
let _loading = null
let _idleTimer = null

const UNLOAD_TIMEOUT = nonNegativeInt(process.env.ORACLE_EMBED_UNLOAD_TIMEOUT, 300)

function _resetIdleTimer() {
  if (UNLOAD_TIMEOUT <= 0) return
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    _extractor = null
    _idleTimer = null
  }, UNLOAD_TIMEOUT * 1000)
  _idleTimer.unref?.()
}

async function loadEmbedder(modelName) {
  if (_extractor) {
    _resetIdleTimer()
    return _extractor
  }
  if (_loading) return _loading

  const model = modelName || process.env.ORACLE_EMBED_MODEL
  if (!model) {
    throw new Error(
      'ORACLE_EMBED_MODEL not set. Example: ORACLE_EMBED_MODEL=jinaai/jina-embeddings-v2-base-code'
    )
  }

  _loading = (async () => {
    let mod
    try {
      mod = await import('@huggingface/transformers')
    } catch (error) {
      throw new Error(
        'Embeddings enabled but @huggingface/transformers could not be loaded. ' +
        'Run npm install and verify the native ONNX runtime for this platform.',
        { cause: error }
      )
    }

    try {
      _extractor = await mod.pipeline('feature-extraction', model, {
        dtype: 'q8',
      })
    } catch (error) {
      throw new Error(`Failed to load embedding model "${model}": ${error.message}`, {
        cause: error,
      })
    }

    _resetIdleTimer()
    return _extractor
  })().finally(() => {
    _loading = null
  })

  return _loading
}

export async function embed(texts, modelName) {
  const extractor = await loadEmbedder(modelName)
  const results = []
  const BATCH = 64

  // Note: measured on CPU ONNX — per-text inference beats batching here
  // (batch padding costs more than the per-call overhead), so keep it simple.
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    for (const text of batch) {
      const output = await extractor(text, { pooling: 'mean', normalize: true })
      results.push(Array.from(output.data))
    }
  }

  _resetIdleTimer()
  return results
}

export async function embedSingle(text, modelName) {
  const extractor = await loadEmbedder(modelName)
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  _resetIdleTimer()
  return Array.from(output.data)
}
