import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import tls from 'node:tls'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { SocksClient } from 'socks'

export const PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:']
export const DIRECT = 'direct'

function badProxy(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_proxy' })
}

/** @param {string} value */
export function parseProxy(value) {
  const text = String(value ?? '').trim()
  if (!text) throw badProxy('Укажите адрес прокси')
  let url
  try { url = new URL(text.includes('://') ? text : `http://${text}`) } catch { throw badProxy(`Некорректный адрес прокси: ${text}`) }
  if (!PROXY_PROTOCOLS.includes(url.protocol)) throw badProxy('Прокси должен начинаться с http://, https://, socks5:// или socks5h://')
  if (!url.hostname) throw badProxy('В адресе прокси нет хоста')
  const socks = url.protocol.startsWith('socks')
  const port = Number(url.port) || (socks ? 1080 : url.protocol === 'https:' ? 443 : 80)
  return {
    url: url.href.replace(/\/$/, ''),
    protocol: url.protocol,
    socks,
    remoteDns: url.protocol === 'socks5h:',
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
  }
}

/** Нормализует значение прокси для сохранения: '' | 'direct' | url. */
export function normalizeProxyValue(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text === DIRECT) return DIRECT
  return parseProxy(text).url
}

/** Скрывает пароль в адресе прокси для отображения в логах. */
export function maskProxy(value) {
  const text = String(value ?? '')
  return text.replace(/\/\/([^:@/]*):([^@/]*)@/, '//$1:***@')
}

const dispatchers = new Map()

/** @param {string} value */
export function dispatcherFor(value) {
  const proxy = parseProxy(value)
  const cached = dispatchers.get(proxy.url)
  if (cached) return cached
  const dispatcher = proxy.socks
    ? new Agent({ connect: socksConnector(proxy) })
    : new ProxyAgent({ uri: proxy.url })
  dispatchers.set(proxy.url, dispatcher)
  return dispatcher
}

function socksConnector(proxy) {
  return (options, callback) => {
    let finished = false
    const done = (error, socket) => {
      if (finished) return
      finished = true
      callback(error, socket)
    }
    const secure = options.protocol === 'https:'
    const port = Number(options.port) || (secure ? 443 : 80)
    const target = String(options.hostname).replace(/^\[|\]$/g, '')
    resolveTarget(target, proxy.remoteDns)
      .then((host) => SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: 5, ...(proxy.username ? { userId: proxy.username, password: proxy.password } : {}) },
        command: 'connect',
        destination: { host, port },
        timeout: Number(options.timeout) || 15_000,
      }))
      .then(({ socket }) => {
        if (!secure) return done(null, socket)
        const secured = tls.connect({ socket, servername: options.servername || (isIP(target) ? undefined : target), ALPNProtocols: ['http/1.1'] })
        secured.once('secureConnect', () => done(null, secured))
        secured.once('error', (error) => { secured.destroy(); done(error, null) })
      })
      .catch((error) => done(Object.assign(new Error(`SOCKS5 прокси: ${error.message}`), { code: 'proxy_error' }), null))
  }
}

async function resolveTarget(host, remoteDns) {
  if (remoteDns || isIP(host)) return host
  const { address } = await lookup(host)
  return address
}

/**
 * Выбор прокси: настройка провайдера > 'direct' > глобальный прокси.
 * @returns {string} url прокси или '' (без прокси)
 */
export function proxyFor(settings, providerId) {
  const own = String(settings?.providerProxies?.[providerId] ?? '').trim()
  if (own === DIRECT) return ''
  if (own) return own
  const global = settings?.proxy
  if (global?.enabled && String(global.url ?? '').trim()) return String(global.url).trim()
  return ''
}

/** fetch с прокси из настроек. Без прокси используется обычный глобальный fetch. */
export function fetchVia(proxyUrl, url, init = {}) {
  if (!proxyUrl) return globalThis.fetch(url, init)
  return undiciFetch(url, { ...init, dispatcher: dispatcherFor(proxyUrl) })
}

/**
 * @param {{read: () => Promise<any>}} store
 * @param {string} providerId
 */
export function createProviderFetch(store, providerId) {
  return async (url, init = {}) => {
    const state = await store.read()
    return fetchVia(proxyFor(state.settings, providerId), url, init)
  }
}

/** Проверяет прокси запросом внешнего IP. */
export async function testProxy(proxyUrl, { url = 'https://api.ipify.org?format=json', timeoutMs = 15_000 } = {}) {
  const started = Date.now()
  try {
    if (proxyUrl) parseProxy(proxyUrl)
    const response = await fetchVia(proxyUrl, url, { signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text()
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, ms: Date.now() - started }
    let ip = text.trim()
    try { ip = JSON.parse(text).ip ?? ip } catch { /* plain text */ }
    return { ok: true, ip, ms: Date.now() - started }
  } catch (error) {
    const cause = error?.cause?.message ? `: ${error.cause.message}` : ''
    return { ok: false, error: `${error?.message ?? String(error)}${cause}`, ms: Date.now() - started }
  }
}
