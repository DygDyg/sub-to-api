import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/storage/store.js'
import { ProviderRegistry } from '../src/gateway/registry.js'
import { GatewayService } from '../src/gateway/service.js'
import { createAppServer } from '../src/http/server.js'
import { BaseProvider } from '../src/providers/base.js'
import { chatCompletionToCanonical, collectChatCompletion } from '../src/openai/translate.js'
import { priceEstimate, requestCost } from '../src/pricing.js'

test('usage cache collapses repeat lookups and keeps the last good snapshot', async () => {
  let calls = 0
  const provider = new BaseProvider('claude', 'Claude')
  await provider.beginLogin()
  await provider.completeLogin({ code: 'ok' })
  provider.usage = async () => {
    calls += 1
    if (calls === 1) return { supported: true, windows: [{ kind: 'session', usedPercent: 3 }], fetchedAt: 1 }
    return { supported: true, windows: [], error: 'Claude: HTTP 429 (rate_limit_error)', fetchedAt: Date.now() }
  }
  const service = new GatewayService({}, new ProviderRegistry([provider]))
  const first = await service.usage('claude')
  const second = await service.usage('claude')
  assert.equal(calls, 1)
  assert.equal(second.windows[0].usedPercent, 3)
  const refreshed = await service.usage('claude', undefined, true)
  assert.equal(calls, 2)
  assert.equal(refreshed.windows[0].usedPercent, 3)
  assert.equal(refreshed.error, undefined)
  const all = await service.usageAll()
  assert.equal(calls, 2)
  assert.equal(all.providers.length, 1)
  assert.equal(all.providers[0].usage.windows[0].usedPercent, 3)
})

test('model catalog is cached and refresh bypasses it', async () => {
  let calls = 0
  const provider = new BaseProvider('grok', 'Grok')
  provider.listModels = async () => {
    calls += 1
    return [{ id: 'grok-4.7', name: 'Grok 4.7', description: 'fast' }]
  }
  const service = new GatewayService({ read: async () => ({ settings: {} }) }, new ProviderRegistry([provider]))
  const first = await service.catalog()
  const second = await service.models()
  assert.equal(calls, 1)
  assert.equal(first.data[0].id, 'grok/grok-4.7')
  assert.equal(second.data[0].description, 'fast')
  await service.catalog(undefined, true)
  assert.equal(calls, 2)
})

test('price estimate uses public API rates for 100k input', () => {
  assert.equal(priceEstimate('codex/gpt-6-astra').input, '≈ $1.00')
  assert.equal(priceEstimate('codex/gpt-6-astra').output, '≈ $5.00')
  assert.equal(priceEstimate('grok/grok-4.7-build-fast').input, '≈ $0.40')
  assert.equal(priceEstimate('grok/grok-imagine-image-2.0').unit, '≈ $0.04 / изображение')
  assert.equal(priceEstimate('claude/claude-opus-4-5-20251101').input, '≈ $0.50')
  assert.equal(priceEstimate('codex/gpt-image-2').unit, '≈ $30.00 / 1M токенов изображения')
  assert.equal(priceEstimate('unknown/model'), undefined)
  assert.equal(requestCost('grok/grok-4.7', { input: 100000, output: 1000, cacheRead: 80000 }).label, '≈ $0.062')
})

test('canonical translation preserves tool calls and rejects malformed input', () => {
  const canonical = chatCompletionToCanonical({
    model: 'grok/test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    max_tokens: 32,
  })
  assert.equal(canonical.messages[0].content, 'hello')
  assert.equal(canonical.tools[0].name, 'lookup')
  assert.throws(() => chatCompletionToCanonical({}), /messages/)
  assert.equal(chatCompletionToCanonical({ model: 'grok/test', messages: [], prompt_cache_key: ' thread-1 ' }).promptCacheKey, 'thread-1')
  assert.equal(chatCompletionToCanonical({ model: 'grok/test', messages: [] }, { 'x-prompt-cache-key': 'from-header' }).promptCacheKey, 'from-header')
  assert.throws(() => chatCompletionToCanonical({ model: 'grok/test', messages: [], prompt_cache_key: 'bad key\n' }), /prompt_cache_key/)
})

test('pool routing works when usage is already cached as a snapshot', async () => {
  const provider = new BaseProvider('grok', 'Grok')
  provider.usage = async () => ({ supported: true, windows: [{ kind: 'other', usedPercent: 10 }], fetchedAt: 1 })
  const service = new GatewayService({ read: async () => ({ pools: [{ id: 'test1', strategy: 'first-available', members: ['grok/grok-4.7', 'grok/grok-4.6'] }], settings: {} }), update: async () => {} }, new ProviderRegistry([provider]))
  await service.usage('grok')
  const events = []
  for await (const event of service.stream({ model: 'pool/test1', messages: [{ role: 'user', content: 'ping' }] })) events.push(event)
  assert.equal(events.some((event) => event.type === 'error' && /catch is not a function/.test(event.text)), false)
  assert.equal(events.at(-1)?.status, 401)
})

test('pool skips a model whose window is smaller than the filled request', async () => {
  const small = new BaseProvider('grok', 'Grok')
  const wide = new BaseProvider('codex', 'Codex')
  small.listModels = async () => [{ id: 'small', contextWindow: 8000 }]
  wide.listModels = async () => [{ id: 'wide', contextWindow: 200000 }]
  const seen = []
  small.stream = async function* (request) { seen.push(request.model); yield { type: 'text', text: 'no' } }
  wide.stream = async function* (request) { seen.push(request.model); yield { type: 'text', text: 'yes' } }
  const service = new GatewayService({
    read: async () => ({ pools: [{ id: 'test1', strategy: 'first-available', members: ['grok/small', 'codex/wide'] }], settings: {} }),
    update: async () => {},
  }, new ProviderRegistry([small, wide]))
  const events = []
  for await (const event of service.stream({ model: 'pool/test1', messages: [{ role: 'user', content: 'x'.repeat(80_000) }] })) events.push(event)
  assert.deepEqual(seen, ['wide'])
  assert.equal(events.find((event) => event.type === 'text')?.text, 'yes')
})

test('pool switches to the next model when the first is at capacity', async () => {
  let grokCalls = 0
  const grok = new BaseProvider('grok', 'Grok')
  const codex = new BaseProvider('codex', 'Codex')
  grok.stream = async function* () {
    grokCalls += 1
    yield { type: 'error', text: 'The model is currently at capacity due to high demand.', status: 503, code: 'provider_error' }
  }
  codex.stream = async function* () {
    yield { type: 'text', text: 'pong' }
    yield { type: 'done', finishReason: 'stop' }
  }
  const recorded = []
  const service = new GatewayService({
    read: async () => ({ pools: [{ id: 'test1', strategy: 'first-available', members: ['grok/grok-4.7', 'codex/gpt-5.6-sol'] }], settings: {} }),
    update: async (change) => {
      const state = { requests: [], settings: {} }
      await change(state)
      recorded.push(state.requests[0])
    },
  }, new ProviderRegistry([grok, codex]))
  const first = []
  for await (const event of service.stream({ model: 'pool/test1', messages: [{ role: 'user', content: 'ping' }] })) first.push(event)
  assert.equal(first.some((event) => event.type === 'error'), false)
  assert.equal(first.find((event) => event.type === 'text')?.text, 'pong')
  assert.equal(recorded[0].status, 'error')
  assert.match(recorded.at(-1).model, /codex\/gpt-5\.6-sol/)
  const second = []
  for await (const event of service.stream({ model: 'pool/test1', messages: [{ role: 'user', content: 'ping' }] })) second.push(event)
  assert.equal(grokCalls, 1)
  assert.equal(second.find((event) => event.type === 'text')?.text, 'pong')
})

function complexityService(settings, models) {
  const seen = []
  const grok = new BaseProvider('grok', 'Grok')
  const codex = new BaseProvider('codex', 'Codex')
  grok.stream = async function* (request) { seen.push(request.model); yield { type: 'text', text: request.model } }
  codex.stream = async function* (request) { seen.push(request.model); yield { type: 'text', text: request.model } }
  const state = {
    pools: [{ id: 'smart', strategy: 'by-complexity', classifier: 'heuristic', members: ['grok/mini', 'codex/sonnet', 'codex/opus'] }],
    settings: { complexity: { heuristic: { enabled: true, mediumAt: 1, heavyAt: 3 }, llm: { enabled: false, model: '', timeoutMs: 1500 } }, modelTiers: { 'grok/mini': 'light', 'codex/sonnet': 'medium', 'codex/opus': 'heavy' }, ...settings },
  }
  const service = new GatewayService({ read: async () => state, update: async () => {} }, new ProviderRegistry([grok, codex]))
  return { service, seen, models }
}

test('complexity pool routes to the tier and climbs to a neighbour', async () => {
  const { service, seen } = complexityService()
  const events = async (messages) => {
    const out = []
    for await (const event of service.stream({ model: 'pool/smart', messages, promptCacheKey: 'chat' })) out.push(event)
    return out
  }
  const light = await events([{ role: 'user', content: 'Привет' }])
  assert.equal(light.find((event) => event.type === 'text')?.text, 'mini')
  const heavy = await events([{ role: 'user', content: 'Спроектируй архитектуру очереди с учётом гонки и deadlock, докажи корректность' }])
  assert.equal(heavy.find((event) => event.type === 'text')?.text, 'opus')
  assert.deepEqual(seen, ['mini', 'opus'])
  const state = await service.store.read()
  state.settings.modelTiers = { 'grok/mini': 'light', 'codex/sonnet': 'medium' }
  const climbed = await events([{ role: 'user', content: 'Спроектируй архитектуру очереди с учётом гонки и deadlock, докажи корректность' }])
  assert.equal(climbed.find((event) => event.type === 'text')?.text, 'sonnet')
})

test('tool cycle stays on the sticky model even when the next request looks trivial', async () => {
  const { service } = complexityService()
  const run = async (messages, promptCacheKey = 'agent') => {
    const out = []
    for await (const event of service.stream({ model: 'pool/smart', messages, promptCacheKey })) out.push(event)
    return out.find((event) => event.type === 'text')?.text
  }
  assert.equal(await run([{ role: 'user', content: 'Спроектируй архитектуру очереди с учётом гонки и deadlock, докажи корректность' }]), 'opus')
  assert.equal(await run([{ role: 'user', content: 'Спроектируй' }, { role: 'tool', content: 'ok' }]), 'opus')
  // в том же диалоге уровень не понижается, в новом — да
  assert.equal(await run([{ role: 'user', content: 'Привет' }]), 'opus')
  assert.equal(await run([{ role: 'user', content: 'Привет' }], 'other'), 'mini')
})

test('llm classifier timeout falls back to heuristics', async () => {
  const grok = new BaseProvider('grok', 'Grok')
  const codex = new BaseProvider('codex', 'Codex')
  grok.stream = (request) => request.model === 'judge'
    ? new Promise(() => {})
    : (async function* () { yield { type: 'text', text: 'mini' } })()
  codex.stream = async function* () { yield { type: 'text', text: 'opus' } }
  const service = new GatewayService({
    read: async () => ({
      pools: [{ id: 'smart', strategy: 'by-complexity', classifier: 'llm', members: ['grok/mini', 'codex/opus'] }],
      settings: { complexity: { heuristic: { enabled: true, mediumAt: 1, heavyAt: 3 }, llm: { enabled: true, model: 'grok/judge', timeoutMs: 300 } }, modelTiers: { 'grok/mini': 'light', 'codex/opus': 'heavy' } },
    }),
    update: async () => {},
  }, new ProviderRegistry([grok, codex]))
  const out = []
  for await (const event of service.stream({ model: 'pool/smart', messages: [{ role: 'user', content: 'Привет' }] })) out.push(event)
  assert.equal(out.find((event) => event.type === 'text')?.text, 'mini')
})

test('complexity pool fails over inside the same tier on quota and skips the model afterwards', async () => {
  const seen = []
  const grok = new BaseProvider('grok', 'Grok')
  const codex = new BaseProvider('codex', 'Codex')
  grok.stream = async function* (request) {
    seen.push(request.model)
    if (request.model === 'opus-a') yield { type: 'error', text: 'Grok: HTTP 429: usage limit reached', status: 429, code: 'rate_limit' }
    else yield { type: 'text', text: request.model }
  }
  codex.stream = async function* (request) { seen.push(request.model); yield { type: 'text', text: request.model } }
  const recorded = []
  const service = new GatewayService({
    read: async () => ({
      pools: [{ id: 'smart', strategy: 'by-complexity', classifier: 'heuristic', members: ['grok/opus-a', 'codex/sonnet', 'codex/opus-b'] }],
      settings: { complexity: { heuristic: { enabled: true, mediumAt: 1, heavyAt: 3 }, llm: { enabled: false, model: '', timeoutMs: 1500 } }, modelTiers: { 'grok/opus-a': 'heavy', 'codex/sonnet': 'medium', 'codex/opus-b': 'heavy' } },
    }),
    update: async (change) => {
      const state = { requests: [], settings: {} }
      await change(state)
      recorded.push(state.requests[0])
    },
  }, new ProviderRegistry([grok, codex]))
  const run = async () => {
    const out = []
    for await (const event of service.stream({ model: 'pool/smart', messages: [{ role: 'user', content: 'Спроектируй архитектуру очереди с учётом гонки и deadlock, докажи корректность' }], complexityOverride: 'heavy' })) out.push(event)
    return out
  }
  const first = await run()
  assert.equal(first.some((event) => event.type === 'error'), false)
  assert.equal(first.find((event) => event.type === 'text')?.text, 'opus-b')
  assert.match(recorded.at(-1).model, /замена: grok\/opus-a: лимит/)
  const second = await run()
  assert.equal(second.find((event) => event.type === 'text')?.text, 'opus-b')
  assert.deepEqual(seen, ['opus-a', 'opus-b', 'opus-b'])
})

test('bad request is not retried on another pool model', async () => {
  const seen = []
  const grok = new BaseProvider('grok', 'Grok')
  grok.stream = async function* (request) { seen.push(request.model); yield { type: 'error', text: 'bad tool schema', status: 400, code: 'invalid_request' } }
  const service = new GatewayService({
    read: async () => ({ pools: [{ id: 'p', strategy: 'first-available', members: ['grok/a', 'grok/b'] }], settings: {} }),
    update: async () => {},
  }, new ProviderRegistry([grok]))
  const out = []
  for await (const event of service.stream({ model: 'pool/p', messages: [{ role: 'user', content: 'hi' }] })) out.push(event)
  assert.equal(out.at(-1).status, 400)
  assert.deepEqual(seen, ['a'])
})

test('model tiers POST can also pick the classifier model', async () => {
  let state = { settings: { complexity: { heuristic: { enabled: true, mediumAt: 1, heavyAt: 3 } } } }
  const service = new GatewayService({
    read: async () => state,
    update: async (change) => { await change(state); return state },
  }, new ProviderRegistry([new BaseProvider('claude', 'Claude')]))
  const saved = await service.setModelTiers({ 'claude/haiku': 'light' }, 'claude/haiku')
  assert.equal(saved.tiers['claude/haiku'], 'light')
  assert.equal(saved.complexity.llm.model, 'claude/haiku')
  assert.equal(saved.complexity.llm.enabled, true)
  assert.deepEqual(saved.complexity.classifiers, ['heuristic', 'llm', 'auto'])
})

test('x-complexity overrides the classifier', async () => {
  const { service } = complexityService()
  const out = []
  for await (const event of service.stream({ model: 'pool/smart', messages: [{ role: 'user', content: 'Привет' }], complexityOverride: 'heavy' })) out.push(event)
  assert.equal(out.find((event) => event.type === 'text')?.text, 'opus')
})

test('model tiers are readable with the api key and writable with the settings key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub-to-api-'))
  const store = new Store(join(directory, 'state.json'))
  await store.ensureApiKey()
  await store.update((state) => { state.settings.settingsKey = 'secret-settings' })
  const grok = new BaseProvider('grok', 'Grok')
  grok.listModels = async () => [{ id: 'mini', name: 'Mini', contextWindow: 8000 }]
  const service = new GatewayService(store, new ProviderRegistry([grok]))
  const server = createAppServer(service, store, { host: '127.0.0.1', port: 8787, configuredPort: 8787, settingsKey: 'secret-settings', settingsKeyScope: 'localhost' })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const key = (await store.read()).settings.apiKey
  try {
    assert.equal((await fetch(`${base}/v1/model-tiers`)).status, 401)
    const read = await fetch(`${base}/v1/model-tiers`, { headers: { authorization: `Bearer ${key}` } })
    const body = await read.json()
    assert.equal(body.models[0].id, 'grok/mini')
    assert.equal(body.models[0].tierSet, false)
    assert.match(body.instructions, /POST \{BASE\}\/api\/model-tiers/)
    const bad = await fetch(`${base}/api/model-tiers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-settings-key': 'secret-settings' }, body: JSON.stringify({ tiers: { 'grok/mini': 'ultra' } }) })
    assert.equal(bad.status, 400)
    const saved = await fetch(`${base}/api/model-tiers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-settings-key': 'secret-settings' }, body: JSON.stringify({ tiers: { 'grok/mini': 'light' } }) })
    assert.equal((await saved.json()).tiers['grok/mini'], 'light')
    const again = await (await fetch(`${base}/v1/model-tiers`, { headers: { authorization: `Bearer ${key}` } })).json()
    assert.equal(again.models[0].tier, 'light')
    assert.equal(again.models[0].tierSet, true)
  } finally {
    server.close()
  }
})

test('usage keeps cache reads and writes apart from fresh input', async () => {
  const completion = await collectChatCompletion('claude/test', [{ type: 'text', text: 'ok' }, { type: 'usage', inputTokens: 10, outputTokens: 4, cacheReadTokens: 7, cacheWriteTokens: 2 }, { type: 'done', finishReason: 'stop' }])
  assert.equal(completion.usage.prompt_tokens, 10)
  assert.deepEqual(completion.usage.prompt_tokens_details, { cached_tokens: 7, cache_write_tokens: 2 })
})

test('local API requires its own key and records provider requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub-to-api-'))
  const store = new Store(join(directory, 'state.json'))
  await store.ensureApiKey()
  const registry = new ProviderRegistry([new BaseProvider('grok', 'Grok')])
  const service = new GatewayService(store, registry)
  const server = createAppServer(service, store)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const key = (await store.read()).settings.apiKey

  const denied = await fetch(`${base}/v1/models`)
  assert.equal(denied.status, 401)

  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
  assert.equal(models.status, 200)
  assert.deepEqual((await models.json()).data, [])

  const completion = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok/test', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(completion.status, 401)

  const overview = await fetch(`${base}/api/overview`)
  const payload = await overview.json()
  assert.equal(payload.requests.length, 1)
  assert.equal(payload.requests[0].status, 'error')
  assert.equal(payload.settings.saveFullRequest, false)
  const journal = await fetch(`${base}/api/journal`)
  assert.equal(journal.status, 200)
  assert.equal((await journal.json()).requests[0].id, payload.requests[0].id)

  await store.update((state) => { state.settings.enabledModels = { grok: [] } })
  const hidden = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
  assert.deepEqual((await hidden.json()).data, [])

  const image = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '   ' }),
  })
  assert.equal(image.status, 400)
  server.close()
})

test('journal names the API key and skips the label when no key was sent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub-to-api-'))
  const store = new Store(join(directory, 'state.json'))
  await store.update((state) => {
    state.settings.apiKeyScope = 'localhost'
    state.settings.apiKeys = [{ id: 'a', label: 'Дом', key: 'one' }, { id: 'b', label: 'Ноут', key: 'two' }]
    state.settings.apiKey = 'one'
  })
  const service = new GatewayService(store, new ProviderRegistry([new BaseProvider('grok', 'Grok')]))
  const server = createAppServer(service, store)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const chat = (key) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok/test', messages: [{ role: 'user', content: 'hello' }] }),
  })
  try {
    assert.equal((await chat('two')).status, 401)
    const named = await (await fetch(`${base}/api/journal`)).json()
    assert.equal(named.requests[0].keyLabel, 'Ноут')
    await store.update((state) => { state.settings.apiKeyScope = 'none' })
    assert.equal((await chat()).status, 401)
    const open = await (await fetch(`${base}/api/journal`)).json()
    assert.equal(open.requests[0].keyLabel, undefined)
    assert.equal(open.requests[1].keyLabel, 'Ноут')
  } finally {
    server.close()
  }
})
