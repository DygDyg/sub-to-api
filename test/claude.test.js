import test from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeProvider } from '../src/providers/claude.js'
import { claudeRequest, streamClaude } from '../src/providers/claude-translate.js'

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
const session = (id = 'a') => ({ accountKey: id, accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 3600000 })
function store(accounts = { a: session() }) { const state = { accounts: { claude: { default: Object.keys(accounts)[0], accounts } } }; return { state, async read() { return state }, async update(fn) { fn(state) } } }
const collect = async iterable => { const result = []; for await (const event of iterable) result.push(event); return result }
const callback = { code: 'code', state: 'state', redirectUri: 'http://localhost:123/callback', pkce: { verifier: 'verifier' } }
const req = { model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }] }
function stream(events, fragment = 7) {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  let offset = 0; const stats = { cancelled: false }
  const body = new ReadableStream({ pull(controller) { if (offset === bytes.length) return controller.close(); controller.enqueue(bytes.slice(offset, offset += Math.min(fragment, bytes.length - offset))) }, cancel() { stats.cancelled = true } })
  return { body, stats }
}
const end = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }, { type: 'message_stop' }]

test('Claude OAuth spec and exchange send PKCE/state and store profile', async () => {
  const calls = []; const provider = new ClaudeProvider(store(), { fetch: async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }) : json({ account: { uuid: 'uuid', email_address: 'a@example.com' }, subscription_type: 'max' }) } })
  const spec = provider.oauthSpec(); const url = new URL(spec.buildAuthorizeUrl({ ...callback, pkce: { challenge: 'challenge' } }))
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('state'), 'state'); assert.equal(spec.host, 'localhost')
  const result = await provider.exchange(callback)
  assert.equal(result.accountId, 'uuid'); assert.equal(result.email, 'a@example.com'); assert.equal(result.plan, 'max')
  assert.equal(JSON.parse(calls[0].init.body).code_verifier, 'verifier'); assert.equal(JSON.parse(calls[0].init.body).state, 'state')
  assert.equal(calls[1].init.headers.authorization, 'Bearer access')
})

test('OAuth validates token payload strictly and does not reflect secret error bodies', async () => {
  for (const patch of [{ access_token: '' }, { refresh_token: '' }, { expires_in: 0 }, { expires_in: '3600' }, { expires_in: 1e100 }, { scope: '' }]) {
    const provider = new ClaudeProvider(store(), { fetch: async () => json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, ...patch }) })
    await assert.rejects(provider.exchange(callback), /Claude OAuth/)
  }
  const provider = new ClaudeProvider(store(), { fetch: async () => json({ error: 'invalid_grant', secret: 'DO_NOT_LEAK' }, 400) })
  await assert.rejects(provider.exchange(callback), error => error.code === 'invalid_grant' && !error.message.includes('DO_NOT_LEAK'))
  await assert.rejects(provider.exchange({}), /incomplete callback/)
})

test('refresh preserves omitted refresh token, rotates supplied token and profile failure is nonfatal', async () => {
  const provider = new ClaudeProvider(store(), { fetch: async url => url.endsWith('/profile') ? Promise.reject(new Error('offline')) : json({ access_token: 'new', expires_in: 3600 }) })
  const next = await provider.refresh(session()); assert.equal(next.refreshToken, 'refresh-a'); assert.equal(next.accessToken, 'new')
  provider.fetch = async url => url.endsWith('/profile') ? Promise.reject(new Error('offline')) : json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 })
  assert.equal((await provider.exchange(callback)).refreshToken, 'rotated')
})

test('refreshes are coalesced per account and not shared between accounts', async () => {
  const storage = store({ a: { ...session(), expiresAt: 0 }, b: { ...session('b'), expiresAt: 0 } }); let count = 0
  let release; const gate = new Promise(resolve => { release = resolve })
  const provider = new ClaudeProvider(storage, { fetch: async (_url, init) => { count++; await gate; return json({ access_token: `new-${JSON.parse(init.body).refresh_token}`, refresh_token: 'rotated', expires_in: 3600 }) } })
  const promises = [provider.session('a'), provider.session('a'), provider.session('b')]; await Promise.resolve(); await Promise.resolve(); release()
  const result = await Promise.all(promises); assert.equal(count, 2); assert.equal(result[0].accessToken, result[1].accessToken); assert.notEqual(result[0].accessToken, result[2].accessToken)
  assert.equal(storage.state.accounts.claude.accounts.a.refreshToken, 'rotated')
})

test('failed refresh clears in-flight state and a removed account is not resurrected', async () => {
  const storage = store({ a: { ...session(), expiresAt: 0 } }); let count = 0
  const provider = new ClaudeProvider(storage, { fetch: async () => { if (++count === 1) return json({ error: 'invalid_grant' }, 400); await provider.removeAccount('a'); return json({ access_token: 'new', expires_in: 3600 }) } })
  await assert.rejects(provider.session('a'), error => error.code === 'invalid_grant')
  await provider.session('a'); assert.equal(count, 2); assert.deepEqual(await provider.listAccounts(), [])
})

test('stale concurrent 401 uses already refreshed token without rotating again', async () => {
  const storage = store(); let calls = 0
  const provider = new ClaudeProvider(storage, { fetch: async () => { calls++; return json({ access_token: 'new', expires_in: 3600 }) } })
  await provider.session('a', true, 'access-a'); await provider.session('a', true, 'access-a'); assert.equal(calls, 1)
})

test('account-specific model discovery and modern/legacy usage', async () => {
  const auth = []; let modern = true
  const provider = new ClaudeProvider(store({ a: session(), b: session('b') }), { fetch: async (url, init) => {
    auth.push(init.headers.authorization)
    return url.includes('/models') ? json({ data: [{ id: 'opus', display_name: 'Opus', max_input_tokens: 1000000, capabilities: { effort: { supported: true, high: { supported: true } } } }] }) : json(modern ? { limits: [{ kind: 'weekly_scoped', percent: 25, resets_at: '2030-01-01T00:00:00Z', scope: { model: { display_name: 'Opus' } } }], seven_day_fable: { utilization: 3, resets_at: '2030-01-01T00:00:00Z' } } : { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } })
  } })
  const models = await provider.listModels('b'); assert.equal(models[0].contextWindow, 1000000); assert.deepEqual(models[0].efforts, ['high'])
  const usage = await provider.usage('b'); assert.equal(usage.windows[0].scope, 'Opus'); assert.equal(usage.windows[0].usedPercent, 25); assert.equal(usage.windows.filter((window) => window.scope === 'Opus').length, 1); assert.equal(usage.windows.at(-1).scope, 'Fable')
  modern = false; assert.equal((await provider.usage('b')).windows.length, 2); assert.ok(auth.every(value => value === 'Bearer access-b'))
  await assert.rejects(provider.listModels('missing'), error => error.status === 401)
  const empty = new ClaudeProvider(store({})); assert.deepEqual(await empty.listModels(), []); assert.equal((await empty.usage()).supported, false)
})

test('401 retry refreshes only rejected account once; HTTP errors stay errors', async () => {
  let requests = 0; let refreshes = 0
  const provider = new ClaudeProvider(store({ a: session(), b: session('b') }), { fetch: async (url, init) => {
    if (url.includes('/token')) { refreshes++; assert.equal(JSON.parse(init.body).refresh_token, 'refresh-b'); return json({ access_token: 'new-b', expires_in: 3600 }) }
    requests++; if (requests === 1) return json({}, 401)
    assert.equal(init.headers.authorization, 'Bearer new-b'); return json({ data: [] })
  } })
  await provider.listModels('b'); assert.equal(requests, 2); assert.equal(refreshes, 1)
  provider.fetch = async () => json({ error: { type: 'rate_limit_error' } }, 429)
  const events = await collect(provider.stream(req, 'b')); assert.equal(events[0].status, 429); assert.equal(events.length, 1)
})

test('request translation preserves system, tools, tool results and validates arguments', () => {
  const result = claudeRequest({ ...req, reasoningEffort: 'high', messages: [{ role: 'system', content: 'Rules' }, { role: 'assistant', toolCalls: [{ id: 'call', name: 'lookup', arguments: '{"x":1}' }] }, { role: 'tool', toolCallId: 'call', content: 'result' }], tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
  assert.equal(result.system[0].text, 'You are Claude Code, Anthropic\'s official CLI for Claude.'); assert.equal(result.system[1].text, 'Rules'); assert.deepEqual(result.system[1].cache_control, { type: 'ephemeral' }); assert.equal(result.system[0].cache_control, undefined); assert.deepEqual(result.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' }); assert.deepEqual(result.messages[0].content[0].input, { x: 1 }); assert.equal(result.messages[1].content[0].tool_use_id, 'call'); assert.equal(result.tools[0].input_schema.type, 'object')
  assert.equal(claudeRequest(req).system[0].text, result.system[0].text)
  assert.throws(() => claudeRequest({ ...req, maxTokens: 0 }), /maxTokens/)
  assert.throws(() => claudeRequest({ ...req, reasoningEffort: 'unsupported' }), /reasoning effort/)
  assert.throws(() => claudeRequest({ ...req, messages: [{ role: 'assistant', toolCalls: [{ arguments: 'broken' }] }] }), /arguments/)
})

test('fragmented UTF-8 SSE translates reasoning text multiple tools usage and stop', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'думаю' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Привет 🌍' } },
    ...[2, 3].flatMap(index => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call${index}`, name: 'lookup', input: {} } }, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"x":' } }, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '1}' } }, { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }, { type: 'message_stop' },
  ]
  const source = stream(events, 1); const output = await collect(streamClaude(source.body))
  assert.equal(output[0].text, 'думаю'); assert.equal(output[1].text, 'Привет 🌍'); assert.deepEqual(output.filter(e => e.type === 'tool_call').map(e => e.id), ['call2', 'call3'])
  assert.deepEqual(output.at(-2), { type: 'usage', inputTokens: 10, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 2 }); assert.equal(output.at(-1).finishReason, 'tool_calls'); assert.equal(source.body.locked, false)
})

test('provider sends upstream identity and translates length finish', async () => {
  const provider = new ClaudeProvider(store(), { fetch: async (_url, init) => { assert.match(init.headers['user-agent'], /^claude-cli\//); assert.equal(init.headers['x-app'], 'cli'); const body = JSON.parse(init.body); assert.equal(body.model, req.model); assert.match(body.system[0].text, /Claude Code/); return new Response(stream([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }]).body) } })
  assert.equal((await collect(provider.stream(req))).at(-1).finishReason, 'length')
})

test('stream errors, malformed data and truncation never emit success', async () => {
  for (const events of [[{ type: 'error', error: { type: 'overloaded_error', message: 'Busy' } }], [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }]]) {
    const source = stream(events); const provider = new ClaudeProvider(store(), { fetch: async () => new Response(source.body) }); const output = await collect(provider.stream(req)); assert.equal(output.at(-1).type, 'error'); assert.ok(!output.some(e => e.type === 'done')); assert.equal(source.body.locked, false)
  }
  await assert.rejects(collect(streamClaude(new Response('data: not-json\n\n').body)), /malformed/)
})

test('early consumer return cancels reader and abort interrupts pending read', async () => {
  const source = stream([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }, ...end], 256)
  const iterator = streamClaude(source.body); await iterator.next(); await iterator.return(); assert.equal(source.stats.cancelled, true); assert.equal(source.body.locked, false)
  const controller = new AbortController(); let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const promise = collect(streamClaude(body, controller.signal)); controller.abort(); await assert.rejects(promise); assert.equal(cancelled, true); assert.equal(body.locked, false)
})
