import { SessionProvider } from './session-provider.js'
import { providerError } from '../auth/oauth.js'

export class AntigravityProvider extends SessionProvider {
  constructor(store) { super(store, 'antigravity', 'Google Antigravity') }

  async beginLogin(input = {}) {
    const saved = (await this.store.read()).settings.antigravityClientId
    const clientId = input.clientId?.trim() || saved || process.env.ANTIGRAVITY_CLIENT_ID
    if (input.clientId?.trim()) {
      await this.store.update((state) => { state.settings.antigravityClientId = input.clientId.trim() })
    }
    return super.beginLogin({ ...input, clientId })
  }

  oauthSpec(input) {
    const clientId = input.clientId || process.env.ANTIGRAVITY_CLIENT_ID
    if (!clientId) throw Object.assign(new Error('Укажите собственный Google OAuth client ID'), { status: 400 })
    return {
      callbackPath: '/oauth-callback', ports: [51121, 0],
      buildAuthorizeUrl({ redirectUri, state, pkce }) {
        const params = new URLSearchParams({ access_type: 'offline', client_id: clientId, code_challenge: pkce.challenge, code_challenge_method: 'S256', prompt: 'consent', redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state })
        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
      },
    }
  }

  async exchange(callback, input) {
    const saved = (await this.store.read()).settings.antigravityClientId
    const clientId = input.clientId || saved || process.env.ANTIGRAVITY_CLIENT_ID
    const response = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.code, client_id: clientId, redirect_uri: callback.redirectUri, code_verifier: callback.pkce.verifier }) })
    if (!response.ok) throw await providerError(response, 'Google OAuth')
    const tokens = await response.json()
    return { ...tokensToSession(tokens), clientId, account: 'Google account' }
  }

  async refresh(session) {
    const response = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId }) })
    if (!response.ok) throw await providerError(response, 'Google refresh')
    return tokensToSession(await response.json(), session)
  }

  async listModels() { const session = await this.session().catch(() => undefined); return session ? [{ id: 'gemini-pro', name: 'Antigravity Gemini', supportsTools: true }] : [] }
  async usage() { return { supported: false, windows: [], fetchedAt: Date.now(), error: 'Квота появится после подтверждения project discovery.' } }
  async *streamWithSession(request, session) {
    const response = await this.fetch('https://cloudcode-pa.googleapis.com/v1internal:generateContent', { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: request.model, user_content: request.messages.at(-1)?.content ?? '' }), signal: request.signal })
    if (!response.ok) throw await providerError(response, 'Antigravity')
    const payload = await response.json()
    yield { type: 'text', text: JSON.stringify(payload).slice(0, 4000) }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function tokensToSession(tokens, previous = {}) {
  if (!tokens.access_token && !previous.accessToken) throw new Error('Google не вернул access token')
  return { accessToken: tokens.access_token ?? previous.accessToken, refreshToken: tokens.refresh_token ?? previous.refreshToken, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, clientId: previous.clientId }
}
