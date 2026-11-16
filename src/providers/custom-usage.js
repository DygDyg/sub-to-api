const NEURAL_TOKENS_PER_USD = 500_000

const DETECTORS = [
  {
    id: 'anymodel',
    label: 'Anymodel',
    paths: ['/balance', '/key'],
    parse: parseAnymodel,
  },
  {
    id: 'neural',
    label: 'Neural API',
    paths: ['/dashboard/billing/subscription', '/dashboard/billing/usage'],
    merge: true,
    parse: parseNeural,
  },
]

/** Пробует известные схемы квот и возвращает первую распознанную. */
export async function detectCustomUsage(provider, signal) {
  for (const detector of DETECTORS) {
    const snapshot = await requestUsage(provider, detector, signal, false)
    if (snapshot) return { mode: detector.id, label: detector.label, snapshot }
  }
  return { mode: '', label: '', snapshot: unsupported() }
}

/** Загружает квоту в ранее определённом режиме. */
export async function customUsage(provider, mode, signal) {
  const detector = DETECTORS.find((item) => item.id === mode)
  if (!detector) return unsupported()
  return await requestUsage(provider, detector, signal, true)
    ?? { supported: true, windows: [], error: `${detector.label}: формат ответа о лимитах изменился`, fetchedAt: Date.now() }
}

export function customUsageMode(mode) {
  return DETECTORS.some((detector) => detector.id === mode) ? mode : ''
}

async function requestUsage(provider, detector, signal, reportErrors) {
  if (detector.merge) return requestMergedUsage(provider, detector, signal, reportErrors)
  let lastError = ''
  for (const path of detector.paths) {
    try {
      const response = await provider.fetch(provider.url(path), { headers: provider.headers(), signal })
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }
      const snapshot = detector.parse(await response.json())
      if (snapshot) return snapshot
      lastError = 'неизвестный формат ответа'
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return reportErrors
    ? { supported: true, windows: [], error: `${detector.label}: ${lastError || 'не удалось получить лимиты'}`, fetchedAt: Date.now() }
    : null
}

async function requestMergedUsage(provider, detector, signal, reportErrors) {
  const merged = {}
  let answered = 0
  let lastError = ''
  for (const path of detector.paths) {
    try {
      const response = await provider.fetch(provider.url(path), { headers: provider.headers(), signal })
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }
      const payload = await response.json()
      const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        lastError = 'неизвестный формат ответа'
        continue
      }
      answered++
      for (const [name, value] of Object.entries(source)) {
        if (value !== null && value !== '' && (merged[name] === undefined || merged[name] === null || merged[name] === '')) merged[name] = value
      }
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  const snapshot = answered ? detector.parse(merged) : null
  if (snapshot) return snapshot
  return reportErrors
    ? { supported: true, windows: [], error: `${detector.label}: ${answered ? 'формат ответа о лимитах изменился' : (lastError || 'не удалось получить лимиты')}`, fetchedAt: Date.now() }
    : null
}

function parseAnymodel(payload) {
  const data = payload?.data
  const limit = Number(data?.token_limit)
  const used = Number(data?.used)
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used) || used < 0) return null
  const remainingValue = Number(data?.remaining)
  const remaining = Number.isFinite(remainingValue) ? remainingValue : Math.max(0, limit - used)
  const usedPercent = Math.max(0, Math.min(100, used / limit * 100))
  return {
    supported: true,
    plan: data.name ? String(data.name) : undefined,
    windows: [{ kind: 'other', scope: 'Токены', usedPercent, used, limit, remaining, unit: 'токенов' }],
    fetchedAt: Date.now(),
  }
}

/** Лимит Neural API в долларах, расход в центах. Курс как на странице /check: $1 = 500 000 токенов. */
function parseNeural(data) {
  const limits = [data?.soft_limit_usd, data?.hard_limit_usd, data?.system_hard_limit_usd].map(Number).filter((value) => Number.isFinite(value) && value > 0)
  if (!limits.length) return null
  let totalUsd = Math.max(...limits)
  const sameLimit = limits.every((value) => value === totalUsd)
  let usedUsd = finite(data?.usage_usd)
  if (usedUsd === null) {
    const cents = finite(data?.total_usage) ?? finite(data?.usage_total)
    if (cents !== null) usedUsd = cents / 100
  }
  let leftUsd = sameLimit ? (usedUsd === null ? totalUsd : Math.max(0, totalUsd - usedUsd)) : Math.min(...limits)
  if (!sameLimit && usedUsd !== null && totalUsd < leftUsd + usedUsd) totalUsd = leftUsd + usedUsd
  const limit = totalUsd * NEURAL_TOKENS_PER_USD
  const used = (usedUsd ?? 0) * NEURAL_TOKENS_PER_USD
  const remaining = leftUsd * NEURAL_TOKENS_PER_USD
  const plan = [data?.plan, data?.plan_name, data?.group].find((value) => typeof value === 'string' && value.trim())
  return {
    supported: true,
    ...(plan ? { plan: plan.trim() } : {}),
    windows: [{
      kind: 'other',
      scope: 'Токены',
      usedPercent: Math.max(0, Math.min(100, used / limit * 100)),
      used,
      limit,
      remaining,
      unit: 'токенов',
    }],
    fetchedAt: Date.now(),
  }
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function unsupported() {
  return { supported: false, windows: [], fetchedAt: Date.now() }
}
