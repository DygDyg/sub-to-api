import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { CustomApiProvider, anthropicBody, normalizeCustomProvider, streamOpenAI } from '../src/providers/custom.js'
import { detectCustomUsage } from '../src/providers/custom-usage.js'
import { Store } from '../src/storage/store.js'
import { ProviderRegistry } from '../src/gateway/registry.js'
import { GatewayService } from '../src/gateway/service.js'

function sse(chunks) {
  const encoder = new TextEncoder()
  const parts = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).concat('data: [DONE]\n\n')
  return new ReadableStream({
    pull(controller) {
      const next = parts.shift()
      if (next === undefined) controller.close()
      else controller.enqueue(encoder.encode(next))
    },
  })
}

test('normalizeCustomProvider validates and keeps the stored key when masked', () => {
  const config = normalizeCustomProvider({ id: 'OpenRouter', label: ' OpenRouter ', baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-secret', headers: '{"HTTP-Referer":"https://x"}', models: 'a\nb,a' })
  assert.equal(config.id, 'openrouter')
  assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1')
  assert.deepEqual(config.models, ['a', 'b'])
  assert.deepEqual(config.headers, { 'HTTP-Referer': 'https://x' })
  const kept = normalizeCustomProvider({ ...config, apiKey: 'sk-s…cret' }, config)
  assert.equal(kept.apiKey, 'sk-secret')
  const disabled = normalizeCustomProvider({ ...config, enabled: false }, config)
  assert.equal(normalizeCustomProvider({ ...disabled, enabled: undefined }, disabled).enabled, false)
  assert.throws(() => normalizeCustomProvider({ id: 'claude', baseUrl: 'https://x' }), /занят/)
  assert.throws(() => normalizeCustomProvider({ id: 'ok', baseUrl: 'ftp://x' }), /http/)
})

test('OpenAI stream yields text, accumulated tool calls and usage', async () => {
  const events = []
  for await (const event of streamOpenAI(sse([
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
    { usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } } },
  ]))) events.push(event)
  assert.deepEqual(events.map((event) => event.type), ['text', 'reasoning', 'tool_call', 'usage', 'done'])
  assert.equal(events[2].arguments, '{"q":"x"}')
  assert.equal(events[3].cacheReadTokens, 1)
  assert.equal(events[4].finishReason, 'tool_calls')
})

test('OpenAI stream surfaces a provider error chunk', async () => {
  await assert.rejects(async () => {
    for await (const _ of streamOpenAI(sse([{ error: { message: 'no credit', type: 'insufficient_quota' } }]))) { /* drain */ }
  }, (error) => error.message === 'no credit' && error.code === 'insufficient_quota')
})

test('anthropic body drops the Claude Code identity block', () => {
  const body = anthropicBody({ model: 'claude-x', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] })
  assert.equal(body.system.length, 1)
  assert.equal(body.system[0].text, 'be brief')
  assert.equal(body.stream, true)
})

test('custom provider merges discovered and manual models and streams Anthropic', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'm1', context_length: 8000 }, { name: 'm2' }] })
    return new Response(sse([
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]), { headers: { 'content-type': 'text/event-stream' } })
  }
  const provider = new CustomApiProvider(null, normalizeCustomProvider({ id: 'mine', protocol: 'anthropic', baseUrl: 'https://api.example/v1', apiKey: 'k', models: ['manual'] }), { fetch })
  const models = await provider.listModels()
  assert.deepEqual(models.map((model) => model.id), ['m1', 'm2', 'manual'])
  assert.equal(models[0].contextWindow, 8000)
  const events = []
  for await (const event of provider.stream({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] })) events.push(event)
  assert.equal(events.at(-1).type, 'done')
  assert.equal(calls[1].init.headers['x-api-key'], 'k')
  assert.equal(calls[1].init.headers['anthropic-version'], '2023-06-01')
  assert.equal(JSON.parse(calls[1].init.body).model, 'm1')
})

test('custom provider falls back to the manual list when discovery fails', async () => {
  const provider = new CustomApiProvider(null, normalizeCustomProvider({ id: 'mine', baseUrl: 'http://127.0.0.1:9', models: ['only'] }), { fetch: async () => { throw new Error('down') } })
  assert.deepEqual((await provider.listModels()).map((model) => model.id), ['only'])
  const empty = new CustomApiProvider(null, normalizeCustomProvider({ id: 'mine', baseUrl: 'http://127.0.0.1:9' }), { fetch: async () => { throw new Error('down') } })
  await assert.rejects(() => empty.listModels(), /down/)
})

test('custom providers survive a settings roundtrip and route by id', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'custom-')), 'state.json'))
  const service = new GatewayService(store, new ProviderRegistry([]))
  const saved = await service.saveCustomProvider({ id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1', models: ['deepseek-chat'], usageMode: 'anymodel' })
  assert.equal(saved.apiKey.includes('…'), true)
  await service.reloadCustom()
  const adapter = service.registry.get('deepseek')
  assert.equal(adapter.protocol, 'openai')
  assert.equal((await adapter.listAccounts())[0].isDefault, true)
  assert.equal(service.registry.resolve('deepseek/deepseek-chat').model, 'deepseek-chat')
  const overview = await service.overview()
  assert.equal(overview.providers.some((provider) => provider.custom && provider.id === 'deepseek'), true)
  await service.deleteCustomProvider('deepseek')
  assert.throws(() => service.registry.get('deepseek'), /Unknown provider/)
})

test('Anymodel usage is detected, parsed and falls back from balance to key', async () => {
  const calls = []
  const provider = new CustomApiProvider(null, normalizeCustomProvider({ id: 'any', baseUrl: 'https://any.example/v1', apiKey: 'sk-secret', usageMode: 'anymodel' }), {
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization })
      if (url.endsWith('/balance')) return new Response('{}', { status: 404 })
      return jsonResponse({ data: { name: 'test', token_limit: 100_000_000, used: 402_540, remaining: 99_597_460 } })
    },
  })
  const detected = await detectCustomUsage(provider)
  assert.equal(detected.mode, 'anymodel')
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), ['balance', 'key'])
  assert.equal(calls[0].authorization, 'Bearer sk-secret')
  const window = detected.snapshot.windows[0]
  assert.equal(window.limit, 100_000_000)
  assert.equal(window.remaining, 99_597_460)
  assert.equal(Math.round(window.usedPercent * 1000) / 1000, 0.403)

  const unknown = new CustomApiProvider(null, normalizeCustomProvider({ id: 'unknown', baseUrl: 'https://unknown.example/v1' }), { fetch: async () => jsonResponse({ data: { balance: 10 } }) })
  assert.equal((await detectCustomUsage(unknown)).mode, '')
  assert.equal((await unknown.usage()).supported, false)
})

test('Neural API usage merges the dollar limit and cent usage into tokens', async () => {
  const calls = []
  const provider = new CustomApiProvider(null, normalizeCustomProvider({ id: 'neural', baseUrl: 'https://neural-api.ru/v1', apiKey: 'sk-secret' }), {
    fetch: async (url) => {
      calls.push(url)
      if (url.endsWith('/balance') || url.endsWith('/key')) return new Response('{}', { status: 404 })
      if (url.endsWith('/subscription')) return jsonResponse({ object: 'billing_subscription', soft_limit_usd: 70, hard_limit_usd: 70, system_hard_limit_usd: 70, access_until: 0 })
      if (url.endsWith('/usage')) return jsonResponse({ object: 'list', total_usage: 250 })
      return new Response('{}', { status: 404 })
    },
  })
  const detected = await detectCustomUsage(provider)
  assert.equal(detected.mode, 'neural')
  assert.equal(detected.label, 'Neural API')
  const window = detected.snapshot.windows[0]
  assert.equal(window.limit, 35_000_000)
  assert.equal(window.used, 1_250_000)
  assert.equal(window.remaining, 33_750_000)
  assert.equal(window.unit, 'токенов')

  const fork = new CustomApiProvider(null, normalizeCustomProvider({ id: 'fork', baseUrl: 'https://fork.example/v1', usageMode: 'neural' }), {
    fetch: async (url) => url.endsWith('/subscription')
      ? jsonResponse({ soft_limit_usd: 10, hard_limit_usd: 12, system_hard_limit_usd: 12 })
      : jsonResponse({ total_usage: 500 }),
  })
  const mixed = (await fork.usage()).windows[0]
  assert.equal(mixed.remaining, 5_000_000)
  assert.equal(mixed.used, 2_500_000)
  assert.equal(mixed.limit, 7_500_000)
  assert.ok(calls.some((url) => url.endsWith('/dashboard/billing/subscription')))
})

test('custom provider auto-detects and saves usage mode without exposing the key', async () => {
  const authorizations = []
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/models') response.end(JSON.stringify({ data: [{ id: 'm1' }] }))
    else if (request.url === '/v1/balance') response.end(JSON.stringify({ data: { token_limit: 1000, used: 250, remaining: 750 } }))
    else { response.statusCode = 404; response.end('{}') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'custom-usage-')), 'state.json'))
    const service = new GatewayService(store, new ProviderRegistry([]))
    const input = { id: 'metered', label: 'Metered', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'sk-test-secret' }
    const saved = await service.saveCustomProvider(input)
    assert.equal(saved.usageMode, 'anymodel')
    assert.equal(JSON.stringify(saved).includes('sk-test-secret'), false)
    assert.equal((await service.usage('metered')).windows[0].remaining, 750)

    const checked = await service.testCustomProvider({ ...input, originalId: 'metered' })
    assert.equal(checked.ok, true)
    assert.equal(checked.usageMode, 'anymodel')
    assert.equal(checked.usage.windows[0].usedPercent, 25)
    assert.equal(authorizations.every((value) => value === 'Bearer sk-test-secret'), true)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}
