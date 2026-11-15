import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Updater, compareVersions, parseSums, pickAssets } from '../src/update.js'

function release(tag, assets = []) {
  return {
    tag_name: tag,
    body: 'notes',
    html_url: `https://github.com/DygDyg/sub-to-api/releases/tag/${tag}`,
    published_at: '2026-11-15T00:00:00Z',
    assets,
  }
}

const zipAsset = (version) => ({ name: `SubToAPI-${version}-win-x64.zip`, browser_download_url: `https://example.test/${version}.zip`, size: 10 })
const sumsAsset = { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.test/SHA256SUMS.txt' }

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('versions compare by numbers and prereleases are older', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('0.3.0', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareVersions('dev', '0.0.1'), -1)
})

test('release assets and checksum list are recognised', () => {
  const { archive, sums } = pickAssets(release('v0.3.0', [{ name: 'other.txt' }, zipAsset('0.3.0'), sumsAsset]))
  assert.equal(archive.name, 'SubToAPI-0.3.0-win-x64.zip')
  assert.equal(sums.name, 'SHA256SUMS.txt')
  const hash = 'a'.repeat(64)
  const list = parseSums(`${hash}  SubToAPI-0.3.0-win-x64.zip\r\n${'B'.repeat(64)} *other.zip\nbroken line\n`)
  assert.equal(list.get('SubToAPI-0.3.0-win-x64.zip'), hash)
  assert.equal(list.get('other.zip'), 'b'.repeat(64))
  assert.equal(list.size, 2)
})

test('updater reports a newer release and caches the check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-to-api-update-'))
  let calls = 0
  const updater = new Updater({
    dir,
    appDir: dir,
    currentVersion: '0.2.1',
    supported: true,
    fetch: async (url) => {
      calls += 1
      assert.match(String(url), /\/repos\/DygDyg\/sub-to-api\/releases\/latest$/)
      return jsonResponse(200, release('v0.3.0', [zipAsset('0.3.0'), sumsAsset]))
    },
  })
  const status = await updater.check({ force: true })
  assert.equal(status.available, true)
  assert.equal(status.latest, '0.3.0')
  assert.equal(status.current, '0.2.1')
  await updater.check()
  assert.equal(calls, 1, 'repeated checks within the cooldown reuse the cache')
  const saved = JSON.parse(await readFile(join(dir, 'update.json'), 'utf8'))
  assert.equal(saved.release.version, '0.3.0')

  const reloaded = new Updater({ dir, appDir: dir, currentVersion: '0.3.0', supported: true, fetch: async () => { throw new Error('no network') } })
  assert.equal((await reloaded.status()).available, false, 'the same version is not offered again')
})

test('release without the portable archive is not offered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-to-api-update-'))
  const updater = new Updater({ dir, appDir: dir, currentVersion: '0.2.1', supported: true, fetch: async () => jsonResponse(200, release('v0.3.0')) })
  assert.equal((await updater.check({ force: true })).available, false)
})

test('network and rate-limit errors are reported without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-to-api-update-'))
  const offline = new Updater({ dir, appDir: dir, currentVersion: '0.2.1', supported: true, fetch: async () => { throw new TypeError('fetch failed') } })
  const status = await offline.check({ force: true })
  assert.equal(status.state, 'error')
  assert.equal(status.available, false)
  assert.match(status.error, /fetch failed/)

  const limited = new Updater({ dir, appDir: dir, currentVersion: '0.2.1', supported: true, fetch: async () => jsonResponse(403, {}) })
  assert.match((await limited.check({ force: true })).error, /ограничил/)
})

test('install is refused outside the portable build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-to-api-update-'))
  const updater = new Updater({ dir, currentVersion: '0.2.1', supported: false, fetch: async () => jsonResponse(200, release('v0.3.0')) })
  await assert.rejects(updater.install({ pid: 1, port: 1, exit: () => undefined }), /портативной сборке/)
})

test('install refuses an archive with a wrong checksum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sub-to-api-update-'))
  let exited = false
  const updater = new Updater({
    dir,
    appDir: dir,
    currentVersion: '0.2.1',
    supported: true,
    fetch: async (url) => {
      const href = String(url)
      if (href.includes('/releases/latest')) return jsonResponse(200, release('v0.3.0', [zipAsset('0.3.0'), sumsAsset]))
      if (href.endsWith('SHA256SUMS.txt')) return new Response(`${'0'.repeat(64)}  SubToAPI-0.3.0-win-x64.zip\n`)
      return new Response('not a zip')
    },
  })
  await assert.rejects(updater.install({ pid: 1, port: 1, exit: () => { exited = true } }), /Контрольная сумма/)
  assert.equal(exited, false)
  assert.equal((await updater.status()).state, 'error')
})
