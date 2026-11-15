import { SessionProvider } from './session-provider.js'
import { providerError } from '../auth/oauth.js'
import { responsesBody, streamResponses } from './responses.js'

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'

export class GrokProvider extends SessionProvider {
  constructor(store) { super(store, 'grok', 'Grok') }

  async oauthSpec() {
    const discovery = await this.#discovery()
    return {
      callbackPath: '/callback',
      ports: [56121, 0],
      buildAuthorizeUrl({ redirectUri, state, pkce, nonce }) {
        const params = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, scope: 'openid profile email offline_access grok-cli:access api:access', code_challenge: pkce.challenge, code_challenge_method: 'S256', state, nonce, plan: 'generic', referrer: 'sub-to-api' })
        return `${discovery.authorization_endpoint}?${params}`
      },
    }
  }

  async exchange(callback) {
    const discovery = await this.#discovery()
    const response = await this.fetch(discovery.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code: callback.code, redirect_uri: callback.redirectUri, code_verifier: callback.pkce.verifier, code_challenge: callback.pkce.challenge, code_challenge_method: 'S256' }),
    })
    if (!response.ok) throw await providerError(response, 'Grok OAuth')
    return normalize(await response.json(), discovery.token_endpoint)
  }

  async refresh(session) {
    const response = await this.fetch(session.tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: session.refreshToken }),
    })
    if (!response.ok) throw await providerError(response, 'Grok refresh')
    return normalize(await response.json(), session.tokenEndpoint, session)
  }

  async listModels(_account, signal) {
    const session = await this.session(undefined, false).catch(() => undefined)
    if (!session) return []
    const response = await this.fetch('https://cli-chat-proxy.grok.com/v1/models', { headers: { ...auth(session), 'x-xai-token-auth': 'xai-grok-cli' }, signal })
    if (!response.ok) throw await providerError(response, 'Grok models')
    const payload = await response.json()
    return (payload.data ?? []).filter((model) => model.id && !/imagine|image-|video|embed/i.test(model.id)).map((model) => ({ id: model.id, name: model.name || model.id, description: model.description, contextWindow: Number(model.context_window ?? model.context_length) || GROK_CONTEXT[model.id], supportsTools: true, supportsImages: !/code|embed/i.test(model.id) }))
  }

  async usage(_account, signal) {
    const session = await this.session().catch(() => undefined)
    if (!session) return { supported: false, windows: [], fetchedAt: Date.now() }
    const response = await this.fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers: { ...auth(session), 'x-xai-token-auth': 'xai-grok-cli' }, signal })
    if (!response.ok) return { supported: true, windows: [], error: `HTTP ${response.status}`, fetchedAt: Date.now() }
    const payload = await response.json()
    const used = payload.config?.creditUsagePercent
    return { supported: true, plan: payload.subscriptionTier, windows: Number.isFinite(used) ? [{ kind: 'other', usedPercent: used, resetsAt: Date.parse(payload.config?.currentPeriod?.end) || undefined }] : [], fetchedAt: Date.now() }
  }

  async listMediaModels(signal) {
    const session = await this.session(undefined, false).catch(() => undefined)
    if (!session) return []
    const response = await this.fetch('https://api.x.ai/v1/models', { headers: auth(session), signal })
    if (!response.ok) return []
    const payload = await response.json()
    return (payload.data ?? []).flatMap((model) => {
      const capability = /video/i.test(model.id) ? 'video' : /imagine|image/i.test(model.id) ? 'image' : ''
      return capability ? [{ id: model.id, name: model.id, capability }] : []
    })
  }

  async generateImage(input, signal) {
    const session = await this.session()
    const response = await this.fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: { ...auth(session), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: input.prompt, model: input.model || 'grok-imagine-image-2.0', response_format: 'b64_json', ...(input.size ? { aspect_ratio: grokAspect(input.size) } : {}), ...(input.quality === 'low' ? { quality: 'low' } : input.quality ? { quality: 'medium' } : {}) }),
      signal,
    })
    if (!response.ok) throw await providerError(response, 'Grok image')
    return response.json()
  }

  async startVideo(input, signal) {
    const session = await this.session()
    const response = await this.fetch('https://api.x.ai/v1/videos/generations', {
      method: 'POST',
      headers: { ...auth(session), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: input.prompt, model: input.model || 'grok-imagine-video-1.5', ...(input.duration ? { duration: input.duration } : {}), ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}), ...(input.resolution ? { resolution: input.resolution } : {}), ...(input.imageUrl ? { image: { url: input.imageUrl } } : {}) }),
      signal,
    })
    if (!response.ok) throw await providerError(response, 'Grok video')
    return response.json()
  }

  async videoStatus(id, signal) {
    const session = await this.session()
    const response = await this.fetch(`https://api.x.ai/v1/videos/${encodeURIComponent(id)}`, { headers: auth(session), signal })
    if (!response.ok) throw await providerError(response, 'Grok video status')
    return response.json()
  }

  async *streamWithSession(request, session) {
    const response = await this.fetch('https://api.x.ai/v1/responses', {
      method: 'POST', headers: { ...auth(session), 'content-type': 'application/json', accept: 'text/event-stream' }, signal: request.signal,
      body: JSON.stringify(responsesBody(request)),
    })
    if (!response.ok) throw await providerError(response, 'Grok')
    yield* streamResponses(response.body)
  }

  async #discovery() {
    const response = await this.fetch(DISCOVERY_URL)
    if (!response.ok) throw await providerError(response, 'Grok OIDC')
    const document = await response.json()
    for (const field of ['authorization_endpoint', 'token_endpoint']) {
      const url = new URL(document[field])
      if (url.protocol !== 'https:' || !/(^|\.)x\.ai$/.test(url.hostname)) throw new Error(`Недопустимый Grok OIDC ${field}`)
    }
    return document
  }
}

const GROK_CONTEXT = { 'grok-4.7': 256000, 'grok-4.7-build-fast': 256000, 'grok-4.6': 256000, 'grok-4.5': 256000, 'grok-4': 256000 }

function grokAspect(size) {
  return { '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2', auto: 'auto' }[size] ?? size
}
function auth(session) { return { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' } }
function normalize(tokens, tokenEndpoint, previous = {}) {
  if (!tokens.access_token || !tokens.expires_in) throw new Error('Grok не вернул токен')
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? previous.refreshToken, expiresAt: Date.now() + tokens.expires_in * 1000, tokenEndpoint, account: previous.account }
}

