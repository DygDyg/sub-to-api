import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { priceEstimate } from '../src/pricing.js'
import { GrokBotProvider, agentRequest, composeAgentPrompt, grokBotRoute, replyAfter, visibleGrokBotModels } from '../src/providers/grokbot.js'
import { localInferenceBridge } from '../src/providers/grokbot-bridge.js'
import {
  cursorChecksum,
  encodeInferenceFrame,
  errorTrailer,
  eventsFromInference,
  inspectInferenceRequest,
  loginChallenge,
  loginUrl,
  streamInference,
  textFrame,
  toolFrame,
  usageFrame,
} from '../src/providers/grokbot-connect.js'

const readTool = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }

test('login challenge hashes the verifier string, matching the desktop client', () => {
  const verifier = Buffer.from('verifier-bytes').toString('base64url')
  assert.equal(loginChallenge(verifier), createHash('sha256').update(verifier).digest('base64url'))
  assert.notEqual(loginChallenge(verifier), createHash('sha256').update(Buffer.from('verifier-bytes')).digest('base64url'))
})

test('Grok Bot login URL uses the desktop deep-control target', () => {
  const url = new URL(loginUrl('challenge', 'uuid-1'))
  assert.equal(url.origin, 'https://cursor.com')
  assert.equal(url.pathname, '/loginDeepControl')
  assert.equal(url.searchParams.get('redirectTarget'), 'sand')
  assert.equal(url.searchParams.get('challenge'), 'challenge')
  assert.equal(url.searchParams.get('mode'), 'login')
})

test('checksum is stable for one machine and does not include the token', () => {
  const now = 1_700_000_000_000
  assert.equal(cursorChecksum('machine', now), cursorChecksum('machine', now))
  assert.notEqual(cursorChecksum('machine', now), cursorChecksum('other', now))
  assert.match(cursorChecksum('machine', now), /machine$/)
})

test('inference request uses the live model fields and flattens rejected roles', () => {
  const body = encodeInferenceFrame({
    model: 'grok-4.6',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'read it' },
      { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }] },
      { role: 'tool', name: 'read_file', toolCallId: 'call-1', content: 'ok' },
    ],
    tools: [readTool],
  })
  const inspected = inspectInferenceRequest(body)
  assert.equal(inspected.modelId, 'grok-4.6')
  assert.deepEqual(inspected.texts, ['[SYSTEM]\nbe brief\nread it', 'read_file({"path":"a"})', 'TOOL_RESULT read_file: ok'])
  assert.equal(inspected.tools[0].name, 'read_file')
  assert.equal(inspected.tools[0].hasParameters, true)
})

test('inference frames become text, a native tool call, usage, and a hard error', async () => {
  const ok = Buffer.concat([
    textFrame('hello'),
    toolFrame({ id: 'call-1', name: 'read_file', args: '{"path":', complete: false }),
    toolFrame({ id: 'call-1', args: '"a"}', complete: true }),
    usageFrame({ input: 12, output: 3, cached: 4 }),
  ])
  const events = eventsFromInference(ok)
  assert.deepEqual(events.filter((event) => event.type === 'text'), [{ type: 'text', text: 'hello' }])
  assert.equal(events.find((event) => event.type === 'tool_call' && event.name)?.name, 'read_file')
  assert.equal(events.filter((event) => event.type === 'tool_call' && event.arguments).map((event) => event.arguments).join(''), '{"path":"a"}')
  assert.deepEqual(events.find((event) => event.type === 'usage'), { type: 'usage', inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 })
  assert.equal(events.at(-1).finishReason, 'tool_calls')

  const streamed = []
  for await (const event of streamInference(new Blob([ok]).stream())) streamed.push(event.type)
  assert.deepEqual(streamed, events.map((event) => event.type))

  const failed = eventsFromInference(Buffer.concat([textFrame('nope'), errorTrailer('weekly limit')]))
  assert.equal(failed.at(-1).type, 'error')
  assert.equal(failed.at(-1).text, 'resource_exhausted: weekly limit')
  assert.equal(failed.some((event) => event.type === 'done'), false)
})

test('agent replies ignore the user echo and keep only newer bot text', () => {
  const echo = Buffer.from(JSON.stringify({ kind: 'message', role: 'user', content: 'ping' })).toString('base64')
  const reply = Buffer.from(JSON.stringify({ kind: 'send-message', message: { type: 'text', content: 'ok' } })).toString('base64')
  assert.equal(composeAgentPrompt([{ role: 'system', content: 'brief' }, { role: 'user', content: 'ping' }]), '[SYSTEM]\nbrief\n\nping')
  assert.equal(replyAfter([
    { seq: '2', updatedSeq: '2', body: reply },
    { seq: '1', updatedSeq: '1', body: echo },
  ], 1n), 'ok')
})

test('Grok Bot catalog is the cloud bot unless a live bridge verified a direct model', () => {
  const cursor = [{ id: 'claude-opus' }, { id: 'grok-4.6' }, { id: 'gpt-5' }]
  assert.deepEqual(visibleGrokBotModels(cursor, false).map((model) => model.id), ['agent'])
  assert.deepEqual(visibleGrokBotModels(cursor, true).map((model) => model.id), ['agent', 'claude-opus', 'grok-4.6', 'gpt-5'])
  assert.deepEqual(visibleGrokBotModels([], false, [{ id: 'grok-4.6' }]).map((model) => model.id), ['agent', 'grok-4.6'])
  assert.equal(grokBotRoute('agent', undefined), 'agent')
  assert.equal(grokBotRoute('grok-4.6', undefined), 'unavailable')
  assert.equal(grokBotRoute('grok-4.6', { token: 'local' }), 'direct')
})

test('a repeated cache key sends only the new turn to the same bot session', () => {
  const first = agentRequest([
    { role: 'system', content: 'brief' },
    { role: 'user', content: 'remember this' },
  ], 'chat-1', {})
  const second = agentRequest([
    { role: 'system', content: 'brief' },
    { role: 'user', content: 'remember this' },
    { role: 'assistant', content: 'stored' },
    { role: 'user', content: 'next' },
  ], 'chat-1', { 'chat-1': first.sessionId })
  assert.equal(second.resume, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.prompt, 'next')
  assert.equal(second.prompt.includes('remember this'), false)
})

test('local bridge stays closed without a signed-in desktop process', async () => {
  assert.equal(await localInferenceBridge({
    readStatus: async () => ({ signedIn: false, pid: 1 }),
    processAlive: () => true,
    listenPorts: async () => [1340],
    requestToken: async () => ({ token: 'secret' }),
  }), undefined)
  assert.deepEqual(await localInferenceBridge({
    readStatus: async () => ({ signedIn: true, pid: 7 }),
    processAlive: () => true,
    listenPorts: async () => [1340],
    requestToken: async (port) => (port === 1340 ? { token: 'minted', expiresAt: 5 } : undefined),
  }), { token: 'minted', expiresAt: 5, port: 1340 })
})

test('Grok Bot stays disconnected until its own login and does not reuse the Grok price as a charge', async () => {
  const provider = new GrokBotProvider({ read: async () => ({ accounts: {} }), update: async () => {} })
  assert.deepEqual(await provider.listModels(), [])
  assert.equal((await provider.usage()).supported, false)
  const events = []
  for await (const event of provider.stream({ model: 'grok-4.6', messages: [{ role: 'user', content: 'hi' }] })) events.push(event)
  assert.equal(events[0].code, 'not_authenticated')
  assert.match(priceEstimate('grokbot/grok-4.6').title, /не списание подписки/)
})
