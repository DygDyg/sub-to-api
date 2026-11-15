import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CustomApiProvider, anthropicBody, normalizeCustomProvider, streamOpenAI } from '../src/providers/custom.js'
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
  const saved = await service.saveCustomProvider({ id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1', models: ['deepseek-chat'] })
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

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}
