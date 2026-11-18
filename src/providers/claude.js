import { SessionProvider } from './session-provider.js'
import { claudeRequest, streamClaude } from './claude-translate.js'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const TOKEN_URL = 'https://claude.ai/v1/oauth/token'
const API = 'https://api.anthropic.com'
const SCOPE = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
// Explicit upstream Claude Code identity, not a claim that this is the official CLI.
// Source: DygDyg/dsh-plugin-subscriptions-ru, src/providers/claude.ts.
const CLI_VERSION = '2.1.283'
const BETA = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24,compact-2026-01-12,files-api-2025-04-14'
const nonempty = value => typeof value === 'string' && value.trim().length > 0
function failure(message, status = 502, code = 'provider_error') { return Object.assign(new Error(message), { status, code }) }
function normalize(tokens, previous = {}) {
  if (!tokens || typeof tokens !== 'object' || !nonempty(tokens.access_token)) throw failure('Claude OAuth: missing access token')
  const refreshToken = tokens.refresh_token === undefined ? previous.refreshToken : tokens.refresh_token
  if (!nonempty(refreshToken)) throw failure('Claude OAuth: missing refresh token')
  if (typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || !Number.isSafeInteger(Math.ceil(Date.now() + tokens.expires_in * 1000))) throw failure('Claude OAuth: invalid token expiry')
  if (tokens.scope !== undefined && !nonempty(tokens.scope)) throw failure('Claude OAuth: invalid scope')
  return { ...previous, accessToken: tokens.access_token, refreshToken, expiresAt: Date.now() + tokens.expires_in * 1000, scopes: tokens.scope ?? previous.scopes ?? SCOPE }
}
async function responseError(response, label) {
  // Never reflect a token endpoint response body: it can contain credentials.
  let payload
  try { payload = await response.json() } catch {}
  const code = typeof payload?.error === 'string' ? payload.error : payload?.error?.type
  const safeCode = typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : response.status === 429 ? 'rate_limit' : 'provider_error'
  // API errors (not token endpoints) carry a human-readable reason, e.g. why a model rejects the request.
  const detail = label === 'Claude' && typeof payload?.error?.message === 'string' ? `: ${payload.error.message.replace(/\s+/g, ' ').slice(0, 300)}` : ''
  return failure(`${label}: HTTP ${response.status} (${safeCode})${detail}`, response.status, safeCode)
}
export function claudeAuthHeaders(session) { return headers(session) }
function headers(session) {
  return { authorization: `Bearer ${session.accessToken}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'user-agent': `claude-cli/${CLI_VERSION} (external, cli)`, 'x-app': 'cli', 'anthropic-dangerous-direct-browser-access': 'true', accept: 'application/json' }
}

export class ClaudeProvider extends SessionProvider {
  #refreshes = new Map()
  constructor(store, options = {}) { super(store, 'claude', 'Claude'); this.fetch = options.fetch ?? options.fetchFn ?? this.fetch }
  oauthSpec() {
    return { callbackPath: '/callback', ports: [0], host: 'localhost', buildAuthorizeUrl({ redirectUri, state, pkce }) {
      return `https://claude.ai/oauth/authorize?${new URLSearchParams({ code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, scope: SCOPE, code_challenge: pkce.challenge, code_challenge_method: 'S256', state })}`
    } }
  }
  async exchange(callback) {
    for (const value of [callback?.code, callback?.redirectUri, callback?.state, callback?.pkce?.verifier]) if (!nonempty(value)) throw failure('Claude OAuth: incomplete callback', 400, 'invalid_request')
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: CLIENT_ID, code: callback.code, redirect_uri: callback.redirectUri, code_verifier: callback.pkce.verifier, state: callback.state }) })
    if (!response.ok) throw await responseError(response, 'Claude OAuth')
    const session = normalize(await response.json())
    try {
      const profileResponse = await this.fetch(`${API}/api/oauth/profile`, { headers: headers(session) })
      if (profileResponse.ok) {
        const profile = await profileResponse.json()
        const email = profile.emailAddress ?? profile.email ?? profile.account?.email_address ?? profile.account?.email
        const plan = profile.subscriptionType ?? profile.subscription_type ?? profile.account?.subscription_type
        if (nonempty(email)) session.email = email
        if (nonempty(plan)) session.plan = plan
        const accountId = profile.account?.uuid ?? profile.account?.id
        if (nonempty(accountId)) session.accountId = accountId
      } else await profileResponse.body?.cancel()
    } catch { /* Profile decoration must not invalidate successful OAuth. */ }
    return session
  }
  async refresh(session) {
    if (!nonempty(session.refreshToken)) throw failure('Claude: missing refresh token; sign in again', 401, 'not_authenticated')
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: CLIENT_ID, scope: session.scopes ?? SCOPE }) })
    if (!response.ok) throw await responseError(response, 'Claude refresh')
    return normalize(await response.json(), session)
  }
  async session(accountKey, force = false, rejectedToken) {
    const bucket = (await this.store.read()).accounts.claude
    const key = accountKey ?? bucket?.default
    const session = bucket?.accounts[key]
    if (!session) throw failure('Claude не подключён', 401, 'not_authenticated')
    if (this.#refreshes.has(key)) return this.#refreshes.get(key)
    if (nonempty(session.accessToken) && ((!force && session.expiresAt - Date.now() > 300000) || (rejectedToken && rejectedToken !== session.accessToken))) return { ...session, accountKey: key }
    const pending = (async () => {
      const next = await this.refresh(session)
      await this.store.update(state => {
        const current = state.accounts.claude?.accounts[key]
        if (current && current.refreshToken === session.refreshToken) state.accounts.claude.accounts[key] = { ...next, accountKey: key }
      })
      return { ...next, accountKey: key }
    })()
    this.#refreshes.set(key, pending)
    try { return await pending } finally { if (this.#refreshes.get(key) === pending) this.#refreshes.delete(key) }
  }
  async authorized(path, account, init = {}) {
    init.signal?.throwIfAborted()
    let session = await this.session(account)
    const send = () => this.fetch(`${API}${path}`, { ...init, headers: { ...headers(session), ...init.headers } })
    let response = await send()
    if (response.status === 401) {
      await response.body?.cancel()
      session = await this.session(session.accountKey ?? account, true, session.accessToken)
      response = await send()
    }
    if (!response.ok) throw await responseError(response, 'Claude')
    return response
  }
  async listModels(account, signal) {
    if (!(await this.listAccounts()).length && account === undefined) return []
    const response = await this.authorized('/v1/models?beta=true', account, { signal })
    const payload = await response.json()
    if (!Array.isArray(payload.data)) throw failure('Claude: invalid model catalog')
    return payload.data.filter(model => nonempty(model.id)).map(model => ({ id: model.id, name: model.display_name || model.id, description: model.description, contextWindow: model.max_input_tokens ?? 200000, supportsImages: false, supportsTools: true, efforts: model.capabilities?.effort?.supported ? ['low', 'medium', 'high', 'xhigh', 'max'].filter(level => model.capabilities.effort[level]?.supported) : undefined }))
  }
  async usage(account, signal) {
    if (!(await this.listAccounts()).length && account === undefined) return { supported: false, windows: [], fetchedAt: Date.now() }
    const response = await this.authorized('/api/oauth/usage', account, { signal })
    const payload = await response.json(); const windows = []
    const add = (kind, percent, reset, scope) => { if (typeof percent === 'number' && Number.isFinite(percent)) windows.push({ kind, usedPercent: percent, ...(Number.isFinite(Date.parse(reset)) ? { resetsAt: Date.parse(reset) } : {}), ...(scope ? { scope } : {}) }) }
    if (Array.isArray(payload.limits)) for (const limit of payload.limits) if (limit) add(limit.kind === 'session' ? 'session' : ['weekly_all', 'weekly_scoped'].includes(limit.kind) ? 'weekly' : 'other', limit.percent, limit.resets_at, limit.scope?.model?.display_name)
    const seen = new Set(windows.map((window) => `${window.kind}:${window.scope ?? ''}`))
    for (const [key, kind, scope] of [['five_hour', 'session'], ['seven_day', 'weekly'], ['seven_day_opus', 'weekly', 'Opus'], ['seven_day_sonnet', 'weekly', 'Sonnet'], ['seven_day_fable', 'weekly', 'Fable']]) {
      if (seen.has(`${kind}:${scope ?? ''}`)) continue
      add(kind, payload[key]?.utilization, payload[key]?.resets_at, scope)
    }
    return { supported: true, windows, fetchedAt: Date.now() }
  }
  async *stream(request, account) {
    try {
      const body = claudeRequest(request)
      const response = await this.authorized('/v1/messages?beta=true', account, { method: 'POST', signal: request.signal, headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) })
      yield* streamClaude(response.body, request.signal)
    } catch (error) {
      yield { type: 'error', text: error.message ?? String(error), status: error.status ?? (request.signal?.aborted ? 499 : 502), code: error.code ?? (request.signal?.aborted ? 'aborted' : 'provider_error') }
    }
  }
}
