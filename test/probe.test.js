import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { GatewayService } from '../src/gateway/service.js'
import { ProviderRegistry } from '../src/gateway/registry.js'
import { createAppServer } from '../src/http/server.js'
import { CodexVersions, resolveCodexVersion } from '../src/providers/codex-versions.js'
import { probeRequest, runProbe } from '../src/providers/probe.js'

test('probe accepts only the provider host and safe headers', () => {
  const request = probeRequest('codex', {
    url: 'https://chatgpt.com/backend-api/codex/models?client_version=0.170.0',
    headers: { originator: 'codex_cli_rs' },
  })
  assert.equal(request.method, 'GET')
  assert.equal(request.headers.originator, 'codex_cli_rs')
  assert.throws(() => probeRequest('codex', { url: 'https://example.com/models' }), /не разрешён/)
  assert.throws(() => probeRequest('codex', { url: 'http://chatgpt.com/models' }), /https/)
  assert.throws(() => probeRequest('codex', { url: 'https://chatgpt.com/models', headers: { authorization: 'Bearer injected' } }), /authorization/)
})

test('probe redacts secrets and truncates the response', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    access_token: 'secret-token',
    models: [{ slug: 'gpt-5.5' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const result = await runProbe(fetchImpl, { method: 'GET', url: 'https://chatgpt.com/models', headers: {} })
  assert.equal(result.status, 200)
  assert.equal(result.body.access_token, '[redacted]')
  assert.equal(result.body.models[0].slug, 'gpt-5.5')
})

test('Codex versions come from stable GitHub releases and a manual choice wins', async () => {
  const versions = new CodexVersions(async () => new Response(JSON.stringify([
    { tag_name: 'rust-v0.171.0-alpha.1', prerelease: true },
    { tag_name: 'rust-v0.170.0', prerelease: false },
    { tag_name: 'rust-v0.169.0', prerelease: false },
  ]), { status: 200 }))
  assert.deepEqual(await versions.list(), ['0.170.0', '0.169.0'])
  assert.equal(resolveCodexVersion('auto', ['0.170.0']), '0.170.0')
  assert.equal(resolveCodexVersion('0.169.0', ['0.170.0', '0.169.0']), '0.169.0')
  assert.equal(resolveCodexVersion('9.9.9', ['0.170.0']), '0.170.0')
})

test('admin probe route is loopback-only and uses the saved session', async () => {
  let seen = {}
  const adapter = {
    id: 'codex',
    label: 'Codex',
    fetch: async (url, init) => {
      seen = { url, authorization: init.headers.authorization }
      return new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'application/json' } })
    },
    session: async () => ({ accessToken: 'saved-token', accountId: 'account' }),
  }
  const registry = new ProviderRegistry([])
  registry.adapters.set('codex', adapter)
  const service = new GatewayService({ read: async () => ({ settings: {} }) }, registry)
  const server = createAppServer(service, { read: async () => ({ settings: {} }) }, { host: '127.0.0.1', port: 0, configuredPort: 0 })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/providers/codex/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://chatgpt.com/backend-api/codex/models?client_version=0.170.0' }),
    })
    assert.equal(response.status, 200)
    assert.equal(seen.authorization, 'Bearer saved-token')
    assert.match(seen.url, /client_version=0\.170\.0/)
    const payload = await response.json()
    assert.equal(payload.body.models.length, 0)
  } finally {
    server.close()
  }
})
