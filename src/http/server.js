import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSea, getAsset } from 'node:sea'
import { chatCompletionToCanonical, collectChatCompletion, writeChatStream } from '../openai/translate.js'
import { APP_VERSION } from '../version.js'
import { complexityOf, normalizeComplexity } from '../complexity.js'
import { API_KEY_SCOPES, allowedByExposure, apiKeyRequired, apiKeyScopeOf, apiKeysOf, canReachSettings, hostFor, isInternetAddress, lanAddresses, normalizeExposure, normalizeSettingsKeyScope, settingsExposureOf, settingsKeyMustBeSet, settingsKeyRequired, widerExposure } from '../network.js'
import { DIRECT, normalizeProxyValue, testProxy } from '../proxy.js'

export const QUIET_HOLD_MS = 25_000
export const QUIET_HOLD_LIMIT = 32

/**
 * @param {import('../gateway/service.js').GatewayService} service
 * @param {import('../storage/store.js').Store} store
 */
export function createAppServer(service, store, runtime = { host: '127.0.0.1', port: 8787, configuredPort: 8787 }, hooks = {}) {
  let quietCount = 0
  const stayQuiet = (request) => {
    request.resume?.()
    const socket = request.socket
    if (!socket || socket.destroyed) return
    const limit = runtime.quietLimit ?? QUIET_HOLD_LIMIT
    if (quietCount >= limit) {
      socket.destroy()
      return
    }
    quietCount += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      quietCount -= 1
    }
    const timer = setTimeout(() => {
      release()
      if (!socket.destroyed) socket.destroy()
    }, runtime.quietMs ?? QUIET_HOLD_MS)
    timer.unref?.()
    socket.once?.('close', () => {
      clearTimeout(timer)
      release()
    })
  }

  return createServer(async (request, response) => {
    let internetApi = false
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const remote = request.socket.remoteAddress
      const internet = isInternetAddress(remote)
      const admin = isAdminPath(url.pathname)
      const settingsOk = settingsAuthorized(request, runtime, url)
      if (internet && !(admin && settingsOk)) {
        if (!url.pathname.startsWith('/v1/') || !allowedByExposure(remote, runtime.exposure)) return stayQuiet(request)
        try {
          if (!authorizeApi(request, (await store.read()).settings).ok) return stayQuiet(request)
        } catch {
          return stayQuiet(request)
        }
        internetApi = true
      }
      if (settingsOk) rememberSettingsKey(response, url)
      if (admin && !canReachSettings(remote, runtime) && !settingsOk) {
        if (internet) return stayQuiet(request)
        return send(response, 403, { error: { message: settingsForbiddenMessage(runtime) } })
      }
      if (admin && url.pathname.startsWith('/api/') && settingsKeyRequired(remote, runtime.settingsKeyScope) && !settingsOk) {
        const given = presentedSettingsKey(request, url)
        const message = given ? 'Неверный ключ настроек' : 'Нужен ключ настроек'
        return send(response, 401, { error: { message, code: 'settings_auth' } })
      }
      if (!admin && !allowedByExposure(remote, runtime.exposure)) {
        return send(response, 403, { error: { message: apiForbiddenMessage(runtime.exposure) } })
      }
      if (request.method === 'GET' && staticPage(url.pathname)) {
        await serveStatic(staticPage(url.pathname), response)
        return
      }
      if (url.pathname.startsWith('/api/')) {
        await handleAdmin(service, store, runtime, hooks, url, request, response)
        return
      }
      if (url.pathname.startsWith('/v1/')) {
        await handleOpenAI(service, store, url, request, response, internet ? () => stayQuiet(request) : undefined)
        return
      }
      send(response, 404, { error: { message: 'Not found' } })
    } catch (error) {
      if (!internetApi && isInternetAddress(request.socket?.remoteAddress)) return stayQuiet(request)
      send(response, error.status ?? 500, { error: { message: error instanceof Error ? error.message : String(error), code: error.code } })
    }
  })
}

async function handleAdmin(service, store, runtime, hooks, url, request, response) {
  if (request.method === 'GET' && url.pathname === '/api/overview') {
    const overview = await service.overview()
    overview.settings.effectivePort = runtime.port
    overview.settings.exposure = runtime.exposure
    overview.settings.settingsExposure = settingsExposureOf(runtime)
    overview.settings.settingsKey = runtime.settingsKey || ''
    overview.settings.settingsKeyScope = normalizeSettingsKeyScope(runtime.settingsKeyScope)
    overview.settings.url = originFor(request, runtime.port)
    overview.settings.lanAddresses = lanAddresses()
    overview.version = APP_VERSION
    return send(response, 200, overview)
  }
  if (request.method === 'GET' && url.pathname === '/api/update') {
    if (!hooks.updater) return send(response, 200, { supported: false, current: APP_VERSION, available: false, state: 'idle' })
    return send(response, 200, await hooks.updater.status())
  }
  if (request.method === 'POST' && url.pathname === '/api/update/check') {
    if (!hooks.updater) return send(response, 200, { supported: false, current: APP_VERSION, available: false, state: 'idle' })
    return send(response, 200, await hooks.updater.check({ force: true }))
  }
  if (request.method === 'POST' && url.pathname === '/api/update/install') {
    if (!hooks.updater) throw Object.assign(new Error('Обновление недоступно'), { status: 400 })
    return send(response, 200, await hooks.updater.install({ pid: process.pid, port: runtime.port, exit: () => hooks.exit?.() }))
  }
  if (request.method === 'GET' && url.pathname === '/api/journal') return send(response, 200, await service.journal())
  if (request.method === 'GET' && url.pathname === '/api/stats') {
    const key = url.searchParams.has('key') ? url.searchParams.get('key') ?? '' : undefined
    return send(response, 200, await service.stats(request.signal, key))
  }
  if (request.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readJson(request)
    const current = await store.read()
    const port = body.port === undefined ? runtime.port : Number(body.port)
    const exposure = body.exposure === undefined ? normalizeExposure(current.settings.exposure) : normalizeExposure(body.exposure)
    const apiKeyScope = resolveApiKeyScope(body, current.settings)
    const settingsExposure = body.settingsExposure === undefined ? settingsExposureOf(current.settings) : normalizeExposure(body.settingsExposure)
    const settingsKeyScope = body.settingsKeyScope === undefined ? normalizeSettingsKeyScope(current.settings.settingsKeyScope) : normalizeSettingsKeyScope(body.settingsKeyScope)
    if (body.exposure !== undefined && !['localhost', 'lan', 'internet'].includes(body.exposure)) {
      throw Object.assign(new Error('Неизвестный режим сети'), { status: 400 })
    }
    if (body.settingsExposure !== undefined && !['localhost', 'lan', 'internet'].includes(body.settingsExposure)) {
      throw Object.assign(new Error('Неизвестный доступ к настройкам'), { status: 400 })
    }
    if (body.authMode !== undefined && !['required', 'optional'].includes(body.authMode)) {
      throw Object.assign(new Error('Неизвестный режим ключа'), { status: 400 })
    }
    if (body.apiKeyScope !== undefined && !API_KEY_SCOPES.includes(body.apiKeyScope)) {
      throw Object.assign(new Error('Неизвестный режим ключа API'), { status: 400 })
    }
    if (body.settingsKeyScope !== undefined && !['internet', 'lan'].includes(body.settingsKeyScope)) {
      throw Object.assign(new Error('Неизвестный режим ключа настроек'), { status: 400 })
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error('Порт должен быть числом от 1 до 65535'), { status: 400 })
    }
    const host = hostFor(widerExposure(exposure, settingsExposure))
    if (port !== runtime.port && !await portAvailable(port, host)) {
      throw Object.assign(new Error(`Порт ${port} уже занят`), { status: 409 })
    }
    const complexity = body.complexity === undefined ? undefined : normalizeComplexity(body.complexity, current.settings.complexity)
    const proxy = body.proxy === undefined ? undefined : normalizeProxySettings(body.proxy)
    const providerProxies = body.providerProxies === undefined ? undefined : normalizeProviderProxies(body.providerProxies)
    const apiKeys = resolveApiKeys(body, current.settings)
    const apiKey = apiKeys[0]?.key ?? ''
    let settingsKey = current.settings.settingsKey || ''
    if (body.regenerateSettingsKey) settingsKey = `set_${randomUUID().replaceAll('-', '')}`
    else if (typeof body.settingsKey === 'string' && body.settingsKey.trim()) settingsKey = body.settingsKey.trim()
    if (apiKeyScope !== 'none' && !apiKeys.length) {
      throw Object.assign(new Error('Укажите хотя бы один ключ API'), { status: 400 })
    }
    if (settingsKeyMustBeSet(settingsExposure, settingsKeyScope) && !settingsKey) {
      throw Object.assign(new Error('Укажите ключ для входа в настройки'), { status: 400 })
    }
    await store.update((state) => {
      state.settings.port = port
      state.settings.host = host
      state.settings.exposure = exposure
      state.settings.authMode = apiKeyScope === 'none' ? 'optional' : 'required'
      state.settings.apiKeyScope = apiKeyScope
      state.settings.apiKeys = apiKeys
      state.settings.settingsExposure = settingsExposure
      state.settings.settingsKey = settingsKey
      state.settings.settingsKeyScope = settingsKeyScope
      state.settings.remoteSettings = settingsExposure !== 'localhost'
      state.settings.apiKey = apiKey
      if (body.saveFullRequest !== undefined) state.settings.saveFullRequest = Boolean(body.saveFullRequest)
      if (body.updateCheck !== undefined) state.settings.updateCheck = Boolean(body.updateCheck)
      if (complexity) state.settings.complexity = complexity
      if (proxy) state.settings.proxy = proxy
      if (providerProxies) state.settings.providerProxies = providerProxies
    })
    runtime.configuredPort = port
    runtime.exposure = exposure
    runtime.settingsExposure = settingsExposure
    runtime.settingsKey = settingsKey
    runtime.settingsKeyScope = settingsKeyScope
    const urlAfter = `${originWithPort(request, port, runtime.port)}/`
    if (port !== runtime.port || host !== runtime.host) response.once('finish', () => hooks.rebind?.({ port, host, exposure }))
    const fresh = proxy || providerProxies ? await store.read() : current
    return send(response, 200, { port, host, exposure, authMode: apiKeyScope === 'none' ? 'optional' : 'required', apiKeyScope, apiKeys, settingsExposure, settingsKey, settingsKeyScope, apiKey, saveFullRequest: Boolean(current.settings.saveFullRequest || body.saveFullRequest), complexity: complexity ?? complexityOf(current.settings), proxy: fresh.settings.proxy, providerProxies: fresh.settings.providerProxies, url: urlAfter })
  }
  if (request.method === 'POST' && url.pathname === '/api/proxy/test') {
    const body = (await readJson(request)) ?? {}
    const urlToTest = body.url === undefined ? (await store.read()).settings.proxy?.url : normalizeProxyValue(body.url)
    if (!urlToTest) throw Object.assign(new Error('Укажите адрес прокси'), { status: 400 })
    return send(response, 200, await testProxy(urlToTest))
  }
  if (request.method === 'GET' && url.pathname === '/api/custom-providers') return send(response, 200, await service.customProviders())
  if (request.method === 'POST' && url.pathname === '/api/custom-providers/test') return send(response, 200, await service.testCustomProvider(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/api/custom-providers') return send(response, 200, await service.saveCustomProvider(await readJson(request)))
  const customProvider = /^\/api\/custom-providers\/([a-z0-9_-]+)$/.exec(url.pathname)
  if (customProvider && request.method === 'DELETE') return send(response, 200, await service.deleteCustomProvider(customProvider[1]))
  if (request.method === 'GET' && url.pathname === '/api/model-tiers') return send(response, 200, await service.modelTiers(request.signal))
  if (request.method === 'POST' && url.pathname === '/api/model-tiers') {
    const body = (await readJson(request)) ?? {}
    return send(response, 200, await service.setModelTiers(body.tiers, body.classifierModel))
  }
  if (request.method === 'GET' && url.pathname === '/api/pools') return send(response, 200, await service.pools())
  if (request.method === 'POST' && url.pathname === '/api/pools') return send(response, 200, await service.savePool(await readJson(request)))
  const pool = /^\/api\/pools\/([^/]+)$/.exec(url.pathname)
  if (pool && request.method === 'DELETE') return send(response, 200, await service.deletePool(decodeURIComponent(pool[1])))
  if (request.method === 'GET' && url.pathname === '/api/catalog') return send(response, 200, await service.catalog(request.signal, url.searchParams.get('refresh') === '1'))
  const providerState = /^\/api\/providers\/([a-z0-9_-]+)\/enabled$/.exec(url.pathname)
  if (providerState && request.method === 'POST') {
    const body = await readJson(request)
    return send(response, 200, await service.setProviderEnabled(providerState[1], body.enabled))
  }
  const models = /^\/api\/providers\/([a-z0-9_-]+)\/models$/.exec(url.pathname)
  if (models && request.method === 'GET') return send(response, 200, { data: await service.providerModels(models[1], request.signal, url.searchParams.get('refresh') === '1') })
  if (models && request.method === 'POST') return send(response, 200, await service.setProviderModels(models[1], (await readJson(request)).ids))
  if (request.method === 'GET' && url.pathname === '/api/requests/last') {
    const saved = await store.read()
    if (!saved.settings.saveFullRequest) return send(response, 404, { error: { message: 'Сохранение полного запроса выключено' } })
    const last = saved.lastExchange
    if (!last) return send(response, 404, { error: { message: 'Полный запрос ещё не сохранён' } })
    return send(response, 200, last)
  }
  if (request.method === 'GET' && url.pathname === '/api/usage') {
    return send(response, 200, await service.usageAll(request.signal, url.searchParams.get('refresh') === '1'))
  }
  const usage = /^\/api\/providers\/([a-z0-9_-]+)\/usage$/.exec(url.pathname)
  if (request.method === 'GET' && usage) return send(response, 200, await service.usage(usage[1], request.signal, url.searchParams.get('refresh') === '1'))
  const login = /^\/api\/providers\/([a-z0-9_-]+)\/login$/.exec(url.pathname)
  if (login && request.method === 'POST') return send(response, 200, await service.beginLogin(login[1], await readJson(request)))
  const complete = /^\/api\/providers\/([a-z0-9_-]+)\/complete$/.exec(url.pathname)
  if (complete && request.method === 'POST') return send(response, 200, await service.completeLogin(complete[1], await readJson(request)))
  const cancel = /^\/api\/providers\/([a-z0-9_-]+)\/cancel$/.exec(url.pathname)
  if (cancel && request.method === 'POST') {
    service.cancelLogin(cancel[1])
    return send(response, 200, { ok: true })
  }
  const account = /^\/api\/providers\/([a-z0-9_-]+)\/accounts\/([^/]+)$/.exec(url.pathname)
  if (account && request.method === 'DELETE') {
    await service.removeAccount(account[1], decodeURIComponent(account[2]))
    return send(response, 200, { ok: true })
  }
  if (account && request.method === 'POST') {
    await service.setDefault(account[1], decodeURIComponent(account[2]))
    return send(response, 200, { ok: true })
  }
  send(response, 404, { error: { message: 'Unknown admin endpoint' } })
}

async function handleOpenAI(service, store, url, request, response, onUnauthorized) {
  const state = await store.read()
  const auth = authorizeApi(request, state.settings)
  if (!auth.ok) {
    if (onUnauthorized) return onUnauthorized()
    response.setHeader('www-authenticate', 'Bearer')
    return send(response, 401, { error: { message: 'Invalid API key', type: 'authentication_error' } })
  }
  if (request.method === 'GET' && url.pathname === '/v1/model-tiers') return send(response, 200, await service.modelTiers(request.signal))
  if (request.method === 'GET' && url.pathname === '/v1/models') return send(response, 200, await service.models(request.signal, url.searchParams.get('capability')))
  if (request.method === 'POST' && url.pathname === '/v1/images/generations') return send(response, 200, await service.generateImage(await readJson(request), request.signal))
  if (request.method === 'POST' && url.pathname === '/v1/videos') return send(response, 202, await service.startVideo(await readJson(request), request.signal))
  const video = /^\/v1\/videos\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'GET' && video) return send(response, 200, await service.videoStatus(decodeURIComponent(video[1]), request.signal))
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const canonical = chatCompletionToCanonical(await readJson(request), request.headers)
    if (auth.label) canonical.keyLabel = auth.label
    const events = service.stream(canonical)
    if (canonical.stream) return writeChatStream(response, canonical.model, events)
    return send(response, 200, await collectChatCompletion(canonical.model, events))
  }
  send(response, 404, { error: { message: 'Unknown OpenAI endpoint', type: 'invalid_request_error' } })
}

function headerValue(value) {
  return String((Array.isArray(value) ? value[0] : value) ?? '').trim()
}

function parseHostHeader(raw) {
  const value = headerValue(raw).split(',')[0].trim()
  if (!value) return undefined
  try {
    const url = new URL(`http://${value}`)
    if (!url.hostname) return undefined
    const bare = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname
    return { bare, authority: url.host }
  } catch {
    return undefined
  }
}

/** Адрес, по которому клиент реально открыл страницу: localhost, адрес в сети или внешний. */
function originFor(request, fallbackPort) {
  const parsed = parseHostHeader(request.headers['x-forwarded-host']) ?? parseHostHeader(request.headers.host)
  if (!parsed) return `http://127.0.0.1:${fallbackPort}`
  const forwardedProto = headerValue(request.headers['x-forwarded-proto']).split(',')[0].trim().toLowerCase()
  const proto = forwardedProto === 'https' ? 'https' : 'http'
  return `${proto}://${parsed.authority}`
}

/** Тот же хост, но с другим портом — для перехода после смены порта. */
function originWithPort(request, port, currentPort) {
  const origin = originFor(request, currentPort)
  const parsed = parseHostHeader(request.headers['x-forwarded-host']) ?? parseHostHeader(request.headers.host)
  if (!parsed || port === currentPort) return origin
  const proto = origin.startsWith('https://') ? 'https' : 'http'
  return `${proto}://${parsed.bare}:${port}`
}

function portAvailable(port, host) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

function settingsForbiddenMessage(runtime) {
  const exposure = settingsExposureOf(runtime)
  if (exposure === 'lan') return 'Настройки доступны только из локальной сети'
  if (exposure === 'internet') return 'Настройки с этого адреса закрыты'
  return 'Настройки доступны только с этого компьютера'
}

function apiForbiddenMessage(exposure) {
  if (normalizeExposure(exposure) === 'localhost') return 'API доступен только с этого компьютера'
  return 'Доступ разрешён только из локальной сети'
}

function settingsAuthorized(request, runtime, url) {
  return keyMatches(runtime.settingsKey, presentedSettingsKey(request, url))
}

function presentedSettingsKey(request, url) {
  const header = request.headers['x-settings-key']
  const fromHeader = Array.isArray(header) ? header[0] : header
  if (fromHeader) return String(fromHeader)
  const fromQuery = url?.searchParams?.get('settings')
  if (fromQuery) return fromQuery
  return cookieValue(request, 'settings')
}

function cookieValue(request, name) {
  const raw = request.headers.cookie ?? ''
  for (const part of String(raw).split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

function rememberSettingsKey(response, url) {
  const query = url.searchParams.get('settings')
  if (!query) return
  response.setHeader('set-cookie', `settings=${encodeURIComponent(query)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`)
}

function keyMatches(expected, given) {
  if (!expected || !given) return false
  const left = createHash('sha256').update(String(expected)).digest()
  const right = createHash('sha256').update(String(given)).digest()
  return timingSafeEqual(left, right)
}

function staticPage(pathname) {
  if (pathname === '/') return 'index.html'
  if (pathname === '/app.js' || pathname === '/icon.png' || pathname === '/bootstrap.min.css') return pathname.slice(1)
  if (/^\/providers\/(?:antigravity|claude|codex|copilot|grok)\.png$/.test(pathname)) return pathname.slice(1)
  return ''
}

function isAdminPath(pathname) {
  return Boolean(staticPage(pathname)) || pathname.startsWith('/api/')
}

function authorizeApi(request, settings) {
  const presented = presentedApiKey(request)
  const match = presented ? apiKeysOf(settings).find((item) => keyMatches(item.key, presented)) : undefined
  if (!apiKeyRequired(request.socket.remoteAddress, apiKeyScopeOf(settings))) return { ok: true, label: match?.label ?? '' }
  return match ? { ok: true, label: match.label } : { ok: false, label: '' }
}

function presentedApiKey(request) {
  const header = request.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length)
  const apiKey = request.headers['x-api-key']
  return Array.isArray(apiKey) ? apiKey[0] : apiKey
}

/** @param {any} input */
function normalizeProxySettings(input) {
  if (!input || typeof input !== 'object') throw Object.assign(new Error('proxy: ожидается объект'), { status: 400 })
  const enabled = Boolean(input.enabled)
  const url = String(input.url ?? '').trim()
  if (enabled && !url) throw Object.assign(new Error('Включите прокси только с адресом'), { status: 400 })
  return { enabled, url: url ? normalizeProxyValue(url) : '' }
}

/** @param {any} input */
function normalizeProviderProxies(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('providerProxies: ожидается объект'), { status: 400 })
  const result = {}
  for (const [id, value] of Object.entries(input)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(id)) throw Object.assign(new Error(`Некорректный провайдер в прокси: ${id}`), { status: 400 })
    const normalized = normalizeProxyValue(value)
    if (normalized && normalized !== DIRECT) result[id] = normalized
    else if (normalized === DIRECT) result[id] = DIRECT
  }
  return result
}

function resolveApiKeyScope(body, settings) {
  if (body.apiKeyScope !== undefined) return API_KEY_SCOPES.includes(body.apiKeyScope) ? body.apiKeyScope : apiKeyScopeOf(settings)
  if (body.authMode !== undefined) return body.authMode === 'optional' ? 'none' : 'localhost'
  return apiKeyScopeOf(settings)
}

function resolveApiKeys(body, settings) {
  if (Array.isArray(body.apiKeys)) return normalizeApiKeys(body.apiKeys)
  const keys = apiKeysOf(settings).map((item) => ({ ...item, id: item.id || randomUUID() }))
  if (body.regenerateKey) {
    const key = `sta_${randomUUID().replaceAll('-', '')}`
    if (keys[0]) keys[0] = { ...keys[0], key }
    else keys.push({ id: randomUUID(), label: 'Основной', key })
  } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    const key = body.apiKey.trim()
    if (keys[0]) keys[0] = { ...keys[0], key }
    else keys.push({ id: randomUUID(), label: 'Основной', key })
  }
  return keys
}

function normalizeApiKeys(input) {
  if (input.length > 30) throw Object.assign(new Error('Ключей API не больше 30'), { status: 400 })
  const keys = []
  for (const item of input) {
    const label = String(item?.label ?? '').trim()
    const key = String(item?.key ?? '').trim()
    if (!label) throw Object.assign(new Error('У каждого ключа нужна подпись'), { status: 400 })
    if (!key) throw Object.assign(new Error('У каждого ключа нужно значение'), { status: 400 })
    if (label.length > 80) throw Object.assign(new Error('Подпись ключа не длиннее 80 символов'), { status: 400 })
    if (key.length > 200) throw Object.assign(new Error('Ключ не длиннее 200 символов'), { status: 400 })
    if (keys.some((entry) => entry.key === key)) throw Object.assign(new Error('Ключи не должны повторяться'), { status: 400 })
    const id = /^[A-Za-z0-9_-]{1,40}$/.test(String(item?.id ?? '')) ? String(item.id) : randomUUID()
    keys.push({ id, label, key })
  }
  return keys
}

async function serveStatic(name, response) {
  const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8'
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  const bytes = isSea() ? Buffer.from(getAsset(name)) : await readFile(assetPath(name))
  response.end(name.endsWith('.png') ? bytes : bytes.toString('utf8'))
}

function assetPath(name) {
  return join(dirname(fileURLToPath(import.meta.url)), '../../web', name)
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 20_000_000) reject(Object.assign(new Error('Request too large'), { status: 413 }))
    })
    request.on('end', () => {
      if (!body) return resolve({})
      try { resolve(JSON.parse(body)) } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })) }
    })
    request.on('error', reject)
  })
}

function send(response, status, payload) {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}
