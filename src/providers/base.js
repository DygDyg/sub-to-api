export class BaseProvider {
  loginKind = 'oauth'
  #accounts = []
  #login

  /** @param {import('./types.js').ProviderId} id @param {string} label */
  constructor(id, label) {
    this.id = id
    this.label = label
  }

  async beginLogin() {
    this.#login = { started: Date.now() }
    return {
      authorizeUrl: `https://example.invalid/${this.id}/oauth`,
      instructions: `${this.label}: откройте страницу входа и вставьте callback URL или код.`,
    }
  }

  async completeLogin(input) {
    if (!this.#login) throw Object.assign(new Error('Сначала начните вход'), { status: 409 })
    if (!input.callback && !input.code) throw Object.assign(new Error('Вставьте callback URL или код'), { status: 400 })
    const account = {
      key: `${this.id}-${this.#accounts.length + 1}`,
      label: input.label || `${this.label} account ${this.#accounts.length + 1}`,
      plan: 'not connected',
      isDefault: this.#accounts.length === 0,
    }
    this.#accounts.push(account)
    this.#login = undefined
    return account
  }

  cancelLogin() { this.#login = undefined }
  async listAccounts() { return this.#accounts.map((account) => ({ ...account })) }
  async removeAccount(key) { this.#accounts = this.#accounts.filter((account) => account.key !== key) }
  async setDefaultAccount(key) {
    if (!this.#accounts.some((account) => account.key === key)) throw Object.assign(new Error('Аккаунт не найден'), { status: 404 })
    this.#accounts = this.#accounts.map((account) => ({ ...account, isDefault: account.key === key }))
  }

  async listModels() {
    if (this.#accounts.length === 0) return []
    return [{ id: 'preview', name: `${this.label} preview`, contextWindow: 128000, supportsTools: false, supportsImages: false }]
  }

  async usage() {
    return {
      supported: this.#accounts.length > 0,
      plan: this.#accounts.length ? 'preview' : undefined,
      windows: this.#accounts.length ? [{ kind: 'session', usedPercent: 0 }] : [],
      fetchedAt: Date.now(),
    }
  }

  async *stream() {
    if (this.#accounts.length === 0) {
      yield { type: 'error', text: `${this.label} не подключён`, code: 'not_authenticated', status: 401 }
      return
    }
    yield {
      type: 'error',
      text: `${this.label}: сетевой адаптер ещё не включён. Каркас приложения готов, подключение протокола — следующий этап.`,
      code: 'not_implemented',
      status: 501,
    }
  }
}
