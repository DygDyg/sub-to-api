import test from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletionToCanonical, collectChatCompletion, writeChatStream } from '../src/openai/translate.js'
import { codexResponsesBody, reasoningFor, responsesBody, ResponsesStreamTranslator, streamResponses, toResponsesInput } from '../src/providers/responses.js'

const readTool = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }

test('Responses input keeps every function call, its output, and assistant text', () => {
  const resolved = toResponsesInput({
    model: 'grok-4',
    messages: [
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'read both' },
      {
        role: 'assistant',
        content: 'opening both',
        toolCalls: [
          { id: 'call-a', name: 'read_file', arguments: '{"path":"a"}' },
          { id: 'call-b', name: 'read_file', arguments: '{"path":"b"}' },
        ],
        reasoningByCallId: { 'call-a': [{ id: 'rs_1', status: 'completed', summary: [{ type: 'summary_text', text: 'plan' }], encrypted_content: 'enc' }] },
      },
      { role: 'tool', toolCallId: 'call-a', content: 'alpha' },
      { role: 'tool', toolCallId: 'call-b', content: 'beta' },
    ],
  })
  assert.equal(resolved.instructions, 'be precise')
  assert.deepEqual(resolved.input.map((item) => item.type), ['message', 'message', 'reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output'])
  assert.deepEqual(resolved.input.filter((item) => item.type === 'function_call').map((item) => item.call_id), ['call-a', 'call-b'])
  assert.equal(resolved.input[1].content[0].text, 'opening both')
  assert.equal(resolved.input[2].encrypted_content, 'enc')
  assert.equal(resolved.input.at(-1).output, 'beta')
})

test('tool result without a call id is rejected', () => {
  assert.throws(() => toResponsesInput({ model: 'grok-4', messages: [{ role: 'tool', content: 'x' }] }), /call id/)
})

test('Grok body sends tools; Codex opts out of strict and asks for encrypted reasoning', () => {
  const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [readTool], reasoningEffort: 'high', promptCacheKey: 'thread-1' }
  const grok = responsesBody(request)
  assert.equal(grok.tools[0].strict, undefined)
  assert.equal(grok.tool_choice, 'auto')
  assert.equal(grok.parallel_tool_calls, true)
  assert.equal(grok.include, undefined)
  assert.deepEqual(grok.reasoning, { effort: 'high' })
  const codex = codexResponsesBody(request)
  assert.equal(codex.tools[0].strict, false)
  assert.deepEqual(codex.include, ['reasoning.encrypted_content'])
  assert.equal(codex.instructions, 'You are a helpful coding assistant.')
  assert.equal(responsesBody({ model: 'm', messages: [] }).tools, undefined)
})

test('SSE function_call events finish as tool_calls and keep empty-args fallback', () => {
  const translator = new ResponsesStreamTranslator()
  const opened = translator.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'read_file' } })
  const delta = translator.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' })
  translator.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_2', call_id: 'call-b', name: 'read_file' } })
  const done = translator.push({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_2', call_id: 'call-b', name: 'read_file', arguments: '{"path":"b"}' } })
  const finished = translator.push({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 1 } } } })
  assert.equal(opened[0].id, 'call-a')
  assert.equal(delta[0].arguments, '{"path":')
  assert.equal(done[0].arguments, '{"path":"b"}')
  assert.equal(finished.at(-1).finishReason, 'tool_calls')
  assert.equal(finished[0].cacheReadTokens, 1)
  assert.deepEqual(translator.push({ type: 'response.output_text.delta', delta: 'late' }), [])
})

test('reasoning that arrives before the function call is replayed on the next turn', () => {
  const translator = new ResponsesStreamTranslator()
  assert.deepEqual(translator.push({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', status: 'completed', encrypted_content: 'enc' } }), [])
  const opened = translator.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'read_file' } })
  translator.push({ type: 'response.completed', response: {} })
  assert.equal(opened[1].item.encrypted_content, 'enc')
  assert.equal(reasoningFor('call-a')[0].id, 'rs_1')
  const next = toResponsesInput({
    model: 'grok-4',
    messages: [{ role: 'assistant', toolCalls: [{ id: 'call-a', name: 'read_file', arguments: '{}' }, { id: 'call-b', name: 'read_file', arguments: '{}' }] }],
  })
  assert.equal(next.input.filter((item) => item.type === 'reasoning').length, 1)
  assert.equal(next.input[0].encrypted_content, 'enc')
  assert.deepEqual(next.input.slice(1).map((item) => item.call_id), ['call-a', 'call-b'])
})

test('plain Responses completion still finishes with stop', () => {
  const translator = new ResponsesStreamTranslator()
  translator.push({ type: 'response.output_text.delta', delta: 'ok' })
  const finished = translator.push({ type: 'response.completed', response: {} })
  assert.equal(finished.at(-1).finishReason, 'stop')
})

test('streamResponses reads event and data lines and stops at completed', async () => {
  const body = [
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call-a","name":"read_file"}}',
    '',
    'event: response.function_call_arguments.delta',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{}"}',
    '',
    'data: {"type":"response.completed","response":{}}',
    '',
    'data: {"type":"response.output_text.delta","delta":"ignored"}',
    '',
  ].join('\n')
  const events = []
  for await (const event of streamResponses(new Response(body).body)) events.push(event)
  assert.deepEqual(events.filter((event) => event.type === 'tool_call').map((event) => event.id), ['call-a', 'call-a'])
  assert.equal(events.at(-1).finishReason, 'tool_calls')
})

test('chat completion round-trips tool calls and reasoning replay for the next turn', async () => {
  const canonical = chatCompletionToCanonical({
    model: 'grok/test',
    messages: [{
      role: 'assistant',
      tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      reasoning_items: [{ call_id: 'call-a', id: 'rs_1', status: 'completed', encrypted_content: 'enc' }],
    }],
  })
  assert.equal(canonical.messages[0].reasoningByCallId['call-a'][0].encrypted_content, 'enc')
  const collected = await collectChatCompletion('grok/test', (async function* () {
    yield { type: 'tool_call', id: 'call-a', name: 'read_file', arguments: '{}' }
    yield { type: 'reasoning_replay', id: 'call-a', item: { id: 'rs_1', encrypted_content: 'enc' } }
    yield { type: 'done', finishReason: 'tool_calls' }
  })())
  assert.equal(collected.choices[0].finish_reason, 'tool_calls')
  assert.equal(collected.choices[0].message.reasoning_items[0].call_id, 'call-a')

  let output = ''
  await writeChatStream({ writeHead() {}, write(value) { output += value }, end(value) { output += value } }, 'grok/test', (async function* () {
    yield { type: 'tool_call', id: 'call-a', name: 'read_file', arguments: '' }
    yield { type: 'tool_call', id: 'call-b', name: 'read_file', arguments: '{}' }
    yield { type: 'reasoning_replay', id: 'call-a', item: { encrypted_content: 'enc' } }
    yield { type: 'done', finishReason: 'tool_calls' }
  })())
  const chunks = output.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)))
  assert.deepEqual(chunks.slice(0, 2).map((chunk) => chunk.choices[0].delta.tool_calls[0].index), [0, 1])
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
  assert.equal(chunks.at(-1).choices[0].delta.reasoning_items[0].encrypted_content, 'enc')
})
