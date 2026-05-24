// TOON (Token-Oriented Object Notation) serializer
// 30-50% fewer tokens than JSON for arrays of homogeneous objects.
// LLMs parse TOON with equal or better accuracy (see toon-format benchmarks).

export function toToon(obj) {
  if (obj === null || obj === undefined) return 'null'
  if (typeof obj !== 'object') return String(obj)
  return serializeObject(obj, 0)
}

function serializeObject(obj, depth) {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return '{}'

  const pad = '  '.repeat(depth)
  const lines = []

  for (const [key, value] of entries) {
    if (value === null) {
      lines.push(`${pad}${key}: -`)
    } else if (Array.isArray(value)) {
      const arrResult = serializeArray(value, depth + 1)
      if (arrResult.tabular) {
        lines.push(`${pad}${key}: ${arrResult.text}`)
      } else {
        lines.push(`${pad}${key}: ${arrResult.text}`)
      }
    } else if (typeof value === 'object') {
      const nested = serializeObject(value, depth + 1)
      if (nested.includes('\n')) {
        lines.push(`${pad}${key}:`)
        lines.push(nested)
      } else {
        lines.push(`${pad}${key}: ${nested.trim()}`)
      }
    } else {
      lines.push(`${pad}${key}: ${formatVal(value)}`)
    }
  }

  return lines.join('\n')
}

function serializeArray(arr, depth) {
  if (arr.length === 0) return { text: '[]', tabular: false }

  if (arr.every(v => v === null || typeof v !== 'object')) {
    return { text: `[${arr.map(v => formatVal(v)).join(',')}]`, tabular: false }
  }

  if (isTabularizable(arr)) {
    return { text: tabularize(arr, depth), tabular: true }
  }

  const pad = '  '.repeat(depth)
  const items = arr.map(item => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const pairs = Object.entries(item)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}:${formatVal(v)}`)
      return `${pad}- {${pairs.join(', ')}}`
    }
    return `${pad}- ${formatVal(item)}`
  })
  return { text: '\n' + items.join('\n'), tabular: false }
}

function isTabularizable(arr) {
  if (arr.length < 1) return false
  return arr.every(item =>
    item && typeof item === 'object' && !Array.isArray(item)
    && Object.values(item).every(v =>
      v === null || v === undefined
      || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      || (Array.isArray(v) && v.every(x => typeof x !== 'object'))
    )
  )
}

function tabularize(arr, depth) {
  const keys = collectKeys(arr)
  const pad = '  '.repeat(depth)
  const header = `[${arr.length}]{${keys.join(',')}}:`
  const rows = arr.map(item =>
    `${pad}${keys.map(k => formatVal(item[k])).join(',')}`
  )
  return header + '\n' + rows.join('\n')
}

function collectKeys(arr) {
  const seen = new Set()
  const keys = []
  for (const item of arr) {
    for (const k of Object.keys(item)) {
      if (!seen.has(k)) { seen.add(k); keys.push(k) }
    }
  }
  return keys
}

function formatVal(v) {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return `[${v.map(x => formatVal(x)).join(',')}]`
  if (typeof v === 'string') {
    if (/^[\w./:@_-]+$/.test(v) && v.length > 0 && v.length < 200) return v
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function estimateToonSavings(obj) {
  const jsonLen = JSON.stringify(obj, null, 2).length
  const toonLen = toToon(obj).length
  return {
    json_chars: jsonLen,
    toon_chars: toonLen,
    savings_pct: Math.round((1 - toonLen / jsonLen) * 100),
    json_tokens_est: Math.ceil(jsonLen / 4),
    toon_tokens_est: Math.ceil(toonLen / 4),
  }
}
