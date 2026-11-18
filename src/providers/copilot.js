import { providerError } from '../auth/oauth.js'
import { createProviderFetch } from '../proxy.js'

const CLIENT_ID = 'Iv1.b507a08c87ecfe98'

export class CopilotProvider {
  loginKind = 'device'
  #attempt
  constructor(store) { this.store = store; this.id = 'copilot'; this.label = 'GitHub Copilot'; this.fetch = createProviderFetch(store, 'copilot') }

  async beginLogin() {
    const response = await this.fetch('https://github.com/login/device/code', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }) })
    if (!response.ok) throw await providerError(response, 'GitHub device flow')
    this.#attempt = await response.json()
    return { userCode: this.#attempt.user_code, verificationUrl: this.#attempt.verification_uri, instructions: `Откройте ${this.#attempt.verification_uri} и введите код ${this.#attempt.user_code}.` }
  }

  async completeLogin() {
    if (!this.#attempt) throw Object.assign(new Error('Сначала начните вход'), { status: 409 })
    const deadline = Date.now() + (this.#attempt.expires_in ?? 900) * 1000
    while (Date.now() < deadline) {
      const response = await this.fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, device_code: this.#attempt.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) })
      const payload = await response.json()
      if (payload.access_token) return this.#store(payload.access_token)
      if (payload.error !== 'authorization_pending' && payload.error !== 'slow_down') throw new Error(payload.error_description ?? payload.error ?? 'GitHub отказал во входе')
      await new Promise((resolve) => setTimeout(resolve, ((this.#attempt.interval ?? 5) + 1) * 1000))
    }
    throw new Error('Время входа GitHub истекло')
  }

  cancelLogin() { this.#attempt = undefined }
  async listAccounts() { return views(await this.store.read(), this.id) }
  async removeAccount(key) { await remove(this.store, this.id, key) }
  async setDefaultAccount(key) { await setDefault(this.store, this.id, key) }
  async listModels() { const session = await this.#session().catch(() => undefined); if (!session) return []; const response = await this.fetch('https://api.githubcopilot.com/models', { headers: headers(session) }); if (!response.ok) throw await providerError(response, 'Copilot models'); const payload = await response.json(); return (payload.data ?? []).filter((model) => model.model_picker_enabled && model.policy?.state !== 'disabled').map((model) => ({ id: model.id, name: model.name || model.id, description: model.summary || model.description, contextWindow: model.capabilities?.limits?.max_context_window_tokens, supportsTools: model.capabilities?.supports?.tool_calls === true, supportsImages: model.capabilities?.supports?.vision === true })) }
  async usage() { return { supported: false, windows: [], fetchedAt: Date.now(), error: 'Copilot не предоставляет отдельный endpoint квоты.' } }

  async *stream(request) {
    try {
      const session = await this.#session()
      const response = await this.fetch('https://api.githubcopilot.com/chat/completions', { method: 'POST', headers: { ...headers(session), 'content-type': 'application/json' }, body: JSON.stringify({ model: request.model, messages: request.messages.map((message) => ({ role: message.role, content: message.content, tool_call_id: message.toolCallId })), stream: true }), signal: request.signal })
      if (!response.ok) throw await providerError(response, 'Copilot')
      for await (const line of lines(response.body)) if (line.startsWith('data:') && !line.includes('[DONE]')) {
        const data = JSON.parse(line.slice(5))
        const delta = data.choices?.[0]?.delta
        if (delta?.content) yield { type: 'text', text: delta.content }
        if (delta?.tool_calls) for (const call of delta.tool_calls) yield { type: 'tool_call', id: call.id, name: call.function?.name, arguments: call.function?.arguments }
      }
      yield { type: 'done', finishReason: 'stop' }
    } catch (error) { yield { type: 'error', text: error.message, status: error.status ?? 502, code: error.code } }
  }

  async #session() {
    const bucket = (await this.store.read()).accounts.copilot
    const session = bucket?.accounts[bucket.default]
    if (!session) throw Object.assign(new Error('GitHub Copilot не подключён'), { status: 401, code: 'not_authenticated' })
    if (session.expiresAt - Date.now() > 5 * 60_000) return session
    const response = await this.fetch('https://api.github.com/copilot_internal/v2/token', { headers: headers({ accessToken: session.refreshToken }) })
    if (!response.ok) throw await providerError(response, 'Copilot token')
    const wire = await response.json()
    const refreshed = { ...session, accessToken: wire.token, expiresAt: (wire.expires_at ?? Date.now() / 1000 + 1500) * 1000 }
    await this.store.update((state) => { state.accounts.copilot.accounts[bucket.default] = refreshed })
    return refreshed
  }

  async #store(githubToken) {
    const token = await this.fetch('https://api.github.com/copilot_internal/v2/token', { headers: headers({ accessToken: githubToken }) })
    if (!token.ok) throw await providerError(token, 'Copilot token')
    const wire = await token.json()
    const profile = await this.fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${githubToken}`, accept: 'application/json', 'user-agent': 'SubToAPI' } }).then((response) => response.ok ? response.json() : {}).catch(() => ({}))
    const key = profile.login || 'copilot'
    const session = { accessToken: wire.token, refreshToken: githubToken, expiresAt: wire.expires_at * 1000, account: profile.login }
    await this.store.update((state) => { state.accounts.copilot = { default: key, accounts: { ...(state.accounts.copilot?.accounts ?? {}), [key]: session } } })
    this.#attempt = undefined
    return { key, label: profile.login, isDefault: true, expiresAt: session.expiresAt }
  }
}

export function copilotAuthHeaders(session) { return headers(session) }
function headers(session) { return { authorization: `Bearer ${session.accessToken}`, accept: 'application/json', 'user-agent': 'GitHubCopilotChat/0.35.0', 'editor-version': 'vscode/1.107.0', 'editor-plugin-version': 'copilot-chat/0.35.0', 'copilot-integration-id': 'vscode-chat', 'x-github-api-version': '2026-06-01' } }
async function views(state, id) { const bucket = state.accounts[id]; return bucket ? Object.entries(bucket.accounts).map(([key, session]) => ({ key, label: session.account || key, expiresAt: session.expiresAt, isDefault: bucket.default === key })) : [] }
async function remove(store, id, key) { await store.update((state) => { delete state.accounts[id]?.accounts[key]; if (state.accounts[id]?.default === key) state.accounts[id].default = Object.keys(state.accounts[id].accounts)[0] }) }
async function setDefault(store, id, key) { await store.update((state) => { if (!state.accounts[id]?.accounts[key]) throw Object.assign(new Error('Аккаунт не найден'), { status: 404 }); state.accounts[id].default = key }) }
async function* lines(stream) { const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = ''; while (true) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); const parts = pending.split(/\r?\n/); pending = parts.pop() ?? ''; yield* parts } }
