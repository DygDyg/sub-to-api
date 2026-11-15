import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { QUIET_HOLD_MS, createAppServer } from '../src/http/server.js'
import { apiKeyRequired, canReachSettings, isInternetAddress, settingsKeyMustBeSet, settingsKeyRequired } from '../src/network.js'
import { Store } from '../src/storage/store.js'

test('settings exposure matches network zones and keeps the legacy switch', () => {
  assert.equal(canReachSettings('8.8.8.8', { remoteSettings: true }), false)
  assert.equal(canReachSettings('192.168.1.20', { remoteSettings: true }), true)
  assert.equal(canReachSettings('192.168.1.20', { remoteSettings: false }), false)
  assert.equal(canReachSettings('127.0.0.1', { remoteSettings: false }), true)
  assert.equal(canReachSettings('8.8.8.8', { settingsExposure: 'internet' }), true)
  assert.equal(canReachSettings('192.168.1.20', { settingsExposure: 'internet' }), true)
  assert.equal(canReachSettings('8.8.8.8', { settingsExposure: 'lan' }), false)
  assert.equal(canReachSettings('10.0.0.4', { settingsExposure: 'localhost' }), false)
})

test('settings key is skipped on this computer and optional on the local network', () => {
  assert.equal(settingsKeyRequired('127.0.0.1', 'lan'), false)
  assert.equal(settingsKeyRequired('::1', 'internet'), false)
  assert.equal(settingsKeyRequired('192.168.1.20', 'internet'), false)
  assert.equal(settingsKeyRequired('192.168.1.20', 'lan'), true)
  assert.equal(settingsKeyRequired('8.8.8.8', 'internet'), true)
  assert.equal(settingsKeyRequired('8.8.8.8', 'lan'), true)
  assert.equal(settingsKeyMustBeSet('internet', 'internet'), true)
  assert.equal(settingsKeyMustBeSet('lan', 'lan'), true)
  assert.equal(settingsKeyMustBeSet('lan', 'internet'), false)
  assert.equal(settingsKeyMustBeSet('localhost', 'lan'), false)
})

test('old optional mode stays open when the zone was never saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub-to-api-'))
  const path = join(directory, 'state.json')
  await writeFile(path, JSON.stringify({ settings: { authMode: 'optional', apiKey: 'legacy' } }))
  const settings = (await new Store(path).read()).settings
  assert.equal(settings.apiKeyScope, 'none')
  await writeFile(path, JSON.stringify({ settings: { authMode: 'required', apiKey: 'legacy' } }))
  assert.equal((await new Store(path).read()).settings.apiKeyScope, 'localhost')
})

test('API key is required by zone, not by a single global switch', () => {
  assert.equal(apiKeyRequired('8.8.8.8', 'internet'), true)
  assert.equal(apiKeyRequired('192.168.1.20', 'internet'), false)
  assert.equal(apiKeyRequired('127.0.0.1', 'internet'), false)
  assert.equal(apiKeyRequired('192.168.1.20', 'lan'), true)
  assert.equal(apiKeyRequired('8.8.8.8', 'lan'), true)
  assert.equal(apiKeyRequired('127.0.0.1', 'lan'), false)
  assert.equal(apiKeyRequired('127.0.0.1', 'localhost'), true)
  assert.equal(apiKeyRequired('8.8.8.8', 'none'), false)
})

test('API key list rejects an empty required set and accepts a second key', async () => {
  const state = { settings: { port: 8787, exposure: 'localhost', authMode: 'required', apiKey: 'one', apiKeyScope: 'localhost', apiKeys: [{ id: 'a', label: 'Дом', key: 'one' }] } }
  const store = { read: async () => structuredClone(state), update: async fn => fn(state) }
  const runtime = { host: '127.0.0.1', port: 0, exposure: 'localhost', settingsExposure: 'localhost' }
  const server = createAppServer({ models: async () => ({ data: [] }) }, store, runtime, {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  runtime.port = server.address().port
  const post = body => fetch(`http://127.0.0.1:${runtime.port}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const models = (key) => fetch(`http://127.0.0.1:${runtime.port}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} })
  try {
    assert.equal((await post({ apiKeyScope: 'localhost', apiKeys: [] })).status, 400)
    assert.equal(state.settings.apiKeys.length, 1)
    assert.equal((await post({ apiKeys: [{ label: 'Дом', key: 'one' }, { label: 'Дом', key: 'one' }] })).status, 400)
    assert.equal((await post({ apiKeyScope: 'internet', apiKeys: [{ id: 'a', label: 'Дом', key: 'one' }, { id: 'b', label: 'Ноут', key: 'two' }] })).status, 200)
    assert.equal((await models()).status, 200)
    assert.equal((await models('two')).status, 200)
    assert.equal((await models('nope')).status, 200)
    state.settings.apiKeyScope = 'localhost'
    assert.equal((await models()).status, 401)
    assert.equal((await models('two')).status, 200)
    assert.equal((await models('nope')).status, 401)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('opening settings beyond this computer requires a key when that zone asks for one', async () => {
  const state = { settings: { port: 8787, exposure: 'internet', authMode: 'optional', apiKey: 'test', settingsExposure: 'localhost', settingsKey: '', settingsKeyScope: 'internet' } }
  const store = { read: async () => structuredClone(state), update: async fn => fn(state) }
  const runtime = { host: '0.0.0.0', port: 0, exposure: 'internet', settingsExposure: 'localhost', settingsKey: '', settingsKeyScope: 'internet' }
  const server = createAppServer({ overview: async () => ({ settings: {}, providers: [], requests: [] }) }, store, runtime, {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  runtime.port = server.address().port
  const post = body => fetch(`http://127.0.0.1:${runtime.port}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ settingsExposure: 'internet' })).status, 400)
    assert.equal(state.settings.settingsExposure, 'localhost')
    assert.equal((await post({ settingsExposure: 'lan', settingsKeyScope: 'internet' })).status, 200)
    assert.equal(state.settings.settingsKey, '')
    assert.equal((await post({ settingsExposure: 'lan', settingsKeyScope: 'lan' })).status, 400)
    const saved = await post({ settingsExposure: 'internet', settingsKey: 'door', settingsKeyScope: 'lan' })
    assert.equal(saved.status, 200)
    assert.equal(state.settings.settingsKey, 'door')
    assert.equal(state.settings.settingsExposure, 'internet')
    assert.equal(runtime.settingsKeyScope, 'lan')
    assert.equal((await fetch(`http://127.0.0.1:${runtime.port}/api/overview`)).status, 200)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('port changes reject occupied ports, accept same port and preserve effective port', async () => {
  const state = { settings: { port: 8787, exposure: 'localhost', authMode: 'required', apiKey: 'test' } }
  const store = { read: async () => structuredClone(state), update: async fn => fn(state) }
  const runtime = { host: '127.0.0.1', port: 0, exposure: 'localhost' }
  const changes = []
  const server = createAppServer({}, store, runtime, { rebind: value => changes.push(value) })
  const occupied = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  runtime.port = server.address().port
  const post = body => fetch(`http://127.0.0.1:${runtime.port}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const denied = await post({ port: occupied.address().port })
    assert.equal(denied.status, 409)
    assert.equal(state.settings.port, 8787)
    assert.equal(changes.length, 0)
    assert.equal((await post({ port: runtime.port })).status, 200)
    assert.equal(changes.length, 0)
    state.settings.port = occupied.address().port
    assert.equal((await post({ apiKey: 'updated' })).status, 200)
    assert.equal(state.settings.port, runtime.port)
    assert.equal(changes.length, 0)
    assert.equal((await post({ port: 65536 })).status, 400)
  } finally {
    server.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => occupied.close(resolve))])
  }
})

test('internet probes stay silent while lan and localhost still answer', async () => {
  assert.equal(isInternetAddress('8.8.8.8'), true)
  assert.equal(isInternetAddress('::ffff:8.8.8.8'), true)
  assert.equal(isInternetAddress('192.168.1.20'), false)
  assert.equal(isInternetAddress('::ffff:192.168.1.150'), false)
  assert.equal(isInternetAddress('127.0.0.1'), false)
  assert.equal(isInternetAddress('::1'), false)
  assert.ok(QUIET_HOLD_MS >= 20_000 && QUIET_HOLD_MS <= 30_000)

  const state = {
    settings: {
      port: 47823,
      exposure: 'internet',
      apiKeyScope: 'internet',
      apiKey: 'secret',
      apiKeys: [{ id: 'a', label: 'Дом', key: 'secret' }],
      settingsExposure: 'lan',
      settingsKey: 'door',
    },
  }
  const store = { read: async () => state, update: async fn => fn(state) }
  const runtime = { host: '0.0.0.0', port: 0, exposure: 'internet', settingsExposure: 'lan', settingsKey: 'door', quietMs: 80, quietLimit: 8 }
  const server = createAppServer({ models: async () => ({ data: [{ id: 'm' }] }) }, store, runtime, {})
  const hit = (remote, url, headers) => {
    const socket = { remoteAddress: remote, destroyed: false, destroy() { this.destroyed = true }, once() {} }
    const request = { url, method: 'GET', headers: headers ?? {}, socket, resume() {} }
    const response = {
      socket,
      headersSent: false,
      status: 0,
      body: '',
      writeHead(status) { this.headersSent = true; this.status = status },
      end(body) { this.body = body ?? '' },
      setHeader(name, value) { this.headerSet = true; this.headers = { ...this.headers, [String(name).toLowerCase()]: value } },
    }
    server.emit('request', request, response)
    return { socket, response }
  }
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const probe = hit('8.8.8.8', '/')
  const missing = hit('8.8.8.8', '/v1/models')
  const wrong = hit('8.8.8.8', '/v1/models', { authorization: 'Bearer nope' })
  const lan = hit('192.168.1.20', '/v1/models')
  const authed = hit('1.1.1.1', '/v1/models', { authorization: 'Bearer secret' })
  const opened = hit('8.8.8.8', '/?settings=door')
  const wrongPage = hit('8.8.8.8', '/?settings=nope')
  await flush()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(probe.response.headersSent, false)
  assert.equal(probe.response.headerSet, undefined)
  assert.equal(probe.socket.destroyed, false)
  assert.equal(missing.response.headersSent, false)
  assert.equal(missing.response.headerSet, undefined)
  assert.equal(wrong.response.headersSent, false)
  assert.equal(wrong.response.headerSet, undefined)
  assert.equal(lan.response.status, 200)
  assert.equal(authed.response.status, 200)
  assert.equal(opened.response.status, 200)
  assert.match(opened.response.headers?.['set-cookie'] ?? '', /^settings=door;/)
  assert.equal(wrongPage.response.headersSent, false)
  assert.equal(wrongPage.response.headerSet, undefined)
  const withCookie = hit('8.8.8.8', '/app.js', { cookie: 'settings=door' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(withCookie.response.status, 200)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(probe.socket.destroyed, true)
  assert.equal(missing.socket.destroyed, true)
  assert.equal(probe.response.headersSent, false)

  const limited = createAppServer({ models: async () => ({ data: [] }) }, store, { ...runtime, quietMs: 5_000, quietLimit: 1 }, {})
  const open = {
    remoteAddress: '8.8.8.8',
    destroyed: false,
    destroy() { this.destroyed = true },
    once() {},
  }
  const held = { url: '/api/overview', method: 'GET', headers: {}, socket: open, resume() {} }
  const heldResponse = { socket: open, headersSent: false, writeHead() { this.headersSent = true }, end() {}, setHeader() {} }
  limited.emit('request', held, heldResponse)
  const dropped = { remoteAddress: '9.9.9.9', destroyed: false, destroy() { this.destroyed = true }, once() {} }
  const droppedResponse = { socket: dropped, headersSent: false, writeHead() { this.headersSent = true }, end() {}, setHeader() { this.headerSet = true } }
  limited.emit('request', { url: '/', method: 'GET', headers: {}, socket: dropped, resume() {} }, droppedResponse)
  assert.equal(open.destroyed, false)
  assert.equal(heldResponse.headersSent, false)
  assert.equal(dropped.destroyed, true)
  assert.equal(droppedResponse.headersSent, false)
  assert.equal(droppedResponse.headerSet, undefined)

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const page = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(2000) })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /SubToAPI/)
    const models = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`, { signal: AbortSignal.timeout(2000) })
    assert.equal(models.status, 200)
  } finally {
    server.closeAllConnections()
    limited.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => limited.close(resolve))])
  }
})
