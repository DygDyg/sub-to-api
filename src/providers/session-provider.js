import { OAuthAttempt } from '../auth/oauth.js'
import { createProviderFetch } from '../proxy.js'

const PREEMPT_MS = 5 * 60_000

export class SessionProvider {
  loginKind = 'oauth'
  #attempt

  /**
   * @param {import('../storage/store.js').Store} store
   * @param {import('./types.js').ProviderId} id
   * @param {string} label
   */
  constructor(store, id, label) {
    this.store = store
    this.id = id
    this.label = label
    this.fetch = createProviderFetch(store, id)
  }

  async beginLogin(input = {}) {
    const spec = await this.oauthSpec(input)
    this.#attempt?.cancel()
    this.#attempt = await new OAuthAttempt(spec).start()
    return { authorizeUrl: this.#attempt.authorizeUrl, instructions: `Откройте страницу входа ${this.label}. Callback будет принят локально; при необходимости вставьте его URL вручную.` }
  }

  async completeLogin(input = {}) {
    if (!this.#attempt) throw Object.assign(new Error('Сначала начните вход'), { status: 409 })
    if (input.callback || input.code) this.#attempt.manual(input.callback || input.code)
    const callback = await this.#attempt.done
    this.#attempt = undefined
    const session = await this.exchange(callback, input)
    const key = session.account || session.accountId || session.email || `${this.id}-${Date.now().toString(36)}`
    await this.store.update((state) => {
      const bucket = state.accounts[this.id] ?? { default: key, accounts: {} }
      bucket.accounts[key] = { ...session, accountKey: key }
      bucket.default ??= key
      state.accounts[this.id] = bucket
    })
    return this.#view(key, session, true)
  }

  cancelLogin() { this.#attempt?.cancel(); this.#attempt = undefined }

  async listAccounts() {
    const bucket = (await this.store.read()).accounts[this.id]
    if (!bucket) return []
    return Object.entries(bucket.accounts).map(([key, session]) => this.#view(key, session, bucket.default === key))
  }

  async removeAccount(key) {
    await this.store.update((state) => {
      const bucket = state.accounts[this.id]
      if (!bucket) return
      delete bucket.accounts[key]
      if (bucket.default === key) bucket.default = Object.keys(bucket.accounts)[0]
    })
  }

  async setDefaultAccount(key) {
    await this.store.update((state) => {
      const bucket = state.accounts[this.id]
      if (!bucket?.accounts[key]) throw Object.assign(new Error('Аккаунт не найден'), { status: 404 })
      bucket.default = key
    })
  }

  async session(accountKey, force = false) {
    const bucket = (await this.store.read()).accounts[this.id]
    const key = accountKey ?? bucket?.default
    const session = key ? bucket?.accounts[key] : undefined
    if (!session) throw Object.assign(new Error(`${this.label} не подключён`), { status: 401, code: 'not_authenticated' })
    if (!force && session.expiresAt - Date.now() > PREEMPT_MS) return session
    const refreshed = await this.refresh(session)
    await this.store.update((state) => {
      if (state.accounts[this.id]?.accounts[key]) state.accounts[this.id].accounts[key] = { ...session, ...refreshed, accountKey: key }
    })
    return { ...session, ...refreshed }
  }

  async *stream(request) {
    try {
      yield* this.streamWithSession(request, await this.session())
    } catch (error) {
      yield { type: 'error', text: error instanceof Error ? error.message : String(error), status: error.status ?? 502, code: error.code ?? 'provider_error' }
    }
  }

  #view(key, session, isDefault) {
    return { key, label: session.account || session.email || session.emailAddress || key, plan: session.plan || session.planType, expiresAt: session.expiresAt, isDefault }
  }
}
