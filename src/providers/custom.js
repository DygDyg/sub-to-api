import { providerError } from '../auth/oauth.js'
import { createProviderFetch } from '../proxy.js'
import { claudeRequest, streamClaude } from './claude-translate.js'
import { PROVIDER_IDS } from './types.js'
import { customUsage, customUsageMode } from './custom-usage.js'

export const CUSTOM_PROTOCOLS = ['openai', 'anthropic']
export const CUSTOM_ID = /^[a-z0-9][a-z0-9_-]{1,31}$/
const RESERVED = new Set([...PROVIDER_IDS, 'pool', 'api', 'v1'])
const ANTHROPIC_VERSION = '2023-06-01'

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_request' })
}

/** Проверяет и нормализует конфиг своего провайдера. @param {any} input @param {any} [previous] */
export function normalizeCustomProvider(input, previous) {
  const id = String(input?.id ?? '').trim().toLowerCase()
  if (!CUSTOM_ID.test(id)) throw invalid('id: 2–32 символа, латиница в нижнем регистре, цифры, - и _')
  if (RESERVED.has(id)) throw invalid(`id «${id}» занят встроенным провайдером`)
  const protocol = String(input?.protocol ?? 'openai')
  if (!CUSTOM_PROTOCOLS.includes(protocol)) throw invalid('protocol: openai или anthropic')
  let baseUrl
  try { baseUrl = new URL(String(input?.baseUrl ?? '').trim()) } catch { throw invalid('Base URL некорректен') }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw invalid('Base URL должен начинаться с http:// или https://')
  const headers = {}
  let rawHeaders = input?.headers ?? {}
  if (typeof rawHeaders === 'string') {
    try { rawHeaders = rawHeaders.trim() ? JSON.parse(rawHeaders) : {} } catch { throw invalid('Заголовки: ожидается JSON-объект') }
  }
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) throw invalid('Заголовки: ожидается JSON-объект')
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw invalid(`Некорректный заголовок: ${name}`)
    headers[name] = String(value)
  }
  const models = (Array.isArray(input?.models) ? input.models : String(input?.models ?? '').split(/[\n,]/))
    .map((model) => String(model).trim()).filter(Boolean).slice(0, 500)
  const presented = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
  const apiKey = presented && !presented.includes('…') ? presented : (previous?.apiKey ?? '')
  return {
    id,
    label: String(input?.label ?? '').trim().slice(0, 80) || id,
    protocol,
    baseUrl: baseUrl.href.replace(/\/+$/, ''),
    apiKey,
    headers,
    models: [...new Set(models)],
    usageMode: input?.usageMode === undefined ? customUsageMode(previous?.usageMode) : customUsageMode(input.usageMode),
    enabled: input?.enabled === undefined ? previous?.enabled !== false : input.enabled !== false,
  }
}

/** Конфиг для UI: ключ замаскирован. */
export function publicCustomProvider(config) {
  return { ...config, apiKey: maskKey(config.apiKey), hasKey: Boolean(config.apiKey) }
}

function maskKey(value) {
  if (!value) return ''
  if (value.length <= 8) return '…'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

export class CustomApiProvider {
  loginKind = 'apikey'
  custom = true

  /** @param {import('../storage/store.js').Store} store @param {ReturnType<typeof normalizeCustomProvider>} config @param {{fetch?: typeof fetch}} [options] */
  constructor(store, config, options = {}) {
    this.store = store
    this.config = config
    this.id = config.id
    this.label = config.label
    this.protocol = config.protocol
    this.fetch = options.fetch ?? createProviderFetch(store, config.id)
  }

  async beginLogin() { throw invalid(`${this.label}: ключ задаётся в настройках, вход не нужен`) }
  async completeLogin() { throw invalid(`${this.label}: ключ задаётся в настройках, вход не нужен`) }
  cancelLogin() {}

  async listAccounts() {
    return [{ key: 'api-key', label: this.config.apiKey ? `API key ${maskKey(this.config.apiKey)}` : 'Без ключа', plan: this.protocol === 'anthropic' ? 'Anthropic API' : 'OpenAI API', isDefault: true }]
  }

  async removeAccount() { throw invalid('Удалите провайдера в настройках') }
  async setDefaultAccount() {}

  headers(extra = {}) {
    const auth = this.config.apiKey
      ? this.protocol === 'anthropic' ? { 'x-api-key': this.config.apiKey } : { authorization: `Bearer ${this.config.apiKey}` }
      : {}
    return {
      accept: 'application/json',
      ...(this.protocol === 'anthropic' ? { 'anthropic-version': ANTHROPIC_VERSION } : {}),
      ...auth,
      ...this.config.headers,
      ...extra,
    }
  }

  url(path) {
    return `${this.config.baseUrl}${path}`
  }

  /** Модели с /models; ручной список добавляется всегда. */
  async listModels(_account, signal) {
    const manual = this.config.models.map((id) => ({ id, name: id, supportsTools: true }))
    let discovered = []
    try {
      discovered = await this.discoverModels(signal)
    } catch (error) {
      if (!manual.length) throw error
    }
    const seen = new Set(discovered.map((model) => model.id))
    return [...discovered, ...manual.filter((model) => !seen.has(model.id))]
  }

  async discoverModels(signal) {
    const response = await this.fetch(this.url('/models'), { headers: this.headers(), signal })
    if (!response.ok) throw await providerError(response, `${this.label} models`)
    const payload = await response.json()
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : []
    return list.filter((model) => model && (model.id || model.name)).map((model) => {
      const id = String(model.id ?? model.name)
      const context = Number(model.context_length ?? model.context_window ?? model.max_input_tokens ?? model.top_provider?.context_length)
      return {
        id,
        name: String(model.display_name ?? model.name ?? id),
        ...(typeof model.description === 'string' && model.description ? { description: model.description.slice(0, 300) } : {}),
        ...(Number.isFinite(context) && context > 0 ? { contextWindow: context } : {}),
        supportsTools: true,
      }
    })
  }

  async usage(_account, signal) {
    return customUsage(this, this.config.usageMode, signal)
  }

  async *stream(request) {
    try {
      if (this.protocol === 'anthropic') yield* this.#streamAnthropic(request)
      else yield* this.#streamOpenAI(request)
    } catch (error) {
      const aborted = request.signal?.aborted
      yield { type: 'error', text: error?.message ?? String(error), status: error?.status ?? (aborted ? 499 : 502), code: error?.code ?? (aborted ? 'aborted' : 'provider_error') }
    }
  }

  async *#streamOpenAI(request) {
    const response = await this.fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify(openAIBody(request)),
      signal: request.signal,
    })
    if (!response.ok) throw await providerError(response, this.label)
    yield* streamOpenAI(response.body, request.signal)
  }

  async *#streamAnthropic(request) {
    const body = anthropicBody(request)
    const response = await this.fetch(this.url('/messages'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: request.signal,
    })
    if (!response.ok) throw await providerError(response, this.label)
    yield* streamClaude(response.body, request.signal)
  }
}

/** Канонический запрос → тело OpenAI /chat/completions. */
export function openAIBody(request) {
  const messages = request.messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' }
    const out = { role: message.role, content: message.content ?? '' }
    if (message.name) out.name = message.name
    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.tool_calls = message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }))
      if (!out.content) out.content = null
    }
    return out
  })
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
  }
}

/** Канонический запрос → тело Anthropic /messages без идентичности Claude Code. */
export function anthropicBody(request) {
  const body = claudeRequest({ ...request, reasoningEffort: undefined, maxTokens: request.maxTokens ?? 8192 })
  const system = body.system.slice(1)
  if (system.length) body.system = system
  else delete body.system
  return body
}

async function* sseData(body, signal) {
  if (!body) throw new Error('Пустой ответ провайдера')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let finished = false
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '')
        pending = pending.slice(index + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
      if (done) { finished = true; break }
    }
    if (pending.startsWith('data:')) yield pending.slice(5).trim()
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Разбор SSE OpenAI chat/completions в канонические события. */
export async function* streamOpenAI(body, signal) {
  const calls = new Map()
  let usage
  let finishReason = 'stop'
  for await (const raw of sseData(body, signal)) {
    if (!raw || raw === '[DONE]') continue
    let chunk
    try { chunk = JSON.parse(raw) } catch { continue }
    if (chunk.error) {
      const error = chunk.error
      throw Object.assign(new Error(error.message || JSON.stringify(error)), { status: Number(error.code) || 502, code: typeof error.type === 'string' ? error.type : 'provider_error' })
    }
    if (chunk.usage) usage = chunk.usage
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? choice.message ?? {}
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning }
      if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? calls.size
        const current = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (call.id) current.id = call.id
        if (call.function?.name) current.name += call.function.name
        if (call.function?.arguments) current.arguments += call.function.arguments
        calls.set(index, current)
      }
      if (choice.finish_reason) finishReason = choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call' ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : 'stop'
    }
  }
  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: 'tool_call', id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || '{}' }
  }
  if (calls.size) finishReason = 'tool_calls'
  if (usage) {
    const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
    yield { type: 'usage', inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, cacheReadTokens: cacheRead, cacheWriteTokens: 0 }
  }
  yield { type: 'done', finishReason }
}
