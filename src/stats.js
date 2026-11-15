const SESSION_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const STATS_RETAIN_MS = 8 * 24 * 60 * 60 * 1000

export function emptyUsageStats() {
  return { totals: [], recent: [] }
}

export function recordUsage(stats, event, now = Date.now()) {
  const next = {
    totals: [...(stats?.totals ?? [])],
    recent: [...(stats?.recent ?? [])],
  }
  const model = String(event.model || '')
  const provider = String(event.provider || '')
  const keyLabel = String(event.keyLabel || '')
  const input = finite(event.input)
  const output = finite(event.output)
  const cacheRead = Math.min(input, finite(event.cacheRead))
  const cacheWrite = Math.min(Math.max(0, input - cacheRead), finite(event.cacheWrite))
  const row = next.totals.find((item) => item.model === model && item.provider === provider && item.keyLabel === keyLabel)
  if (row) {
    row.input += input
    row.output += output
    row.cacheRead = finite(row.cacheRead) + cacheRead
    row.cacheWrite = finite(row.cacheWrite) + cacheWrite
    row.requests += 1
  } else {
    next.totals.push({ model, provider, keyLabel, input, output, cacheRead, cacheWrite, requests: 1 })
  }
  if (input || output) next.recent.push({ at: now, model, provider, keyLabel, input, output, cacheRead, cacheWrite })
  const cutoff = now - STATS_RETAIN_MS
  next.recent = next.recent.filter((item) => item.at >= cutoff)
  return next
}

export function buildStats(stats = emptyUsageStats(), providers = [], { now = Date.now(), key } = {}) {
  const totals = stats.totals ?? []
  const recent = stats.recent ?? []
  const labels = [...new Set(totals.map((item) => item.keyLabel || ''))]
  const rows = new Map()
  for (const item of totals) {
    if (key !== undefined && (item.keyLabel || '') !== key) continue
    const id = `${item.provider}\0${item.model}`
    const row = rows.get(id) ?? { model: item.model, provider: item.provider, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
    row.input += finite(item.input)
    row.output += finite(item.output)
    row.cacheRead += finite(item.cacheRead)
    row.cacheWrite += finite(item.cacheWrite)
    row.requests += finite(item.requests)
    rows.set(id, row)
  }
  const models = [...rows.values()].map((row) => {
    const cacheRead = Math.min(row.input, row.cacheRead)
    const cacheWrite = Math.min(Math.max(0, row.input - cacheRead), row.cacheWrite)
    return {
      ...row,
      cacheRead,
      cacheWrite,
      total: row.input + row.output,
      windows: windowsFor(row, providers, recent, now, key),
    }
  }).sort((left, right) => right.total - left.total || left.model.localeCompare(right.model))
  return {
    keys: labels.filter(Boolean).sort((left, right) => left.localeCompare(right)),
    anonymous: labels.includes(''),
    models,
  }
}

function windowsFor(row, providers, recent, now, key) {
  const usage = providers.find((provider) => provider.id === row.provider)?.usage
  const windows = usage?.supported ? usage.windows ?? [] : []
  if (!windows.length) return []
  return windows.map((window) => {
    const bounds = windowBounds(window, now)
    if (!bounds || !Number.isFinite(window.usedPercent)) return { kind: window.kind, scope: window.scope, percent: null }
    const inWindow = recent.filter((item) => item.provider === row.provider && item.at >= bounds.start && item.at < bounds.end)
    const allTokens = inWindow.reduce((sum, item) => sum + finite(item.input) + finite(item.output), 0)
    if (!allTokens) return { kind: window.kind, scope: window.scope, percent: 0 }
    const own = inWindow
      .filter((item) => item.model === row.model && (key === undefined || (item.keyLabel || '') === key))
      .reduce((sum, item) => sum + finite(item.input) + finite(item.output), 0)
    const percent = Math.min(window.usedPercent, (own / allTokens) * window.usedPercent)
    return { kind: window.kind, scope: window.scope, percent: Math.round(percent * 10) / 10 }
  })
}

function windowBounds(window, now) {
  const duration = window.kind === 'session' ? SESSION_MS : window.kind === 'weekly' ? WEEK_MS : 0
  if (!duration || !Number.isFinite(window.resetsAt)) return null
  return { start: window.resetsAt - duration, end: Math.min(window.resetsAt, now + 1) }
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}
