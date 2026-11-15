import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createAppServer } from '../src/http/server.js'
import { canReachSettings, settingsKeyMustBeSet, settingsKeyRequired } from '../src/network.js'

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
