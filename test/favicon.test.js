import assert from 'node:assert/strict'
import test from 'node:test'
import { faviconSite, faviconSource, loadFavicon } from '../src/http/favicon.js'

test('favicon site uses the root host without api prefix or path', () => {
  assert.equal(faviconSite('https://neural-api.ru/v1'), 'neural-api.ru')
  assert.equal(faviconSite('https://api.deepseek.com/v1/'), 'deepseek.com')
  assert.equal(faviconSite('https://192.168.1.5/v1'), '')
  assert.equal(faviconSite('not a url'), '')
})

test('favicon is fetched over https and cached in memory', async () => {
  const calls = []
  let fetched = 0
  const fetch = async (url) => {
    calls.push(url)
    fetched++
    return new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })
  }
  const first = await loadFavicon('neural-api.ru', fetch, 1_000)
  assert.equal(fetched, 1)
  assert.match(calls[0], /^https:\/\/t0\.gstatic\.com\//)
  assert.match(calls[0], /url=https%3A%2F%2Fneural-api\.ru/)
  assert.equal(first.type, 'image/png')
  assert.equal(first.bytes.length, 4)

  await loadFavicon('neural-api.ru', fetch, 1_000 + 60_000)
  assert.equal(fetched, 1)
  await loadFavicon('neural-api.ru', fetch, 1_000 + 25 * 60 * 60 * 1000)
  assert.equal(fetched, 2)
})

test('favicon rejects non-image answers', async () => {
  await assert.rejects(
    () => loadFavicon('neural-api.ru', async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })),
    /не изображение/,
  )
  assert.equal(faviconSource('neural-api.ru').startsWith('https://'), true)
})