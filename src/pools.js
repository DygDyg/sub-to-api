const LIMIT = 5
const STRATEGIES = ['most-remaining', 'first-available', 'by-complexity']
const CLASSIFIERS = ['heuristic', 'llm', 'auto']

export function normalizePool(input) {
  const id = String(input?.id ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
  if (!id || id.length > 40) throw Object.assign(new Error('Имя пула: 1–40 символов, латиница, цифры и дефис'), { status: 400 })
  const strategy = STRATEGIES.includes(input?.strategy) ? input.strategy : 'most-remaining'
  const members = [...new Set((Array.isArray(input?.members) ? input.members : []).map(String))].filter((member) => /^[a-z]+\/\S+$/.test(member))
  if (members.length < 2) throw Object.assign(new Error('В пуле нужны хотя бы две модели вида provider/model'), { status: 400 })
  if (strategy !== 'by-complexity') return { id, strategy, members }
  const classifier = CLASSIFIERS.includes(input?.classifier) ? input.classifier : 'heuristic'
  return { id, strategy, members, classifier }
}

/** @param {{supported?: boolean, windows?: {usedPercent?: number}[]}} [snapshot] */
export function remainingPercent(snapshot) {
  if (!snapshot?.supported || !snapshot.windows?.length) return null
  const used = Math.max(...snapshot.windows.map((window) => Number(window.usedPercent) || 0))
  return Math.max(0, 100 - used)
}

/** Tokens already present in this request, not the selected model's window. */
export function estimateTokens(request) {
  let chars = 0
  for (const message of request?.messages ?? []) {
    chars += String(message?.content ?? '').length
    chars += String(message?.name ?? '').length
    chars += String(message?.toolCallId ?? '').length
    for (const call of message?.toolCalls ?? []) chars += String(call?.name ?? '').length + String(call?.arguments ?? '').length
    if (message?.reasoningByCallId) chars += JSON.stringify(message.reasoningByCallId).length
  }
  for (const tool of request?.tools ?? []) {
    chars += String(tool?.name ?? '').length + String(tool?.description ?? '').length
    try { chars += JSON.stringify(tool?.parameters ?? {}).length } catch { chars += 200 }
  }
  return Math.ceil(chars / 4)
}

export function fitsContext(window, tokens) {
  if (!Number.isFinite(window) || window <= 0) return true
  if (!Number.isFinite(tokens) || tokens <= 0) return true
  return tokens <= window
}

export function chooseMember({ members, strategy, sticky, remaining }) {
  const open = members.filter((member) => {
    const left = remaining(member)
    return left === null || left > LIMIT
  })
  if (sticky && open.includes(sticky)) return sticky
  if (!open.length) return undefined
  if (strategy === 'first-available') return open[0]
  return [...open].sort((a, b) => (remaining(b) ?? 100) - (remaining(a) ?? 100))[0]
}
