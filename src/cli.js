import { spawn } from 'node:child_process'
import { existsSync, openSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSea } from 'node:sea'
import { hostFor, normalizeExposure, normalizeSettingsKeyScope, settingsExposureOf, widerExposure } from './network.js'
import { clearRuntime, writeRuntime } from './runtime.js'
import { APP_DIR, Store } from './storage/store.js'
import { ProviderRegistry } from './gateway/registry.js'
import { GatewayService } from './gateway/service.js'
import { createAppServer } from './http/server.js'
import { CodexProvider } from './providers/codex.js'
import { ClaudeProvider } from './providers/claude.js'
import { GrokProvider } from './providers/grok.js'
import { CopilotProvider } from './providers/copilot.js'
import { AntigravityProvider } from './providers/antigravity.js'

async function main() {
  const store = new Store()
  await store.ensureApiKey()
  const state = await store.read()
  const exposure = normalizeExposure(process.env.SUB_TO_API_EXPOSURE || state.settings.exposure)
  const settingsExposure = settingsExposureOf(state.settings)
  const host = process.env.SUB_TO_API_HOST || hostFor(widerExposure(exposure, settingsExposure))
  const configuredPort = Number(process.env.SUB_TO_API_PORT || state.settings.port || 8787)
  const registry = new ProviderRegistry([
    new CodexProvider(store),
    new ClaudeProvider(store),
    new GrokProvider(store),
    new CopilotProvider(store),
    new AntigravityProvider(store),
  ])
  const service = new GatewayService(store, registry)
  const runtime = {
    host,
    port: configuredPort,
    configuredPort,
    exposure,
    settingsExposure,
    settingsKey: state.settings.settingsKey || '',
    settingsKeyScope: normalizeSettingsKeyScope(state.settings.settingsKeyScope),
  }
  let tray
  const server = createAppServer(service, store, runtime, {
    rebind: async ({ port, host: nextHost, exposure: nextExposure }) => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      runtime.host = nextHost
      runtime.exposure = nextExposure
      runtime.port = await listen(server, port, nextHost)
      tray?.kill()
      tray = startTray(runtime.port)
      await writeRuntime({ pid: process.pid, trayPid: tray?.pid, host: runtime.host, port: runtime.port, configuredPort: port })
      console.log(`SubToAPI: http://127.0.0.1:${runtime.port}`)
    },
  })

  runtime.port = await listen(server, configuredPort, host)
  if (runtime.port !== configuredPort) {
    console.error(`Порт ${configuredPort} занят. Сервер запущен на ${runtime.port}; смените порт в настройках.`)
  }
  console.log(`SubToAPI: http://${host}:${runtime.port}`)
  console.log('OpenAI base URL: /v1')

  tray = startTray(runtime.port)
  await writeRuntime({ pid: process.pid, trayPid: tray?.pid, host, port: runtime.port, configuredPort })
  const shutdown = async () => {
    tray?.kill()
    await clearRuntime()
    server.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('error', onError)
      if (error?.code !== 'EADDRINUSE') reject(error)
      else server.listen(0, host, () => resolve(server.address().port))
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      resolve(port)
    })
  })
}

function startTray(port) {
  if (process.env.SUB_TO_API_NO_TRAY === '1' || process.platform !== 'win32' || isSea()) return undefined
  const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/tray.ps1')
  if (!existsSync(script)) return undefined
  const logDir = APP_DIR
  mkdirSync(logDir, { recursive: true })
  const log = openSync(join(logDir, 'tray.log'), 'a')
  return spawn('powershell.exe', [
    '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Port', String(port), '-ServerPid', String(process.pid),
  ], { windowsHide: true, stdio: ['ignore', log, log] })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
