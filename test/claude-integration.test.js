import test from 'node:test'
import assert from 'node:assert/strict'
import { OAuthAttempt } from '../src/auth/oauth.js'
import { writeChatStream } from '../src/openai/translate.js'

test('manual OAuth rejects incorrect state without consuming attempt', async () => {
  const attempt = await new OAuthAttempt({ callbackPath: '/callback', ports: [0], buildAuthorizeUrl: () => 'https://example.com' }).start()
  try {
    assert.throws(() => attempt.manual(`${attempt.redirectUri}?code=secret&state=wrong`), /state/)
    attempt.manual(`${attempt.redirectUri}?code=good&state=${attempt.state}`)
    assert.equal((await attempt.done).code, 'good')
  } finally { attempt.cancel() }
})

async function render(events) {
  let output = ''
  const response = { writeHead() {}, write(value) { output += value }, end(value) { output += value } }
  await writeChatStream(response, 'claude/test', (async function* () { yield* events })())
  return output.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
}

test('OpenAI stream assigns stable separate tool indexes and finish reason', async () => {
  const chunks = await render([
    { type: 'tool_call', id: 'a', name: 'one', arguments: '' },
    { type: 'tool_call', id: 'b', name: 'two', arguments: '' },
    { type: 'tool_call', id: 'a', arguments: '{}' },
    { type: 'done', finishReason: 'tool_calls' },
  ])
  assert.deepEqual(chunks.slice(0, 3).map(c => c.choices[0].delta.tool_calls[0].index), [0, 1, 0])
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
  assert.equal((await render([{ type: 'done', finishReason: 'length' }]))[0].choices[0].finish_reason, 'length')
})

test('OpenAI stream does not report success after provider failure', async () => {
  const chunks = await render([{ type: 'error', text: 'failed' }])
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].error.message, 'failed')
})
