import { CodexVersions, resolveCodexVersion } from './codex-versions.js'
import { SessionProvider } from './session-provider.js'
import { providerError } from '../auth/oauth.js'
import { codexResponsesBody, forgetReasoning, invalidEncryptedContent, streamResponses } from './responses.js'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'

export class CodexProvider extends SessionProvider {
  /** @param {import('../storage/store.js').Store} store @param {{ versions?: CodexVersions }} [options] */
  constructor(store, options = {}) { super(store, 'codex', 'ChatGPT / Codex'); this.versions = options.versions ?? new CodexVersions() }

  oauthSpec() {
    return {
      callbackPath: '/auth/callback', ports: [1455, 0],
      buildAuthorizeUrl({ redirectUri, state, pkce }) {
        const params = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, scope: 'openid profile email offline_access', code_challenge: pkce.challenge, code_challenge_method: 'S256', state, codex_cli_simplified_flow: 'true' })
        return `https://auth.openai.com/oauth/authorize?${params}`
      },
    }
  }

  async exchange(callback) {
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.code, redirect_uri: callback.redirectUri, client_id: CLIENT_ID, code_verifier: callback.pkce.verifier }) })
    if (!response.ok) throw await providerError(response, 'Codex OAuth')
    return normalize(await response.json())
  }

  async refresh(session) {
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: session.refreshToken }) })
    if (!response.ok) throw await providerError(response, 'Codex refresh')
    return normalize(await response.json(), session)
  }

  async listModels(_account, signal) {
    const session = await this.session().catch(() => undefined)
    if (!session) return []
    const version = await this.clientVersion()
    const response = await this.fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`, { headers: headers(session), signal })
    if (!response.ok) throw await providerError(response, 'Codex models')
    const payload = await response.json()
    return (payload.models ?? []).filter((model) => model.visibility !== 'hide' && model.visibility !== 'none').map((model) => ({ id: model.slug, name: model.display_name || model.slug, description: model.description, contextWindow: model.context_window, efforts: model.supported_reasoning_levels?.map((level) => level.effort).filter(Boolean), supportsImages: true, supportsTools: true }))
  }

  async clientVersion() {
    const saved = (await this.store.read()).settings.providerOptions?.codex?.clientVersion
    return resolveCodexVersion(saved, await this.versions.list().catch(() => []))
  }

  async usage(_account, signal) {
    const session = await this.session().catch(() => undefined)
    if (!session) return { supported: false, windows: [], fetchedAt: Date.now() }
    const response = await this.fetch('https://chatgpt.com/backend-api/wham/usage', { headers: headers(session), signal })
    if (!response.ok) return { supported: true, windows: [], error: `HTTP ${response.status}`, fetchedAt: Date.now() }
    const payload = await response.json()
    const windows = [windowOf(payload.rate_limit?.primary_window, 'session'), windowOf(payload.rate_limit?.secondary_window, 'weekly')].filter(Boolean)
    return { supported: true, plan: payload.plan_type, windows, fetchedAt: Date.now() }
  }

  async listMediaModels() {
    const session = await this.session().catch(() => undefined)
    return session ? [{ id: 'gpt-image-2', name: 'GPT Image 2', capability: 'image' }] : []
  }

  async generateImage(input, signal) {
    const session = await this.session()
    const response = await this.fetch('https://chatgpt.com/backend-api/codex/images/generations', {
      method: 'POST',
      headers: { ...headers(session), 'content-type': 'application/json', originator: 'codex_cli_rs' },
      body: JSON.stringify({ prompt: input.prompt, model: 'gpt-image-2', ...(input.size ? { size: input.size } : {}), ...(input.quality ? { quality: input.quality } : {}) }),
      signal,
    })
    if (!response.ok) throw await providerError(response, 'Codex image')
    return response.json()
  }

  async *streamWithSession(request, session) {
    const prepared = codexResponsesBody(request)
    try {
      yield* this.#responses(session, prepared.body, request.signal)
    } catch (error) {
      if (!prepared.replayed.length || !invalidEncryptedContent(error)) throw error
      forgetReasoning(prepared.replayed)
      yield* this.#responses(session, codexResponsesBody(request, { replayReasoning: false }).body, request.signal)
    }
  }

  async *#responses(session, body, signal) {
    const response = await this.fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST', headers: { ...headers(session), 'content-type': 'application/json', accept: 'text/event-stream', originator: 'codex_cli_rs' }, signal,
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await providerError(response, 'Codex')
    yield* streamResponses(response.body)
  }
}

export function codexAuthHeaders(session) { return { authorization: `Bearer ${session.accessToken}`, 'chatgpt-account-id': session.accountId, accept: 'application/json' } }
function headers(session) { return codexAuthHeaders(session) }
function claims(token) { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) } catch { return {} } }
function normalize(tokens, previous = {}) {
  const id = claims(tokens.id_token ?? previous.idToken ?? '')
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? previous.refreshToken, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, accountId: id.chatgpt_account_id ?? previous.accountId, email: id.email ?? previous.email, planType: id.chatgpt_plan_type ?? previous.planType, idToken: tokens.id_token ?? previous.idToken }
}
function windowOf(value, kind) {
  if (!value || !Number.isFinite(value.used_percent)) return undefined
  const resetsAt = resetAt(value)
  return { kind, usedPercent: value.used_percent, ...(resetsAt ? { resetsAt } : {}) }
}
function resetAt(value) {
  if (typeof value.reset_at === 'number' && value.reset_at > 0) return value.reset_at * 1000
  if (typeof value.reset_after_seconds === 'number' && value.reset_after_seconds > 0) return Date.now() + value.reset_after_seconds * 1000
  const parsed = Date.parse(value.reset_at)
  return Number.isFinite(parsed) ? parsed : undefined
}

