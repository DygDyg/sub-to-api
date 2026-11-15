import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexProvider } from '../src/providers/codex.js'

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

test('Codex usage reads reset_at as unix seconds and falls back to reset_after_seconds', async () => {
  const resetAt = 1_794_000_000
  const provider = new CodexProvider({ async read() { return { accounts: { codex: { default: 'a', accounts: { a: { accessToken: 'token', accountId: 'acc', expiresAt: Date.now() + 3_600_000 } } } } } } })
  provider.fetch = undefined
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.match(String(url), /wham\/usage/)
    return json({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 32, reset_at: resetAt },
        secondary_window: { used_percent: 73, reset_after_seconds: 7200 },
      },
    })
  }
  try {
    const before = Date.now()
    const usage = await provider.usage()
    assert.equal(usage.plan, 'plus')
    assert.equal(usage.windows[0].kind, 'session')
    assert.equal(usage.windows[0].resetsAt, resetAt * 1000)
    assert.equal(usage.windows[1].kind, 'weekly')
    assert.ok(usage.windows[1].resetsAt >= before + 7_200_000 - 1000)
    assert.ok(usage.windows[1].resetsAt <= Date.now() + 7_200_000 + 1000)
  } finally {
    globalThis.fetch = original
  }
})
