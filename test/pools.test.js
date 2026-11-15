import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseMember, estimateTokens, fitsContext, normalizePool, remainingPercent } from '../src/pools.js'
import { classifyHeuristic, enabledClassifiers, normalizeComplexity, parseTier, tierOf, tierOrder } from '../src/complexity.js'

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
  const smart = normalizePool({ id: 'smart', strategy: 'by-complexity', classifier: 'auto', members: ['grok/a', 'codex/b'] })
  assert.equal(smart.strategy, 'by-complexity')
  assert.equal(smart.classifier, 'auto')
  assert.equal(normalizePool({ id: 'smart', strategy: 'by-complexity', members: ['grok/a', 'codex/b'] }).classifier, 'heuristic')
  assert.equal(normalizePool({ id: 'smart', strategy: 'most-remaining', members: ['grok/a', 'codex/b'] }).classifier, undefined)
})

test('heuristic scores short chatter low and architecture high', () => {
  const light = classifyHeuristic({ messages: [{ role: 'user', content: 'Привет, как дела?' }] })
  assert.equal(light.tier, 'light')
  assert.ok(light.score < 1)
  const heavy = classifyHeuristic({ messages: [{ role: 'user', content: 'Спроектируй архитектуру очереди с учётом гонки и deadlock\n```js\nclass Queue {}\n```' }], reasoningEffort: 'high', tools: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}` })) })
  assert.equal(heavy.tier, 'heavy')
  assert.ok(heavy.score >= 3)
  assert.equal(classifyHeuristic({ messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }, { mediumAt: 5, heavyAt: 9 }).tier, 'light')
  assert.equal(parseTier('Уровень: Heavy.'), 'heavy')
  assert.equal(parseTier('не знаю'), undefined)
})

test('tiers fall back to medium and climb to neighbours', () => {
  assert.equal(tierOf({ 'grok/a': 'heavy' }, 'grok/a'), 'heavy')
  assert.equal(tierOf({}, 'grok/a'), 'medium')
  assert.equal(tierOf({ 'grok/a': 'ultra' }, 'grok/a'), 'medium')
  assert.deepEqual(tierOrder('light'), ['light', 'medium', 'heavy'])
  assert.deepEqual(tierOrder('heavy'), ['heavy', 'medium', 'light'])
  assert.deepEqual(tierOrder('unknown'), ['medium', 'heavy', 'light'])
})

test('complexity settings are validated and merged', () => {
  const saved = normalizeComplexity({ heuristic: { enabled: true, mediumAt: 2, heavyAt: 5 } }, undefined)
  assert.equal(saved.heuristic.enabled, true)
  assert.equal(saved.llm.timeoutMs, 1500)
  assert.deepEqual(enabledClassifiers({ complexity: saved }), ['heuristic'])
  assert.throws(() => normalizeComplexity({ llm: { enabled: true } }, saved), /выберите модель/)
  assert.throws(() => normalizeComplexity({ heuristic: { mediumAt: 4, heavyAt: 4 } }, saved), /больше порога medium/)
  assert.throws(() => normalizeComplexity({ llm: { timeoutMs: 10 } }, saved), /Таймаут/)
})
