import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStats, recordUsage } from '../src/stats.js'

test('stats keep key totals apart and do not stretch one key to the whole limit', () => {
  const now = 1_000_000_000_000
  const resetsAt = now + 60_000
  let stats = recordUsage(undefined, { model: 'codex/a', provider: 'codex', keyLabel: 'Дом', input: 100, output: 0 }, now)
  stats = recordUsage(stats, { model: 'codex/b', provider: 'codex', keyLabel: 'Ноут', input: 250, output: 50 }, now)
  const providers = [{ id: 'codex', usage: { supported: true, windows: [{ kind: 'session', usedPercent: 40, resetsAt }] } }]
  const all = buildStats(stats, providers, { now })
  assert.equal(all.models.find((model) => model.model === 'codex/a').total, 100)
  assert.equal(all.models.find((model) => model.model === 'codex/b').total, 300)
  assert.equal(all.models.find((model) => model.model === 'codex/a').windows[0].percent, 10)
  assert.equal(all.models.find((model) => model.model === 'codex/b').windows[0].percent, 30)
  const home = buildStats(stats, providers, { now, key: 'Дом' })
  assert.deepEqual(home.models.map((model) => model.model), ['codex/a'])
  assert.equal(home.models[0].input, 100)
  assert.equal(home.models[0].windows[0].percent, 10)
  assert.ok(home.models[0].windows[0].percent <= 40)
  assert.deepEqual(buildStats(stats, [{ id: 'codex', usage: { supported: false, windows: [] } }], { now }).models[0].windows, [])
})

test('stats keep cache reads and writes inside input and survive old rows', () => {
  const now = 1_000_000_000_000
  let stats = recordUsage(undefined, { model: 'codex/a', provider: 'codex', keyLabel: '', input: 100, output: 10, cacheRead: 80, cacheWrite: 5 }, now)
  stats = recordUsage(stats, { model: 'codex/a', provider: 'codex', keyLabel: '', input: 40, output: 0, cacheRead: 10, cacheWrite: 0 }, now)
  stats.totals.push({ model: 'codex/old', provider: 'codex', keyLabel: '', input: 20, output: 5, requests: 1 })
  const models = buildStats(stats, [], { now }).models
  const current = models.find((model) => model.model === 'codex/a')
  assert.equal(current.input, 140)
  assert.equal(current.cacheRead, 90)
  assert.equal(current.cacheWrite, 5)
  assert.equal(current.total, 150)
  const old = models.find((model) => model.model === 'codex/old')
  assert.equal(old.cacheRead, 0)
  assert.equal(old.cacheWrite, 0)
})