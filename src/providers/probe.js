import { isIP } from 'node:net'
import { antigravityAuthHeaders } from './antigravity.js'
import { claudeAuthHeaders } from './claude.js'
import { codexAuthHeaders } from './codex.js'
import { copilotAuthHeaders } from './copilot.js'
import { grokAuthHeaders } from './grok.js'
import { grokbotAuthHeaders } from './grokbot.js'

const METHODS = new Set(['GET', 'POST'])
const LIMITS = { timeoutMs: 20_000, responseBytes: 2 * 1024 * 1024, bodyBytes: 64 * 1024 }
const HOSTS = {
  codex: ['chatgpt.com'],
  claude: ['api.anthropic.com'],
  grok: ['api.x.ai', 'cli-chat-proxy.grok.com'],
  grokbot: ['api2.cursor.sh'],
  copilot: ['api.githubcopilot.com'],
  antigravity: ['cloudcode-pa.googleapis.com'],
}
const AUTH = {
  codex: codexAuthHeaders,
  claude: claudeAuthHeaders,
  grok: grokAuthHeaders,
  grokbot: grokbotAuthHeaders,
  copilot: copilotAuthHeaders,
  antigravity: antigravityAuthHeaders,
}
const SECRET = /"(?:access_token|refresh_token|id_token|api_key|client_secret|password|authorization|secret|token)"\s*:\s*"(?:[^"\\]|\\.)*"/gi

/** Проверяет и нормализует диагностический запрос до обращения к сессии. */
export function probeRequest(providerId, input = {}) {
  const method = String(input.method ?? 'GET').toUpperCase()
  if (!METHODS.has(method)) throw invalid('method: только GET или POST')
  const target = parseTarget(input.url)
  const allowed = HOSTS[providerId] ?? (String(providerId).startsWith('custom-') ? null : undefined)
  if (allowed === undefined) throw invalid('Для этого провайдера диагностический запрос не поддерживается')
  if (allowed && !allowed.some((host) => target.hostname === host || target.hostname.endsWith(`.${host}`))) {
    throw invalid(`Хост не разрешён для ${providerId}: ${allowed.join(', ')}`)
  }
  if (!allowed && !isPublicHttpHost(target.hostname)) throw invalid('Адрес должен быть публичным https-хостом провайдера')
  const headers = normalizeHeaders(input.headers)
  const body = input.body === undefined ? undefined : typeof input.body === 'string' ? input.body : JSON.stringify(input.body)
  if (body && Buffer.byteLength(body) > LIMITS.bodyBytes) throw invalid('Тело запроса больше 64 КБ')
  if (body && method === 'GET') throw invalid('GET не может содержать тело')
  return { method, url: target.href, headers, ...(body ? { body } : {}) }
}

/** Выполняет запрос через fetch провайдера и возвращает только безопасную сводку. */
export async function runProbe(fetchImpl, request, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const started = Date.now()
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: request.body } : {}),
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') ?? ''
    const raw = Buffer.from(await response.arrayBuffer())
    const truncated = raw.byteLength > LIMITS.responseBytes
    const text = raw.subarray(0, LIMITS.responseBytes).toString('utf8')
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      bytes: raw.byteLength,
      truncated,
      ms: Date.now() - started,
      body: presentBody(text, contentType),
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export function authHeadersFor(providerId, session) {
  return AUTH[providerId]?.(session) ?? (session?.accessToken ? { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' } : { accept: 'application/json' })
}

function parseTarget(value) {
  let target
  try { target = new URL(String(value ?? '')) } catch { throw invalid('Некорректный URL') }
  if (target.protocol !== 'https:' || target.username || target.password || !target.hostname) throw invalid('Разрешён только https без учётных данных в URL')
  if (isIP(target.hostname) || target.hostname === 'localhost' || target.hostname.endsWith('.local')) throw invalid('IP-адреса и локальные хосты запрещены')
  return target
}

function isPublicHttpHost(hostname) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname) && !hostname.endsWith('.local')
}

function normalizeHeaders(input) {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('headers: ожидается объект')
  const headers = {}
  for (const [name, value] of Object.entries(input)) {
    const key = String(name).toLowerCase()
    if (!/^[a-z0-9-]{1,64}$/.test(key)) throw invalid(`Недопустимый заголовок: ${name}`)
    if (['authorization', 'cookie', 'proxy-authorization', 'host'].includes(key) || key.includes('token') || key.includes('secret') || key.includes('api-key')) {
      throw invalid(`Заголовок ${name} задаётся сессией и не принимается из запроса`)
    }
    if (typeof value !== 'string' || value.length > 500) throw invalid(`Недопустимое значение заголовка ${name}`)
    headers[key] = value
  }
  return headers
}

function presentBody(text, contentType) {
  const redacted = text.replace(SECRET, (match) => `${match.slice(0, match.indexOf(':') + 1)} "[redacted]"`)
  if (!contentType.includes('json')) return redacted
  try { return JSON.parse(redacted) } catch { return redacted }
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_probe' })
}
