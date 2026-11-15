import { createServer } from 'node:http'
import { createPkce, randomToken } from './pkce.js'

export class OAuthAttempt {
  #settled = false
  #resolve
  #reject
  #servers = []
  #timer

  /**
   * @param {{callbackPath: string, ports: number[], host?: string, timeoutMs?: number, buildAuthorizeUrl: Function}} spec
   */
  constructor(spec) {
    this.spec = spec
    this.done = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    this.done.catch(() => undefined)
  }

  async start() {
    const pkce = createPkce()
    const state = randomToken(24)
    const nonce = randomToken(16)
    const bound = await listen(this.spec.ports, async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== this.spec.callbackPath) {
        response.writeHead(404).end('Not found')
        return
      }
      const code = url.searchParams.get('code')
      const returned = url.searchParams.get('state')
      const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      if (error || !code || returned !== state) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<h1>Вход не завершён</h1><p>Можно закрыть вкладку.</p>')
        this.fail(new Error(error || 'OAuth state mismatch'))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h1>Вход выполнен</h1><p>Можно закрыть вкладку и вернуться в SubToAPI.</p>')
      this.succeed({ code, state, pkce, redirectUri: this.redirectUri })
    }, this.spec.host ?? '127.0.0.1')
    this.#servers = bound.servers
    this.redirectUri = `http://${this.spec.host ?? '127.0.0.1'}:${bound.port}${this.spec.callbackPath}`
    this.pkce = pkce
    this.state = state
    this.authorizeUrl = this.spec.buildAuthorizeUrl({ redirectUri: this.redirectUri, state, pkce, nonce })
    this.#timer = setTimeout(() => this.fail(new Error('Время входа истекло')), this.spec.timeoutMs ?? 180_000)
    return this
  }

  manual(input) {
    const value = String(input ?? '').trim()
    if (!value) throw Object.assign(new Error('Вставьте callback URL или код'), { status: 400 })
    let url
    try { url = new URL(value) } catch { /* A bare authorization code is also accepted. */ }
    if (url) {
      const code = url.searchParams.get('code')
      if (!code || url.searchParams.get('state') !== this.state) {
        throw Object.assign(new Error('OAuth state не совпадает или код отсутствует'), { status: 400 })
      }
      this.succeed({ code, state: this.state, pkce: this.pkce, redirectUri: this.redirectUri })
    } else {
      this.succeed({ code: value, state: this.state, pkce: this.pkce, redirectUri: this.redirectUri })
    }
  }

  cancel() { this.fail(new Error('Вход отменён')) }
  succeed(value) { if (!this.#settled) { this.#settled = true; this.#cleanup(); this.#resolve(value) } }
  fail(error) { if (!this.#settled) { this.#settled = true; this.#cleanup(); this.#reject(error) } }
  #cleanup() {
    clearTimeout(this.#timer)
    for (const server of this.#servers) server.close()
  }
}

function listen(ports, handler, host) {
  return new Promise((resolve, reject) => {
    const attempt = (index) => {
      if (index >= ports.length) return reject(new Error('Не удалось открыть локальный OAuth callback'))
      const server = createServer(handler)
      server.once('error', () => attempt(index + 1))
      server.listen(ports[index], host, () => resolve({ servers: [server], port: server.address().port }))
    }
    attempt(0)
  })
}

/** @param {Response} response @param {string} label */
export async function providerError(response, label) {
  const body = await response.text().catch(() => '')
  return Object.assign(new Error(`${label}: HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`), {
    status: response.status,
    code: response.status === 429 ? 'rate_limit' : 'provider_error',
  })
}
