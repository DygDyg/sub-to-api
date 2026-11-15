import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseMember, estimateTokens, fitsContext, normalizePool, remainingPercent } from '../src/pools.js'

test('pool keeps a cached conversation on the same model while quota remains', () => {
  const remaining = (member) => member === 'grok/a' ? 40 : 80
  assert.equal(chooseMember({ members: ['grok/a', 'codex/b'], strategy: 'most-remaining', sticky: 'grok/a', remaining }), 'grok/a')
  assert.equal(chooseMember({ members: ['grok/a', 'codex/b'], strategy: 'most-remaining', remaining }), 'codex/b')
})

test('exhausted model is skipped and an unknown quota stays available', () => {
  const remaining = (member) => member === 'grok/a' ? 2 : null
  assert.equal(chooseMember({ members: ['grok/a', 'codex/b'], strategy: 'first-available', remaining }), 'codex/b')
  assert.equal(chooseMember({ members: ['grok/a'], strategy: 'most-remaining', remaining }), undefined)
  assert.equal(remainingPercent({ supported: true, windows: [{ usedPercent: 20 }, { usedPercent: 70 }] }), 30)
})

test('filled request is measured from its text, not from the model limit', () => {
  const short = estimateTokens({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 200000 })
  assert.ok(short < 100)
  assert.equal(fitsContext(8000, short), true)
  const filled = estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(80_000) }], tools: [{ name: 'lookup', description: 'find', parameters: { type: 'object' } }] })
  assert.ok(filled > 20_000)
  assert.ok(filled < 200_000)
  assert.equal(fitsContext(8000, filled), false)
  assert.equal(fitsContext(200000, filled), true)
  assert.equal(fitsContext(undefined, filled), true)
})

test('pool name and members are validated', () => {
  const pool = normalizePool({ id: 'Fast Chat', members: ['codex/b', 'grok/a', 'codex/b'] })
  assert.equal(pool.id, 'fast-chat')
  assert.deepEqual(pool.members, ['codex/b', 'grok/a'])
  assert.throws(() => normalizePool({ id: 'fast', members: ['grok/a'] }), /две модели/)
})
