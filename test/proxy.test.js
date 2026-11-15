import assert from 'node:assert/strict'
import test from 'node:test'
import { Socket, createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { dispatcherFor, fetchVia, normalizeProxyValue, parseProxy, proxyFor, testProxy } from '../src/proxy.js'

test('parseProxy accepts http and socks5 with credentials', () => {
  const http = parseProxy('host:8080')
  assert.equal(http.protocol, 'http:')
  assert.equal(http.port, 8080)
  const socks = parseProxy('socks5://user:p%40ss@10.0.0.1:1080')
  assert.equal(socks.socks, true)
  assert.equal(socks.username, 'user')
  assert.equal(socks.password, 'p@ss')
  assert.equal(socks.remoteDns, false)
  assert.equal(parseProxy('socks5h://127.0.0.1').remoteDns, true)
  assert.throws(() => parseProxy('ftp://host'), /http/)
  assert.equal(normalizeProxyValue(''), '')
  assert.equal(normalizeProxyValue('direct'), 'direct')
})

test('proxy selection prefers the provider override, then direct, then global', () => {
  const settings = { proxy: { enabled: true, url: 'http://global:8080' }, providerProxies: { grok: 'socks5://own:1080', claude: 'direct' } }
  assert.equal(proxyFor(settings, 'grok'), 'socks5://own:1080')
  assert.equal(proxyFor(settings, 'claude'), '')
  assert.equal(proxyFor(settings, 'codex'), 'http://global:8080')
  assert.equal(proxyFor({ proxy: { enabled: false, url: 'http://global:8080' } }, 'codex'), '')
})

test('socks5 proxy with auth carries the request', async () => {
  const origin = createHttpServer((request, response) => response.end(`socks:${request.url}`))
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
  let authed = false
  const proxy = createServer((socket) => {
    let stage = 0
    socket.on('data', (chunk) => {
      if (stage === 0) { stage = 1; socket.write(Buffer.from([5, 2])); return }
      if (stage === 1) {
        const userLength = chunk[1]
        const user = chunk.subarray(2, 2 + userLength).toString()
        const pass = chunk.subarray(3 + userLength, 3 + userLength + chunk[2 + userLength]).toString()
        authed = user === 'u' && pass === 'p'
        stage = 2
        socket.write(Buffer.from([1, authed ? 0 : 1]))
        return
      }
      if (stage === 2) {
        stage = 3
        socket.removeAllListeners('data')
        const host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`
        const port = chunk.readUInt16BE(8)
        const upstream = new Socket()
        upstream.connect(port, host, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      }
    })
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `socks5://u:p@127.0.0.1:${proxy.address().port}`
  try {
    const response = await fetchVia(proxyUrl, `http://127.0.0.1:${origin.address().port}/hello`, { signal: AbortSignal.timeout(5000) })
    assert.equal(await response.text(), 'socks:/hello')
    assert.equal(authed, true)
  } finally {
    await dispatcherFor(proxyUrl).close().catch(() => undefined)
    proxy.close()
    origin.closeAllConnections()
    origin.close()
  }
})

test('http proxy tunnels CONNECT and the request reaches the origin', async () => {
  const seen = []
  const origin = createHttpServer((request, response) => {
    seen.push(request.url)
    response.end(JSON.stringify({ ip: '203.0.113.7' }))
  })
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const port = origin.address().port
  const proxy = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      socket.removeAllListeners('data')
      const [requestLine] = buffer.subarray(0, headerEnd).toString().split('\r\n')
      const [method, target] = requestLine.split(' ')
      methods.push(method)
      const upstream = new Socket()
      if (method === 'CONNECT') {
        const [host, targetPort] = target.split(':')
        upstream.connect(Number(targetPort), host, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.write(buffer.subarray(headerEnd + 4))
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
      } else {
        const url = new URL(target)
        upstream.connect(Number(url.port), url.hostname, () => {
          upstream.write(buffer)
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
      }
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
    })
  })
  const methods = []
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  try {
    const dispatcher = dispatcherFor(proxyUrl)
    assert.equal(dispatcherFor(proxyUrl), dispatcher)
    const response = await fetchVia(proxyUrl, `http://127.0.0.1:${port}/models`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(seen.length, 1)
    assert.match(seen[0], /\/models$/)
    assert.ok(methods.length >= 1)
    const check = await testProxy(proxyUrl, { url: `http://127.0.0.1:${port}/ip`, timeoutMs: 5000 })
    assert.equal(check.ok, true)
    assert.equal(check.ip, '203.0.113.7')
  } finally {
    await dispatcherFor(proxyUrl).close().catch(() => undefined)
    proxy.close()
    origin.closeAllConnections()
    origin.close()
  }
})
