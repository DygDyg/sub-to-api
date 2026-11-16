import { randomUUID } from 'node:crypto'
import { apiKeyScopeOf, apiKeysOf, normalizeSettingsKeyScope, settingsExposureOf } from '../network.js'
import { chooseMember, estimateTokens, fitsContext, normalizePool, remainingPercent } from '../pools.js'
import { CLASSIFIER_PROMPT, TIERS, TIERS_GUIDE, TIER_INFO, classifyHeuristic, complexityOf, enabledClassifiers, normalizeComplexity, lastUserText, normalizeTier, parseTier, tierOf, tierOrder } from '../complexity.js'
import { priceEstimate, requestCost } from '../pricing.js'
import { buildStats, recordUsage } from '../stats.js'
import { LAST_REQUEST_PATH } from '../storage/store.js'
import { writeFile } from 'node:fs/promises'
import { CustomApiProvider, normalizeCustomProvider, publicCustomProvider } from '../providers/custom.js'
import { detectCustomUsage } from '../providers/custom-usage.js'
import { fetchVia, proxyFor } from '../proxy.js'

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

  /** Пересоздаёт свои API-провайдеры из настроек. */
  async reloadCustom() {
    const state = await this.store.read()
    const before = new Set(this.registry.custom.keys())
    const adapters = []
    for (const raw of state.settings.customProviders ?? []) {
      try {
        adapters.push(new CustomApiProvider(this.store, normalizeCustomProvider(raw, raw)))
      } catch { /* битая запись не должна ронять запуск */ }
    }
    this.registry.setCustom(adapters)
    for (const id of new Set([...before, ...adapters.map((adapter) => adapter.id)])) {
      this.modelCache.delete(`${id}:chat`)
      this.modelCache.delete(`${id}:media`)
      this.usageCache.delete(id)
    }
  }

  async customProviders() {
    const state = await this.store.read()
    return { data: (state.settings.customProviders ?? []).map(publicCustomProvider) }
  }

  /** @param {any} input */
  async saveCustomProvider(input) {
    const current = await this.store.read()
    const original = String(input?.originalId ?? input?.id ?? '').trim().toLowerCase()
    const previous = (current.settings.customProviders ?? []).find((item) => item.id === original)
    const config = normalizeCustomProvider(input, previous)
    if (!config.usageMode) {
      const adapter = this.#customAdapter(current.settings, config, input?.proxy)
      config.usageMode = (await detectCustomUsage(adapter, AbortSignal.timeout(10_000))).mode
    }
    let saved
    await this.store.update((state) => {
      const list = [...(state.settings.customProviders ?? [])]
      const index = list.findIndex((item) => item.id === original)
      if (list.some((item, at) => item.id === config.id && at !== index)) throw Object.assign(new Error(`Провайдер «${config.id}» уже есть`), { status: 409 })
      if (index >= 0) list[index] = config
      else list.push(config)
      if (index >= 0 && original !== config.id) renameProviderRefs(state.settings, original, config.id)
      state.settings.customProviders = list
      saved = config
    })
    await this.reloadCustom()
    return publicCustomProvider(saved)
  }

  /** @param {string} id */
  async deleteCustomProvider(id) {
    await this.store.update((state) => {
      state.settings.customProviders = (state.settings.customProviders ?? []).filter((item) => item.id !== id)
      if (state.settings.providerProxies) delete state.settings.providerProxies[id]
      if (state.settings.enabledModels) delete state.settings.enabledModels[id]
    })
    await this.reloadCustom()
    return { ok: true }
  }

  #customAdapter(settings, config, proxy) {
    const providerProxies = { ...settings.providerProxies, [config.id]: proxy ?? settings.providerProxies?.[config.id] ?? '' }
    return new CustomApiProvider(this.store, config, { fetch: (url, init) => fetchVia(proxyFor({ ...settings, providerProxies }, config.id), url, init) })
  }

  /** Проверка своего провайдера: модели и автоопределение квоты без сохранения. @param {any} input */
  async testCustomProvider(input) {
    const state = await this.store.read()
    const previous = (state.settings.customProviders ?? []).find((item) => item.id === String(input?.originalId ?? input?.id ?? '').trim().toLowerCase())
    const config = normalizeCustomProvider(input, previous)
    const adapter = this.#customAdapter(state.settings, config, input?.proxy)
    const started = Date.now()
    const [modelsResult, usageResult] = await Promise.allSettled([
      adapter.discoverModels(AbortSignal.timeout(20_000)),
      detectCustomUsage(adapter, AbortSignal.timeout(10_000)),
    ])
    const detected = usageResult.status === 'fulfilled' ? usageResult.value : { mode: '', label: '', snapshot: { supported: false, windows: [] } }
    if (modelsResult.status === 'rejected') {
      return { ok: false, error: modelsResult.reason?.message ?? String(modelsResult.reason), usageMode: detected.mode, usageLabel: detected.label, usage: detected.snapshot, ms: Date.now() - started }
    }
    const models = modelsResult.value
    return { ok: true, count: models.length, models: models.slice(0, 50).map((model) => model.id), usageMode: detected.mode, usageLabel: detected.label, usage: detected.snapshot, ms: Date.now() - started }
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
        ...(adapter.custom ? { custom: true, protocol: adapter.protocol } : {}),
        enabled: providerEnabled(state.settings, adapter.id),
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
        updateCheck: state.settings.updateCheck !== false,
        complexity: complexityOf(state.settings),
        classifiers: enabledClassifiers(state.settings),
        proxy: state.settings.proxy ?? { enabled: false, url: '' },
        providerProxies: state.settings.providerProxies ?? {},
      },
      providerIds: this.registry.ids(),
      customProviders: (state.settings.customProviders ?? []).map(publicCustomProvider),
      providers,
      activeRequests: this.active.size,
      requests: loggedRequests(state),
    }
  }

  /** Включает или выключает провайдера, не удаляя аккаунты и настройки. */
  async setProviderEnabled(providerId, enabled) {
    this.registry.get(providerId)
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled должен быть true или false'), { status: 400 })
    const state = await this.store.update((current) => {
      const disabled = new Set(current.settings.disabledProviders ?? [])
      if (enabled) disabled.delete(providerId)
      else disabled.add(providerId)
      current.settings.disabledProviders = [...disabled]
      const custom = (current.settings.customProviders ?? []).find((item) => item.id === providerId)
      if (custom) custom.enabled = enabled
    })
    if (!enabled) {
      this.usageCache.delete(providerId)
      this.poolSticky.forEach((member, key) => {
        if (member.startsWith(`${providerId}/`)) this.poolSticky.delete(key)
      })
    }
    return { id: providerId, enabled: providerEnabled(state.settings, providerId) }
  }

  async journal() {
    return { requests: loggedRequests(await this.store.read()) }
  }

  async stats(signal, key) {
    const state = await this.store.read()
    const usage = await this.usageAll(signal, false).catch(() => ({ providers: [] }))
    return buildStats(state.usageStats, usage.providers ?? [], { key })
  }

  async #enabledAdapter(providerId) {
    const adapter = this.registry.get(providerId)
    const settings = (await this.store.read()).settings
    if (!providerEnabled(settings, providerId)) {
      throw Object.assign(new Error(`Провайдер «${adapter.label}» отключён`), { status: 404, code: 'provider_disabled' })
    }
    return adapter
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
    const settings = typeof this.store.read === 'function' ? (await this.store.read()).settings : {}
    for (const adapter of this.registry.list()) {
      if (!providerEnabled(settings, adapter.id)) continue
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
    const settings = (await this.store.read()).settings
    const tiers = settings.modelTiers ?? {}
    for (const adapter of this.registry.list()) {
      if (!providerEnabled(settings, adapter.id)) continue
      const enabled = settings.enabledModels?.[adapter.id]
      const discovered = await this.#cachedModels(adapter.id, 'chat', signal, refresh).catch(() => [])
      for (const model of discovered) {
        const row = catalogRow(adapter, model, 'chat', !Array.isArray(enabled) || enabled.includes(model.id))
        const tier = normalizeTier(tiers[row.id])
        rows.push(tier ? { ...row, tier } : row)
      }
      if (typeof adapter.listMediaModels !== 'function') continue
      for (const model of await this.#cachedModels(adapter.id, 'media', signal, refresh).catch(() => [])) {
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
      if (!pool.members.some((member) => providerEnabled(state.settings, member.split('/', 1)[0]))) continue
      models.push({ id: `pool/${pool.id}`, object: 'model', owned_by: 'pool', name: pool.id, description: pool.members.join(', ') })
    }
    const enabledModels = state.settings.enabledModels ?? {}
    for (const adapter of this.registry.list()) {
      if (!providerEnabled(state.settings, adapter.id)) continue
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
    const settings = (await this.store.read()).settings
    for (const adapter of this.registry.list()) {
      if (!providerEnabled(settings, adapter.id)) continue
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
    const provider = await this.#enabledAdapter(providerId)
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
    const provider = await this.#enabledAdapter('grok')
    const payload = await provider.startVideo({
      prompt, model: requested.includes('/') ? requested.slice(requested.indexOf('/') + 1) : requested, duration: body.duration, aspectRatio: body.aspect_ratio, resolution: body.resolution, imageUrl: body.image_url,
    }, signal)
    if (!payload.request_id) throw Object.assign(new Error('Grok не вернул request_id'), { status: 502 })
    return { id: payload.request_id, object: 'video', status: 'queued', provider: 'grok' }
  }

  async videoStatus(id, signal) {
    return (await this.#enabledAdapter('grok')).videoStatus(id, signal)
  }

  /** Чат-модели с уровнями сложности и инструкция для ИИ. @param {AbortSignal} [signal] */
  async modelTiers(signal) {
    const state = await this.store.read()
    const tiers = state.settings.modelTiers ?? {}
    const models = []
    for (const adapter of this.registry.list()) {
      if (!providerEnabled(state.settings, adapter.id)) continue
      const enabled = state.settings.enabledModels?.[adapter.id]
      const discovered = await this.#cachedModels(adapter.id, 'chat', signal).catch(() => [])
      for (const model of discovered) {
        const id = `${adapter.id}/${model.id}`
        const set = normalizeTier(tiers[id])
        models.push({
          id,
          name: model.name || model.id,
          provider: adapter.id,
          enabled: !Array.isArray(enabled) || enabled.includes(model.id),
          tier: set ?? 'medium',
          tierSet: Boolean(set),
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          ...(model.efforts?.length ? { efforts: model.efforts } : {}),
          ...(model.supportsTools !== undefined ? { supportsTools: model.supportsTools } : {}),
          ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
          ...priceFields(id),
        })
      }
    }
    return {
      instructions: TIERS_GUIDE,
      tiers: TIER_INFO,
      assigned: Object.fromEntries(Object.entries(tiers).filter(([, value]) => normalizeTier(value))),
      complexity: { ...complexityOf(state.settings), classifiers: enabledClassifiers(state.settings) },
      models,
    }
  }

  /**
   * @param {Record<string, string | null>} map
   * @param {string} [classifierModel] модель LLM-классификатора; задаёт её и включает классификатор
   */
  async setModelTiers(map, classifierModel) {
    if (map === undefined && classifierModel) map = {}
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw Object.assign(new Error('Ожидается {"tiers": {"provider/model": "light|medium|heavy|null"}}'), { status: 400 })
    }
    if (classifierModel !== undefined && classifierModel !== null && typeof classifierModel !== 'string') {
      throw Object.assign(new Error('classifierModel — строка вида provider/model'), { status: 400 })
    }
    const entries = Object.entries(map)
    if (entries.length > 2000) throw Object.assign(new Error('Слишком много моделей в одном запросе'), { status: 400 })
    for (const [id, value] of entries) {
      if (!/^[a-z0-9_-]+\/\S+$/.test(id) || id.length > 200) throw Object.assign(new Error(`Некорректный id модели: ${id}`), { status: 400 })
      if (value !== null && !normalizeTier(value)) throw Object.assign(new Error(`Уровень для ${id}: light, medium, heavy или null`), { status: 400 })
    }
    const model = classifierModel?.trim()
    if (model) this.registry.resolve(model)
    const state = await this.store.update((current) => {
      const tiers = { ...(current.settings.modelTiers ?? {}) }
      for (const [id, value] of entries) {
        if (value === null) delete tiers[id]
        else tiers[id] = normalizeTier(value)
      }
      current.settings.modelTiers = tiers
      if (model) current.settings.complexity = normalizeComplexity({ llm: { enabled: true, model } }, current.settings.complexity)
    })
    return { ok: true, tiers: state.settings.modelTiers, complexity: { ...complexityOf(state.settings), classifiers: enabledClassifiers(state.settings) } }
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
      const settings = (await this.store.read()).settings
      if (!providerEnabled(settings, route.adapter.id)) {
        throw Object.assign(new Error(`Провайдер «${route.adapter.label}» отключён`), { status: 404, code: 'provider_disabled' })
      }
      const enabled = settings.enabledModels?.[route.adapter.id]
      if (Array.isArray(enabled) && !enabled.includes(route.model)) {
        throw Object.assign(new Error('Модель отключена в настройках'), { status: 404, code: 'model_disabled' })
      }
      return [route]
    }
    const state = await this.store.read()
    const savedPool = (state.pools ?? []).find((item) => item.id === request.model.slice(5))
    if (!savedPool) throw Object.assign(new Error('Пул не найден'), { status: 404 })
    const pool = { ...savedPool, members: savedPool.members.filter((member) => providerEnabled(state.settings, member.split('/', 1)[0])) }
    if (!pool.members.length) throw Object.assign(new Error('Все провайдеры этого пула отключены'), { status: 404, code: 'provider_disabled' })
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
    const stickyMember = stickyKey ? this.poolSticky.get(stickyKey) : undefined
    let ordered = pool.members
    let strategy = pool.strategy
    let sticky = stickyMember
    if (pool.strategy === 'by-complexity') {
      const tiers = state.settings.modelTiers ?? {}
      const continuing = request.messages?.at(-1)?.role === 'tool' && stickyMember && pool.members.includes(stickyMember)
      const complexity = continuing && !request.complexityOverride
        ? { tier: tierOf(tiers, stickyMember), score: null, by: 'sticky' }
        : await this.#complexity(request, pool, state.settings)
      if (complexity && !continuing && !request.complexityOverride && stickyMember && pool.members.includes(stickyMember)) {
        const level = (tier) => TIERS.indexOf(tier)
        const held = tierOf(tiers, stickyMember)
        if (level(held) > level(complexity.tier)) Object.assign(complexity, { tier: held, by: `${complexity.by}+sticky` })
      }
      if (complexity) {
        request.complexity = complexity
        const order = tierOrder(complexity.tier)
        const rank = (member) => order.indexOf(tierOf(tiers, member))
        ordered = [...pool.members].sort((a, b) => rank(a) - rank(b) || (available(b) ?? 100) - (available(a) ?? 100))
        strategy = 'first-available'
        if (!continuing && stickyMember && tierOf(tiers, stickyMember) !== complexity.tier) sticky = undefined
      } else {
        request.complexity = { tier: undefined, score: null, by: 'disabled' }
        strategy = 'most-remaining'
      }
    }
    const chosen = chooseMember({
      members: ordered,
      strategy,
      sticky,
      remaining: available,
    })
    const open = (member) => {
      const left = available(member)
      return left === null || left > 5
    }
    const fitting = ordered.filter(fits)
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
    if (strategy === 'most-remaining') {
      const [first, ...rest] = members
      rest.sort((a, b) => (available(b) ?? 100) - (available(a) ?? 100))
      members = [first, ...rest]
    }
    request.poolStickyKey = stickyKey
    return members.map((member) => this.registry.resolve(member))
  }

  /** Уровень сложности запроса для пула by-complexity или undefined, если режим выключен. */
  async #complexity(request, pool, settings) {
    if (request.complexityOverride) return { tier: request.complexityOverride, score: null, by: 'override' }
    const enabled = enabledClassifiers(settings)
    const cfg = complexityOf(settings)
    const classifier = pool.classifier || 'heuristic'
    if (!enabled.includes(classifier)) return undefined
    if (classifier === 'heuristic') return { ...classifyHeuristic(request, cfg.heuristic), by: 'heuristic' }
    const tier = await this.#classifyLlm(request, cfg.llm).catch(() => undefined)
    if (tier) return { tier, score: null, by: 'llm' }
    return { ...classifyHeuristic(request, cfg.heuristic), by: 'llm→heuristic' }
  }

  /** Короткий запрос к дешёвой модели: light | medium | heavy. */
  async #classifyLlm(request, cfg) {
    const route = this.registry.resolve(cfg.model)
    await this.#enabledAdapter(route.adapter.id)
    const controller = new AbortController()
    const outer = request.signal
    const onAbort = () => controller.abort()
    outer?.addEventListener?.('abort', onAbort, { once: true })
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(Object.assign(new Error('classifier timeout'), { code: 'timeout' }))
      }, cfg.timeoutMs)
    })
    const summary = `Токенов в контексте: ~${estimateTokens(request)}. Инструментов: ${request.tools?.length ?? 0}. Сообщений: ${request.messages?.length ?? 0}.`
    const run = (async () => {
      let text = ''
      const stream = route.adapter.stream({
        model: route.model,
        stream: true,
        maxTokens: 16,
        signal: controller.signal,
        messages: [
          { role: 'system', content: CLASSIFIER_PROMPT },
          { role: 'user', content: `${summary}\n\nЗапрос:\n${lastUserText(request).slice(0, 2000)}` },
        ],
      })
      for await (const event of stream) {
        if (event.type === 'error') throw new Error(event.text || 'classifier error')
        if (event.type === 'text') text += event.text ?? ''
        const tier = parseTier(text)
        if (tier) return tier
      }
      return parseTier(text)
    })()
    try {
      return await Promise.race([run, timeout])
    } finally {
      clearTimeout(timer)
      controller.abort()
      outer?.removeEventListener?.('abort', onAbort)
      run.catch(() => undefined)
    }
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
    // модели, отклонившие запрос с 400: остывают, только если другая модель его приняла
    const rejected = []
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
      if (!failure) {
        for (const model of rejected) this.poolCooldown.set(model, Date.now() + POOL_COOLDOWN_MS)
        yield* held
        return
      }
      const rejectedUpstream = upstreamRejected(failure)
      if (pool && rejectedUpstream) rejected.push(route.publicModel)
      const retry = pool && !visible && index < routes.length - 1 && !request.signal?.aborted && (failoverAllowed(failure) || rejectedUpstream)
      if (pool && failoverAllowed(failure)) {
        const quota = quotaFailure(failure)
        this.poolCooldown.set(route.publicModel, Date.now() + (quota ? QUOTA_COOLDOWN_MS : POOL_COOLDOWN_MS))
        // квота кончилась — свежий снимок usage сразу уберёт из выбора остальные модели этого провайдера
        if (quota) {
          const cached = this.usageCache.get(route.adapter.id)
          if (cached && !cached.pending) cached.at = 0
        }
      }
      if (!retry) {
        yield* held
        yield failure
        return
      }
      request.failoverFrom = `${route.publicModel}: ${failureReason(failure)}`
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
        model: request.routedModel ? `${request.model}${complexityLabel(request.complexity)} → ${route.publicModel}${request.failoverFrom ? ` (замена: ${request.failoverFrom})` : ''}` : route.publicModel,
        ...(request.complexity?.tier ? { complexity: request.complexity } : {}),
        ...(request.failoverFrom ? { failoverFrom: request.failoverFrom } : {}),
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

/** При смене id своего провайдера переносит связанные настройки. */
function renameProviderRefs(settings, from, to) {
  if (settings.providerProxies?.[from] !== undefined) {
    settings.providerProxies[to] = settings.providerProxies[from]
    delete settings.providerProxies[from]
  }
  if (settings.enabledModels?.[from] !== undefined) {
    settings.enabledModels[to] = settings.enabledModels[from]
    delete settings.enabledModels[from]
  }
}

function providerEnabled(settings, providerId) {
  const custom = (settings?.customProviders ?? []).find((item) => item.id === providerId)
  return custom?.enabled !== false && !(settings?.disabledProviders ?? []).includes(providerId)
}

function loggedRequests(state) {
  const fullId = state.settings.saveFullRequest ? state.lastExchange?.id : undefined
  return state.requests.slice(0, 50).map((item) => ({ ...item, hasFull: item.id === fullId }))
}

const POOL_COOLDOWN_MS = 2 * 60 * 1000
const QUOTA_COOLDOWN_MS = 15 * 60 * 1000
const QUOTA_TEXT = /usage.?limit|quota|rate.?limit|limit (reached|exceeded)|too many requests|insufficient|credits?|лимит/i

/** Ошибку можно обойти другой моделью пула: сбой, перегрузка, квота, нет доступа. Ошибки самого запроса — нельзя. */
function failoverAllowed(failure) {
  if (failure.status === 499 || failure.code === 'aborted') return false
  if (['invalid_request', 'context_length_exceeded'].includes(failure.code)) return false
  return ![400, 413, 422].includes(failure.status)
}

/**
 * 400 от самого провайдера (не наша проверка запроса): часто значит, что модель недоступна
 * на подписке или не принимает параметры, которые другие модели примут. Пробуем следующую.
 */
function upstreamRejected(failure) {
  return failure.status === 400 && failure.code !== 'invalid_request'
}

function quotaFailure(failure) {
  return failure.status === 429 || failure.code === 'rate_limit' || failure.code === 'rate_limit_error' || QUOTA_TEXT.test(failure.text ?? '')
}

function failureReason(failure) {
  if (quotaFailure(failure)) return 'лимит'
  return failure.status ? `HTTP ${failure.status}` : 'сбой'
}

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

function complexityLabel(complexity) {
  if (!complexity?.tier) return ''
  return ` [${complexity.tier}${Number.isFinite(complexity.score) ? `·${complexity.score}` : ''}${complexity.by && complexity.by !== 'heuristic' ? ` ${complexity.by}` : ''}]`
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
