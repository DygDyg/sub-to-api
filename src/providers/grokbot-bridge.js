import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TOKEN_PATHS = ['/inference-token', '/sand-box/inference-credential']

export function desktopStatusPath(env = process.env) {
  const root = env.APPDATA
  return root ? join(root, 'Grok Bot', 'desktop-status.json') : ''
}

export async function localInferenceBridge(options = {}) {
  const readStatus = options.readStatus ?? readDesktopStatus
  const processAlive = options.processAlive ?? pidAlive
  const listenPorts = options.listenPorts ?? portsOf
  const requestToken = options.requestToken ?? requestLocalToken
  const status = await readStatus().catch(() => undefined)
  const pid = Number(status?.pid)
  if (!status?.signedIn || !Number.isInteger(pid) || pid <= 0) return undefined
  if (!await processAlive(pid)) return undefined
  for (const port of await listenPorts(pid).catch(() => [])) {
    const token = await requestToken(port).catch(() => undefined)
    if (token?.token) return { token: token.token, expiresAt: token.expiresAt || Date.now() + 10 * 60_000, port }
  }
  return undefined
}

export async function readDesktopStatus() {
  const path = desktopStatusPath()
  if (!path) return undefined
  return JSON.parse(await readFile(path, 'utf8'))
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function portsOf(pid) {
  if (process.platform !== 'win32') return []
  const pids = new Set([Number(pid), ...await childPids(pid)])
  const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 5000 })
  const ports = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line)
    if (!match || !pids.has(Number(match[2]))) continue
    const port = Number(match[1])
    if (port > 0 && port < 65536) ports.push(port)
  }
  return [...new Set(ports)]
}

async function childPids(pid) {
  const safe = Number(pid)
  if (!Number.isInteger(safe) || safe <= 0) return []
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${safe} } | Select-Object -ExpandProperty ProcessId`,
  ], { windowsHide: true, timeout: 5000 })
  return stdout.split(/\s+/).map(Number).filter((value) => Number.isInteger(value) && value > 0)
}

export async function requestLocalToken(port, fetchImpl = fetch) {
  for (const path of TOKEN_PATHS) {
    const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) continue
    const payload = await response.json().catch(() => ({}))
    const token = payload.grokBotToken || payload.accessToken || payload.token
    if (typeof token === 'string' && token) return { token, expiresAt: Date.parse(payload.expiresAt) || undefined }
  }
  return undefined
}
