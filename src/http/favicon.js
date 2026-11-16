const CACHE_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 256 * 1024
const cache = new Map()

/** Хост сайта, не путь API. Префикс api. снимается, только если остаётся домен с точкой. */
export function faviconSite(baseUrl) {
  let host = ''
  try { host = new URL(String(baseUrl ?? '')).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { return '' }
  if (!host || host === 'localhost' || !host.includes('.') || /^\d/.test(host)) return ''
  if (host.startsWith('api.')) {
    const root = host.slice(4)
    if (root.includes('.')) return root
  }
  return host
}

/** Google без этого адреса подставляет http:// и картинка не грузится. */
export function faviconSource(site) {
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(`https://${site}`)}&size=128`
}

/** Скачивает иконку и держит её в памяти. @param {typeof fetch} [fetchImpl] */
export async function loadFavicon(site, fetchImpl = globalThis.fetch, now = Date.now()) {
  const cached = cache.get(site)
  if (cached && now - cached.at < CACHE_MS) return cached
  const response = await fetchImpl(faviconSource(site), { signal: AbortSignal.timeout(8_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const type = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!type.startsWith('image/')) throw new Error('не изображение')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('некорректный размер')
  const entry = { bytes, type, at: now }
  cache.set(site, entry)
  return entry
}
