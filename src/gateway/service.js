import { randomUUID } from 'node:crypto'
import { apiKeyScopeOf, apiKeysOf, normalizeSettingsKeyScope, settingsExposureOf } from '../network.js'
import { chooseMember, estimateTokens, fitsContext, normalizePool, remainingPercent } from '../pools.js'
import { priceEstimate, requestCost } from '../pricing.js'
import { buildStats, recordUsage } from '../stats.js'
import { LAST_REQUEST_PATH } from '../storage/store.js'
import { writeFile } from 'node:fs/promises'

export class GatewayService {
  /**
   * @param {import('../storage/store.js').Store} store
   * @param {import('./registry.js').ProviderRegistry} registry
   */
  constructor(store, registry) {
    this.store = store
    this.registry = registry
    this.active = new Map()
    this.usageCache = new Map()
    this.modelCache = new Map()
    this.poolSticky = new Map()
    this.poolCooldown = new Map()
  }

  async overview() {
    const state = await this.store.read()
    const providers = []
    for (const adapter of this.registry.list()) {
      const accounts = await adapter.listAccounts().catch((error) => [{ key: 'error', label: error.message, isDefault: false }])
      providers.push({
        id: adapter.id,
        label: adapter.label,
        loginKind: adapter.loginKind,
        clientId: adapter.id === 'antigravity' ? state.settings.antigravityClientId : undefined,
        accounts,
      })
    }
    return {
      settings: {
        host: state.settings.host,
        port: state.settings.port,
        exposure: state.settings.exposure || 'localhost',
        authMode: state.settings.authMode || 'required',
        apiKeyScope: apiKeyScopeOf(state.settings),
        apiKeys: apiKeysOf(state.settings),
        settingsExposure: settingsExposureOf(state.settings),
        settingsKey: state.settings.settingsKey || '',
        settingsKeyScope: normalizeSettingsKeyScope(state.settings.settingsKeyScope),
        apiKey: state.settings.apiKey,
        apiKeyPreview: mask(state.settings.apiKey),
        saveFullRequest: Boolean(state.settings.saveFullRequest),
      },
      providers,
      activeRequests: this.active.size,
      requests: loggedRequests(state),
    }
  }

  async journal() {
    return { requests: loggedRequests(await this.store.read()) }
  }

  async stats(signal, key) {
    const state = await this.store.read()
    const usage = await this.usageAll(signal, false).catch(() => ({ providers: [] }))
    return buildStats(state.usageStats, usage.providers ?? [], { key })
  }

  /** @param {string} provider @param {any} input */
  beginLogin(provider, input) {
    return this.registry.get(provider).beginLogin(input ?? {})
  }

  /** @param {string} provider @param {any} input */
  completeLogin(provider, input) {
    return this.registry.get(provider).completeLogin(input ?? {})
  }

  /** @param {string} provider */
  cancelLogin(provider) {
    this.registry.get(provider).cancelLogin()
  }

  /** @param {string} provider @param {string} key */
  removeAccount(provider, key) {
    return this.registry.get(provider).removeAccount(key)
  }

  /** @param {string} provider @param {string} key */
  setDefault(provider, key) {
    return this.registry.get(provider).setDefaultAccount(key)
  }

  /** @param {string} provider @param {AbortSignal} [signal] @param {boolean} [refresh] */
  usage(provider, signal, refresh = false) {
    const adapter = this.registry.get(provider)
    const now = Date.now()
    const cached = this.usageCache.get(provider)
    if (refresh && cached) cached.at = 0
    const freshFor = cached?.snapshot && !cached.snapshot.error ? USAGE_FRESH_MS : USAGE_ERROR_MS
    if (cached?.snapshot && now - cached.at < freshFor) return cached.snapshot
    if (cached?.pending) return cached.pending
    const pending = adapter.usage(undefined, signal).then((snapshot) => {
      const current = this.usageCache.get(provider)
      const previous = current?.snapshot && !current.snapshot.error ? current.snapshot : undefined
      const keep = snapshot?.error && previous ? previous : snapshot
      const at = snapshot?.error && previous ? (current.at || Date.now()) : Date.now()
      if (current?.pending === pending) this.usageCache.set(provider, { snapshot: keep, at })
      return keep
    }, (error) => {
      const current = this.usageCache.get(provider)
      if (current?.pending === pending) this.usageCache.set(provider, { snapshot: current.snapshot, at: current.at })
      if (current?.snapshot && !current.snapshot.error && now - current.at < USAGE_STALE_MS) return current.snapshot
      throw error
    })
    this.usageCache.set(provider, { snapshot: cached?.snapshot, at: cached?.at ?? 0, pending })
    return pending
  }

  /** @param {AbortSignal} [signal] @param {boolean} [refresh] */
  async usageAll(signal, refresh = false) {
    const providers = []
    for (const adapter of this.registry.list()) {
      const accounts = await adapter.listAccounts().catch((error) => [{ key: 'error', label: error.message, isDefault: false }])
      if (!accounts.length) continue
      let usage
      let error = ''
      try {
        usage = await this.usage(adapter.id, signal, refresh)
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
      providers.push({
        id: adapter.id,
        label: adapter.label,
        accounts,
        ...(usage ? { usage } : {}),
        ...(error ? { error } : {}),
      })
    }
    return { providers, fetchedAt: Date.now() }
  }

  /** @param {string} providerId @param {AbortSignal} [signal] @param {boolean} [refresh] */
  async providerModels(providerId, signal, refresh = false) {
    const discovered = await this.#cachedModels(providerId, 'chat', signal, refresh)
    const enabled = (await this.store.read()).settings.enabledModels?.[providerId]
    return discovered.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      description: model.description || '',
      enabled: !Array.isArray(enabled) || enabled.includes(model.id),
    }))
  }

  /** @param {AbortSignal} [signal] @param {boolean} [refresh] */
  async catalog(signal, refresh = false) {
    const rows = []
    for (const adapter of this.registry.list()) {
      const enabled = (await this.store.read()).settings.enabledModels?.[adapter.id]
      for (const model of await this.#cachedModels(adapter.id, 'chat', signal, refresh)) {
        rows.push(catalogRow(adapter, model, 'chat', !Array.isArray(enabled) || enabled.includes(model.id)))
      }
      if (typeof adapter.listMediaModels !== 'function') continue
      for (const model of await this.#cachedModels(adapter.id, 'media', signal, refresh)) {
        rows.push(catalogRow(adapter, model, model.capability || 'image', true))
      }
    }
    return { data: rows }
  }

  /** @param {string} providerId @param {'chat' | 'media'} kind @param {AbortSignal} [signal] @param {boolean} [refresh] */
  #cachedModels(providerId, kind, signal, refresh = false) {
    const key = `${providerId}:${kind}`
    const now = Date.now()
    const cached = this.modelCache.get(key)
    if (refresh && cached) cached.at = 0
    const freshFor = cached?.models ? MODEL_FRESH_MS : USAGE_ERROR_MS
    if (cached?.models && now - cached.at < freshFor) return Promise.resolve(cached.models)
    if (cached?.pending) return cached.pending
    const adapter = this.registry.get(providerId)
    const load = kind === 'media' ? adapter.listMediaModels(signal) : adapter.listModels(undefined, signal)
    const pending = Promise.resolve(load).then((models) => {
      const value = Array.isArray(models) ? models : []
      const current = this.modelCache.get(key)
      if (current?.pending === pending) this.modelCache.set(key, { models: value, at: Date.now() })
      return value
    }, (error) => {
      const current = this.modelCache.get(key)
      if (current?.pending === pending) this.modelCache.set(key, { models: current.models, at: current.at })
      if (current?.models && now - current.at < USAGE_STALE_MS) return current.models
      if (kind === 'media') return []
      throw error
    })
    this.modelCache.set(key, { models: cached?.models, at: cached?.at ?? 0, pending })
    return pending
  }

  async setProviderModels(providerId, ids) {
    this.registry.get(providerId)
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
      throw Object.assign(new Error('Список моделей некорректен'), { status: 400 })
    }
    await this.store.update((state) => {
      state.settings.enabledModels ??= {}
      state.settings.enabledModels[providerId] = [...new Set(ids)]
    })
    return { ok: true }
  }

  /** @param {AbortSignal} [signal] @param {string} [capability] */
  async models(signal, capability) {
    if (capability === 'image' || capability === 'video') return this.#mediaModels(signal, capability)
    if (capability) throw Object.assign(new Error('capability должен быть image или video'), { status: 400 })
    const models = []
    const state = await this.store.read()
    for (const pool of state.pools ?? []) {
      models.push({ id: `pool/${pool.id}`, object: 'model', owned_by: 'pool', name: pool.id, description: pool.members.join(', ') })
    }
    const enabledModels = state.settings.enabledModels ?? {}
    for (const adapter of this.registry.list()) {
      const discovered = await this.#cachedModels(adapter.id, 'chat', signal).catch(() => [])
      const enabled = enabledModels[adapter.id]
      for (const model of discovered) {
        if (Array.isArray(enabled) && !enabled.includes(model.id)) continue
        models.push({
          id: `${adapter.id}/${model.id}`,
          object: 'model',
          owned_by: adapter.id,
          name: model.name,
          description: model.description || undefined,
          context_window: model.contextWindow,
        })
      }
    }
    return { object: 'list', data: models }
  }

  async #mediaModels(signal, capability) {
    const models = []
    for (const adapter of this.registry.list()) {
      if (typeof adapter.listMediaModels !== 'function') continue
      const discovered = await this.#cachedModels(adapter.id, 'media', signal).catch(() => [])
      for (const model of discovered) {
        if (model.capability !== capability) continue
        models.push({ id: `${adapter.id}/${model.id}`, object: 'model', owned_by: adapter.id, name: model.name, capability })
      }
    }
    return { object: 'list', data: models }
  }

  async generateImage(body, signal) {
    const prompt = String(body?.prompt ?? '').trim()
    if (!prompt) throw Object.assign(new Error('Нужен непустой prompt'), { status: 400 })
    const requested = String(body.model ?? '')
    const providerId = body.provider === 'grok' || requested.startsWith('grok/') || requested.startsWith('grok-') ? 'grok' : 'codex'
    const provider = this.registry.get(providerId)
    if (typeof provider.generateImage !== 'function') throw Object.assign(new Error('Провайдер не генерирует изображения'), { status: 400 })
    const model = requested.includes('/') ? requested.slice(requested.indexOf('/') + 1) : requested
    const payload = await provider.generateImage({ prompt, model, size: body.size, quality: body.quality }, signal)
    return { created: Math.floor(Date.now() / 1000), provider: providerId, data: payload.data ?? [] }
  }

  async startVideo(body, signal) {
    const prompt = String(body?.prompt ?? '').trim()
    if (!prompt) throw Object.assign(new Error('Нужен непустой prompt'), { status: 400 })
    if (body.duration !== undefined && (!Number.isInteger(body.duration) || body.duration < 1 || body.duration > 15)) {
      throw Object.assign(new Error('duration должен быть от 1 до 15 секунд'), { status: 400 })
    }
    const requested = String(body.model ?? '')
    const payload = await this.registry.get('grok').startVideo({
      prompt, model: requested.includes('/') ? requested.slice(requested.indexOf('/') + 1) : requested, duration: body.duration, aspectRatio: body.aspect_ratio, resolution: body.resolution, imageUrl: body.image_url,
    }, signal)
    if (!payload.request_id) throw Object.assign(new Error('Grok не вернул request_id'), { status: 502 })
    return { id: payload.request_id, object: 'video', status: 'queued', provider: 'grok' }
  }

  videoStatus(id, signal) {
    return this.registry.get('grok').videoStatus(id, signal)
  }

  async pools() {
    return { data: (await this.store.read()).pools ?? [] }
  }

  async savePool(input) {
    const pool = normalizePool(input)
    await this.store.update((state) => {
      const pools = [...(state.pools ?? [])]
      const index = pools.findIndex((item) => item.id === pool.id)
      if (index === -1) pools.push(pool)
      else pools[index] = pool
      state.pools = pools
    })
    return pool
  }

  async deletePool(id) {
    await this.store.update((state) => {
      state.pools = (state.pools ?? []).filter((item) => item.id !== id)
    })
    return { ok: true }
  }

  /** @param {import('../providers/types.js').CanonicalRequest} request */
  stream(request) {
    const started = Date.now()
    const id = randomUUID()
    return this.#tracked(id, request, started)
  }

  async #route(request) {
    if (!request.model.startsWith('pool/')) {
      const route = this.registry.resolve(request.model)
      const enabled = (await this.store.read()).settings.enabledModels?.[route.adapter.id]
      if (Array.isArray(enabled) && !enabled.includes(route.model)) {
        throw Object.assign(new Error('Модель отключена в настройках'), { status: 404, code: 'model_disabled' })
      }
      return [route]
    }
    const pool = ((await this.store.read()).pools ?? []).find((item) => item.id === request.model.slice(5))
    if (!pool) throw Object.assign(new Error('Пул не найден'), { status: 404 })
    const remaining = new Map()
    const windows = new Map()
    const tokens = estimateTokens(request)
    for (const member of pool.members) {
      const providerId = member.slice(0, member.indexOf('/'))
      const snapshot = await Promise.resolve(this.usage(providerId)).catch(() => undefined)
      remaining.set(member, remainingPercent(snapshot))
      const models = await this.#cachedModels(providerId, 'chat').catch(() => [])
      const info = models.find((model) => model.id === member.slice(providerId.length + 1))
      windows.set(member, Number(info?.contextWindow) || 0)
    }
    const fits = (member) => fitsContext(windows.get(member), tokens)
    const stickyKey = request.promptCacheKey ? `${pool.id}:${request.promptCacheKey}` : ''
    const available = (member) => {
      if (!fits(member) || this.#cooled(member)) return 0
      return remaining.get(member)
    }
    const chosen = chooseMember({
      members: pool.members,
      strategy: pool.strategy,
      sticky: stickyKey ? this.poolSticky.get(stickyKey) : undefined,
      remaining: available,
    })
    const open = (member) => {
      const left = available(member)
      return left === null || left > 5
    }
    const fitting = pool.members.filter(fits)
    if (!fitting.length) throw Object.assign(new Error('Текущий контекст не влезает ни в одну модель пула'), { status: 400, code: 'context_length_exceeded' })
    let members = fitting.filter((member) => member === chosen || open(member))
    if (!members.length) {
      members = fitting.filter((member) => {
        const left = remaining.get(member)
        return left === null || left > 5
      })
    }
    if (!members.length) throw Object.assign(new Error('Во всех моделях пула лимит почти исчерпан'), { status: 429 })
    if (chosen) members = [chosen, ...members.filter((member) => member !== chosen)]
    if (pool.strategy !== 'first-available') {
      const [first, ...rest] = members
      rest.sort((a, b) => (available(b) ?? 100) - (available(a) ?? 100))
      members = [first, ...rest]
    }
    request.poolStickyKey = stickyKey
    return members.map((member) => this.registry.resolve(member))
  }

  #cooled(member) {
    return (this.poolCooldown.get(member) ?? 0) > Date.now()
  }

  async *#tracked(id, request, started) {
    let routes
    try {
      routes = await this.#route(request)
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      yield { type: 'error', text: error.message, status: error.status ?? 400, code: error.code }
      return
    }
    const pool = request.model.startsWith('pool/')
    for (let index = 0; index < routes.length; index++) {
      const route = routes[index]
      if (pool) request.routedModel = route.publicModel
      this.active.set(id, { provider: route.adapter.id, model: request.routedModel ?? route.publicModel, started })
      let status = 'ok'
      let error = ''
      let usage
      const answer = []
      const held = []
      let visible = false
      let failure = null
      try {
        for await (const event of route.adapter.stream({ ...request, model: route.model })) {
          if (event.type === 'error') {
            status = 'error'
            error = event.text ?? 'Provider error'
            failure = event
            break
          }
          if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool_call') visible = true
          else if (event.type === 'usage') usage = event
          if (event.type === 'text' && event.text) answer.push(event.text)
          held.push(event)
        }
      } catch (caught) {
        status = 'error'
        error = caught instanceof Error ? caught.message : String(caught)
        failure = { type: 'error', text: error, status: caught.status ?? 502, code: caught.code ?? 'provider_error' }
      } finally {
        this.active.delete(id)
        if (request.poolStickyKey) {
          if (status === 'ok') this.poolSticky.set(request.poolStickyKey, request.routedModel)
          else this.poolSticky.delete(request.poolStickyKey)
        }
        await this.#record(id, request, started, route, status, error, usage, answer)
      }
      const retry = pool && failure && !visible && index < routes.length - 1 && !request.signal?.aborted && failure.status !== 499 && failure.code !== 'aborted'
      if (!failure) {
        yield* held
        return
      }
      if (!retry) {
        yield* held
        yield failure
        return
      }
      this.poolCooldown.set(route.publicModel, Date.now() + POOL_COOLDOWN_MS)
    }
  }

  async #record(id, request, started, route, status, error, usage, answer) {
    const inputTokens = usage?.inputTokens
    const outputTokens = usage?.outputTokens
    const cacheReadTokens = usage?.cacheReadTokens ?? 0
    const cacheWriteTokens = usage?.cacheWriteTokens ?? 0
    const cost = requestCost(route.publicModel, { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens })
    await this.store.update(async (state) => {
      state.requests.unshift({
        id,
        provider: route.adapter.id,
        model: request.routedModel ? `${request.model} → ${route.publicModel}` : route.publicModel,
        started,
        durationMs: Date.now() - started,
        status,
        ...(request.keyLabel ? { keyLabel: request.keyLabel } : {}),
        ...(error ? { error: error.slice(0, 300) } : {}),
        request: clip(request.messages.map(messageText).filter(Boolean).join('\n\n')),
        response: clip(answer.join('')),
        ...(Number.isFinite(inputTokens) ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } : {}),
        ...(cost ? { cost: cost.label } : {}),
      })
      if (state.settings.saveFullRequest) {
        const requestText = request.messages.map(messageText).filter(Boolean).join('\n\n')
        const responseText = answer.join('')
        state.lastExchange = { id, request: requestText, response: responseText }
        await writeFile(LAST_REQUEST_PATH, `id: ${id}\nmodel: ${route.publicModel}\nstatus: ${status}\n\n===== ЗАПРОС =====\n${requestText}\n\n===== ОТВЕТ =====\n${responseText}\n`, 'utf8')
      } else delete state.lastExchange
      state.requests = state.requests.slice(0, state.settings.requestLogLimit ?? 200)
      state.usageStats = recordUsage(state.usageStats, {
        model: route.publicModel,
        provider: route.adapter.id,
        keyLabel: request.keyLabel || '',
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
      })
    }).catch(() => undefined)
  }
}

function loggedRequests(state) {
  const fullId = state.settings.saveFullRequest ? state.lastExchange?.id : undefined
  return state.requests.slice(0, 50).map((item) => ({ ...item, hasFull: item.id === fullId }))
}

const POOL_COOLDOWN_MS = 2 * 60 * 1000

const USAGE_FRESH_MS = 5 * 60 * 1000
const MODEL_FRESH_MS = USAGE_FRESH_MS
const USAGE_ERROR_MS = 60 * 1000
const USAGE_STALE_MS = 60 * 60 * 1000

function catalogRow(adapter, model, capability, enabled) {
  return {
    id: `${adapter.id}/${model.id}`,
    name: model.name || model.id,
    provider: adapter.label,
    capability,
    enabled,
    ...(model.description ? { description: model.description } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
    ...(model.supportsTools !== undefined ? { supportsTools: model.supportsTools } : {}),
    ...(model.efforts?.length ? { efforts: model.efforts } : {}),
    ...priceFields(`${adapter.id}/${model.id}`),
  }
}

function messageText(message) {
  const calls = message.toolCalls?.map((call) => `${call.name}(${call.arguments})`).join('\n') ?? ''
  return [`${message.role}: ${message.content ?? ''}`, calls].filter(Boolean).join('\n')
}

function clip(value) {
  return value.length > 4000 ? `${value.slice(0, 4000)}…` : value
}

function priceFields(id) {
  const price = priceEstimate(id)
  return price ? { price } : {}
}

function mask(value) {
  if (!value) return ''
  return `${value.slice(0, 7)}…${value.slice(-4)}`
}
