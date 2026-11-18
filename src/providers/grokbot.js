import { randomBytes, randomUUID } from 'node:crypto'
import { providerError } from '../auth/oauth.js'
import { SessionProvider } from './session-provider.js'
import { cursorChecksum, encodeInferenceFrame, loginChallenge, loginUrl, streamInference } from './grokbot-connect.js'
import { localInferenceBridge } from './grokbot-bridge.js'

const API = 'https://api2.cursor.sh'
const AUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
const CLIENT_VERSION = '1.2.0'
const LOGIN_MS = 180_000
const REPLY_MS = 120_000
const AGENT_NAME = 'SubToAPI'

export const AGENT_MODEL = {
  id: 'agent',
  name: 'Облачный бот',
  description: 'Ответ облачного бота Grok Bot, не прямой вызов модели',
  supportsTools: false,
  supportsImages: false,
}
const DIRECT_PROBE = ['grok-4.6', 'grok-4.5', 'composer-2.5', 'default']

export class GrokBotProvider extends SessionProvider {
  #attempt
  #bridge
  #directModels = []
  #probed = false

  constructor(store) { super(store, 'grokbot', 'Grok Bot') }

  async beginLogin() {
    this.cancelLogin()
    const raw = randomBytes(32)
    const controller = new AbortController()
    const attempt = {
      uuid: randomUUID(),
      verifier: raw.toString('base64url'),
      challenge: loginChallenge(raw.toString('base64url')),
      machineId: randomBytes(32).toString('hex'),
      controller,
    }
    attempt.done = this.#poll(attempt)
    attempt.done.catch(() => undefined)
    this.#attempt = attempt
    return {
      authorizeUrl: loginUrl(attempt.challenge, attempt.uuid),
      instructions: 'Подтвердите вход в браузере и не нажимайте Open Grok Bot. Вернитесь сюда и нажмите «Завершить вход»: поле callback оставьте пустым.',
    }
  }

  async completeLogin() {
    if (!this.#attempt) throw Object.assign(new Error('Сначала начните вход'), { status: 409 })
    const attempt = this.#attempt
    const payload = await attempt.done
    this.#attempt = undefined
    const accessToken = payload.accessToken || payload.access_token
    const refreshToken = payload.refreshToken || payload.refresh_token
    if (!accessToken || !refreshToken) throw new Error('Grok Bot не вернул токен')
    const draft = {
      accessToken,
      refreshToken,
      expiresAt: expiry(accessToken),
      machineId: attempt.machineId,
      ...(payload.selectedTeamId ? { teamId: String(payload.selectedTeamId) } : {}),
    }
    const profile = await this.#profile(draft).catch(() => ({}))
    const session = { ...draft, account: profile.email || subject(accessToken) || 'grokbot', plan: profile.plan }
    const key = session.account
    await this.store.update((state) => {
      const bucket = state.accounts.grokbot ?? { default: key, accounts: {} }
      bucket.accounts[key] = { ...session, accountKey: key }
      bucket.default ??= key
      state.accounts.grokbot = bucket
    })
    return { key, label: session.account, plan: session.plan, expiresAt: session.expiresAt, isDefault: true }
  }

  cancelLogin() {
    this.#attempt?.controller.abort()
    this.#attempt = undefined
  }

  async refresh(session) {
    const response = await this.fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: AUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: session.refreshToken }),
    })
    if (!response.ok) throw await providerError(response, 'Grok Bot refresh')
    const tokens = await response.json()
    const accessToken = tokens.access_token || tokens.accessToken
    if (!accessToken) throw new Error('Grok Bot не обновил токен')
    return {
      accessToken,
      refreshToken: tokens.refresh_token || tokens.refreshToken || session.refreshToken,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : expiry(accessToken),
    }
  }

  async listModels(_account, signal) {
    const session = await this.session().catch(() => undefined)
    if (!session) return []
    const bridge = await this.#inferenceBridge(signal)
    if (bridge) await this.#probeDirect(session, bridge, signal).catch(() => undefined)
    const showAll = bridge ? await showAllModels(this.store) : false
    const remote = showAll ? await this.#models(session, signal).catch(() => []) : []
    return visibleGrokBotModels(remote, showAll, this.#directModels)
  }

  async usage(_account, signal) {
    const session = await this.session().catch(() => undefined)
    if (!session) return { supported: false, windows: [], fetchedAt: Date.now() }
    const response = await this.fetch(`${API}/aiserver.v1.DashboardService/GetSandUsageStatus`, {
      method: 'POST',
      headers: jsonHeaders(session),
      body: '{}',
      signal,
    })
    if (!response.ok) return { supported: true, windows: [], error: `HTTP ${response.status}`, fetchedAt: Date.now() }
    const payload = await response.json().catch(() => undefined)
    const used = Number(payload?.usagePercent)
    if (!Number.isFinite(used)) return { supported: true, windows: [], error: 'Grok Bot не вернул недельную квоту', fetchedAt: Date.now() }
    const resetsAt = Date.parse(payload.nextResetTimestampUtc)
    return {
      supported: true,
      plan: payload.grokPlanLabel || payload.cursorPlanName,
      windows: [{ kind: 'weekly', usedPercent: used, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) }],
      fetchedAt: Date.now(),
    }
  }

  async *streamWithSession(request, session) {
    try {
      if (grokBotRoute(request.model, await this.#inferenceBridge(request.signal)) === 'direct') yield* this.#direct(request, session)
      else if (grokBotRoute(request.model, undefined) === 'agent') yield* this.#stream(request, session)
      else throw Object.assign(new Error('Прямая модель недоступна: на этой машине нет inference-токена Grok Bot. Используйте grokbot/agent.'), { status: 409, code: 'bridge_unavailable' })
    } catch (error) {
      if (error.status !== 401) throw error
      this.#bridge = undefined
      const fresh = await this.session(session.accountKey, true)
      if (grokBotRoute(request.model, await this.#inferenceBridge(request.signal)) === 'direct') yield* this.#direct(request, fresh)
      else if (grokBotRoute(request.model, undefined) === 'agent') yield* this.#stream(request, fresh)
      else throw error
    }
  }

  async *#direct(request, session) {
    const bridge = await this.#inferenceBridge(request.signal)
    if (!bridge) {
      throw Object.assign(new Error('Прямая модель недоступна: на этой машине нет inference-токена Grok Bot. Используйте grokbot/agent.'), { status: 409, code: 'bridge_unavailable' })
    }
    const response = await this.fetch(`${API}/aiserver.v1.InferenceService/Stream`, {
      method: 'POST',
      headers: inferenceHeaders(session, bridge.token),
      body: encodeInferenceFrame(request, { invocationId: randomUUID(), conversationId: request.promptCacheKey || randomUUID() }),
      signal: request.signal,
    })
    if (!response.ok) throw await providerError(response, 'Grok Bot')
    if (!this.#directModels.some((model) => model.id === request.model)) {
      this.#directModels.push({ id: request.model, name: request.model, supportsTools: true, supportsImages: false })
    }
    yield* streamInference(response.body)
  }

  async *#stream(request, session) {
    const turn = agentRequest(request.messages, request.promptCacheKey, session.agentSessions)
    if (!turn.prompt) throw Object.assign(new Error('Пустой запрос'), { status: 400 })
    const agentId = await this.#agent(session, request.signal)
    const cursor = await this.#cursor(session, agentId, turn.sessionId, request.signal)
    let sent = await this.#send(session, agentId, turn, request.signal)
    if (String(sent.delivery).includes('REFUSED') && !turn.resume) {
      sent = await this.#send(session, agentId, { ...turn, sessionId: '', prompt: composeAgentPrompt(request.messages) }, request.signal)
    } else if (String(sent.delivery).includes('REFUSED')) {
      throw Object.assign(new Error('Grok Bot не принял сохранённую сессию кеша. Повторите запрос без prompt cache key.'), { status: 409, code: 'cache_rejected' })
    }
    if (String(sent.delivery).includes('REFUSED')) {
      throw Object.assign(new Error(sent.refusal?.message || 'Grok Bot не принял сообщение'), { status: 502, code: sent.refusal?.failureCode || 'provider_error' })
    }
    const deadline = Date.now() + REPLY_MS
    let seen = ''
    let stable = 0
    while (Date.now() < deadline) {
      const page = await this.#rpc(session, 'ListGrokBotTranscriptEntries', { agentId, sessionId: sent.sessionId || '', limit: 12 }, request.signal)
      const text = replyAfter(page.entries, cursor)
      if (text && text !== seen) {
        yield { type: 'text', text: text.slice(seen.length) }
        seen = text
        stable = 0
      } else if (seen) stable += 1
      if (seen && stable >= 2) break
      await sleep(1000, request.signal)
    }
    if (!seen) throw Object.assign(new Error('Grok Bot не ответил'), { status: 504, code: 'provider_error' })
    if (request.promptCacheKey && sent.sessionId) await this.#rememberSession(session, request.promptCacheKey, sent.sessionId)
    yield { type: 'done', finishReason: 'stop' }
  }

  async #send(session, agentId, turn, signal) {
    const sent = await this.#rpc(session, 'SendGrokBotUserMessage', {
      agentId,
      text: turn.prompt,
      sessionId: turn.sessionId,
      messageId: randomUUID(),
      attachmentPaths: [],
      attachmentNames: [],
      sentAtMs: String(Date.now()),
      isFork: false,
      source: 1,
      initiator: 1,
      sendSource: 1,
    }, signal)
    return { ...sent, sessionId: turn.sessionId }
  }

  async #agent(session, signal) {
    const listed = await this.#rpc(session, 'ListGrokBotAgents', { includeTeamAgents: false }, signal)
    const agents = listed.agents ?? []
    const ready = agents.find((agent) => agent.agentId === session.agentId && agent.harness === 'temporal')
      ?? agents.find((agent) => agent.name === AGENT_NAME && agent.harness === 'temporal' && agent.agentId)
    if (ready) {
      await this.#rememberAgent(session, ready.agentId)
      return ready.agentId
    }
    const agentId = randomUUID()
    const created = await this.#rpc(session, 'CreateGrokBotAgent', {
      agentId,
      name: AGENT_NAME,
      description: 'Запросы шлюза SubToAPI',
      title: AGENT_NAME,
      avatarShape: 'squircle',
      avatarColor: 'cyan',
      harness: 2,
      createIntent: 1,
      createCaller: 5,
      introductionSuppressed: true,
    }, signal)
    const id = created.agent?.agentId || agentId
    if (created.agent?.harness && created.agent.harness !== 'temporal') {
      throw Object.assign(new Error('Grok Bot создал бота без облачного ответа'), { status: 502 })
    }
    await this.#rememberAgent(session, id)
    return id
  }

  async #rememberAgent(session, agentId) {
    if (session.agentId === agentId) return
    session.agentId = agentId
    await this.store.update((state) => {
      const account = state.accounts.grokbot?.accounts[session.accountKey]
      if (account) account.agentId = agentId
    })
  }

  async #rememberSession(session, cacheKey, sessionId) {
    session.agentSessions = { ...session.agentSessions, [cacheKey]: sessionId }
    await this.store.update((state) => {
      const account = state.accounts.grokbot?.accounts[session.accountKey]
      if (account) account.agentSessions = { ...account.agentSessions, [cacheKey]: sessionId }
    })
  }

  async #inferenceBridge(signal) {
    if (this.#bridge && this.#bridge.expiresAt - Date.now() > 60_000) return this.#bridge
    const timeout = AbortSignal.timeout(4000)
    const bridge = await localInferenceBridge({ signal: signal ? AbortSignal.any([signal, timeout]) : timeout }).catch(() => undefined)
    this.#bridge = bridge
    if (!bridge) {
      this.#directModels = []
      this.#probed = false
    }
    return bridge
  }

  async #probeDirect(session, bridge, signal) {
    if (this.#probed) return
    this.#probed = true
    for (const id of DIRECT_PROBE) {
      const response = await this.fetch(`${API}/aiserver.v1.InferenceService/Stream`, {
        method: 'POST',
        headers: inferenceHeaders(session, bridge.token),
        body: encodeInferenceFrame({ model: id, messages: [{ role: 'user', content: 'Reply with the single word ok.' }] }, { invocationId: randomUUID(), conversationId: randomUUID() }),
        signal,
      })
      if (!response.ok) continue
      const events = []
      for await (const event of streamInference(response.body)) events.push(event)
      if (events.some((event) => event.type === 'text')) this.#directModels.push({ id, name: id, supportsTools: true, supportsImages: false })
    }
  }

  async #cursor(session, agentId, sessionId, signal) {
    const page = await this.#rpc(session, 'ListGrokBotTranscriptEntries', { agentId, sessionId: sessionId || '', limit: 1 }, signal)
    return (page.entries ?? []).reduce((max, entry) => seqOf(entry) > max ? seqOf(entry) : max, 0n)
  }

  async #rpc(session, method, body, signal) {
    const response = await this.fetch(`${API}/aiserver.v1.GrokBotService/${method}`, {
      method: 'POST',
      headers: jsonHeaders(session),
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) throw await providerError(response, 'Grok Bot')
    return response.json().catch(() => ({}))
  }

  async #poll(attempt) {
    const deadline = Date.now() + LOGIN_MS
    while (Date.now() < deadline) {
      if (attempt.controller.signal.aborted) throw new Error('Вход отменён')
      const url = new URL(`${API}/auth/poll`)
      url.searchParams.set('uuid', attempt.uuid)
      url.searchParams.set('verifier', attempt.verifier)
      const response = await this.fetch(url, { headers: clientHeaders(attempt), signal: attempt.controller.signal })
      if (response.status === 404 || response.status === 204) {
        await delay(1000, attempt.controller.signal)
        continue
      }
      if (response.status === 403) throw new Error('Grok Bot отказал во входе')
      if (!response.ok) throw await providerError(response, 'Grok Bot login')
      const payload = await response.json()
      if (payload.accessToken || payload.access_token) return payload
      await delay(1000, attempt.controller.signal)
    }
    throw new Error('Время входа истекло')
  }

  async #profile(session) {
    const response = await this.fetch(`${API}/aiserver.v1.DashboardService/GetMe`, {
      method: 'POST',
      headers: jsonHeaders(session),
      body: '{}',
    })
    if (!response.ok) return {}
    const payload = await response.json()
    return { email: payload.email, plan: payload.plan || payload.subscriptionStatus }
  }

  async #models(session, signal) {
    const timeout = AbortSignal.timeout(8_000)
    const response = await this.fetch(`${API}/aiserver.v1.AiService/AvailableModels`, {
      method: 'POST',
      headers: jsonHeaders(session),
      body: '{}',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) return []
    const payload = await response.json()
    const rows = payload.models ?? payload.data ?? []
    if (!Array.isArray(rows)) return []
    return rows.flatMap((model) => {
      const id = model.modelId || model.id || model.name
      return id ? [{ id, name: model.displayName || model.name || id, supportsTools: true, supportsImages: false }] : []
    })
  }

}

export function grokBotRoute(model, bridge) {
  if (!model || model === AGENT_MODEL.id) return 'agent'
  return bridge?.token ? 'direct' : 'unavailable'
}

export function agentRequest(messages = [], cacheKey, sessions = {}) {
  const sessionId = cacheKey ? sessions[cacheKey] : undefined
  if (sessionId) {
    const last = [...messages].reverse().find((message) => message.role === 'user' || message.role === 'tool')
    return { sessionId, prompt: composeAgentPrompt(last ? [last] : []), resume: true }
  }
  return { sessionId: randomUUID(), prompt: composeAgentPrompt(messages), resume: false }
}

export function composeAgentPrompt(messages = []) {
  return messages.map((message) => {
    if (message.role === 'system') return `[SYSTEM]\n${message.content ?? ''}`
    if (message.role === 'tool') return `TOOL_RESULT ${message.name || 'tool'}: ${message.content ?? ''}`
    if (message.role === 'assistant') {
      const calls = (message.toolCalls ?? []).map((call) => `${call.name}(${call.arguments || '{}'})`).join(', ')
      return ['assistant', message.content, calls].filter(Boolean).join('\n')
    }
    return message.content ?? ''
  }).filter(Boolean).join('\n\n')
}

export function replyAfter(entries, cursor) {
  const parts = []
  for (const entry of [...(entries ?? [])].sort((left, right) => seqOf(left) < seqOf(right) ? -1 : 1)) {
    if (seqOf(entry) <= cursor) continue
    const text = transcriptText(entry)
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

function transcriptText(entry) {
  if (!entry?.body) return ''
  let body
  try { body = JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8')) } catch { return '' }
  if (body?.kind !== 'send-message' || typeof body.message?.content !== 'string') return ''
  return body.message.content
}

function seqOf(entry) {
  try { return BigInt(entry?.updatedSeq ?? entry?.seq ?? 0) } catch { return 0n }
}

export function visibleGrokBotModels(remote, showAll, direct = []) {
  const models = [AGENT_MODEL, ...direct.filter((model) => model.id && model.id !== AGENT_MODEL.id)]
  if (!showAll) return models
  const known = new Set(models.map((model) => model.id))
  return [...models, ...remote.filter((model) => model.id && !known.has(model.id))]
}

async function showAllModels(store) {
  return Boolean((await store.read()).settings.providerOptions?.grokbot?.showAllModels)
}

function inferenceHeaders(session, token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/connect+proto',
    accept: 'application/connect+proto',
    'connect-protocol-version': '1',
    'x-cursor-checksum': cursorChecksum(session.machineId),
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': '0.24.0',
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
    ...(session.teamId ? { 'x-cursor-team-id': String(session.teamId) } : {}),
  }
}

export function grokbotAuthHeaders(session) { return jsonHeaders(session) }
function jsonHeaders(session) {
  return { ...clientHeaders(session), 'content-type': 'application/json', accept: 'application/json', 'connect-protocol-version': '1' }
}

function clientHeaders(session, token = session.accessToken) {
  const headers = {
    'x-cursor-client-type': 'sand',
    'x-cursor-client-source': 'sand-desktop',
    'x-cursor-client-version': CLIENT_VERSION,
    'x-cursor-client-os': process.platform,
    'x-sand-box-namespace': 'prod',
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
    'x-cursor-checksum': cursorChecksum(session.machineId),
    'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Sand/${CLIENT_VERSION} Safari/537.36`,
    accept: 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (session.teamId) headers['x-cursor-team-id'] = String(session.teamId)
  return headers
}

function expiry(token) {
  const exp = Number(subjectPayload(token)?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : Date.now() + 60 * 60_000
}

function subject(token) {
  const payload = subjectPayload(token)
  return payload?.email || payload?.sub
}

function subjectPayload(token) {
  const part = String(token).split('.')[1]
  if (!part) return undefined
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) } catch { return undefined }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('Запрос отменён'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Запрос отменён'))
    }, { once: true })
  })
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('Вход отменён'))
    }, { once: true })
  })
}
