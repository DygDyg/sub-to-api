import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { isSea } from 'node:sea'

function applicationRoot() {
  if (isSea()) return dirname(process.execPath)
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

export const APP_DIR = process.env.SUB_TO_API_HOME || join(applicationRoot(), 'settings')
export const STORE_PATH = join(APP_DIR, 'state.json')
export const LAST_REQUEST_PATH = join(APP_DIR, 'last-request.txt')
const LEGACY_STORE = join(homedir(), '.sub-to-api', 'state.json')

const EMPTY = {
  version: 1,
  settings: {
    host: '127.0.0.1',
    port: 8787,
    exposure: 'localhost',
    authMode: 'required',
    remoteSettings: false,
    settingsExposure: 'localhost',
    settingsKey: '',
    settingsKeyScope: 'internet',
    apiKey: '',
    apiKeyScope: 'localhost',
    apiKeys: [],
    requestLogLimit: 200,
    logPrompts: false,
    saveFullRequest: false,
    updateCheck: true,
    enabledModels: {},
    complexity: {
      heuristic: { enabled: false, mediumAt: 1, heavyAt: 3 },
      llm: { enabled: false, model: '', timeoutMs: 1500 },
    },
    modelTiers: {},
    proxy: { enabled: false, url: '' },
    providerProxies: {},
    customProviders: [],
  },
  accounts: {},
  requests: [],
  usageStats: { totals: [], recent: [] },
}

export class Store {
  /** @type {Promise<void>} */
  #lock = Promise.resolve()

  /** @param {string} [path] */
  constructor(path = STORE_PATH) {
    this.path = path
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      const settings = { ...EMPTY.settings, ...(parsed.settings ?? {}) }
      settings.complexity = {
        heuristic: { ...EMPTY.settings.complexity.heuristic, ...(parsed.settings?.complexity?.heuristic ?? {}) },
        llm: { ...EMPTY.settings.complexity.llm, ...(parsed.settings?.complexity?.llm ?? {}) },
      }
      if (!settings.modelTiers || typeof settings.modelTiers !== 'object') settings.modelTiers = {}
      const proxy = parsed.settings?.proxy
      settings.proxy = { enabled: Boolean(proxy?.enabled), url: typeof proxy?.url === 'string' ? proxy.url : '' }
      const perProvider = parsed.settings?.providerProxies
      settings.providerProxies = perProvider && typeof perProvider === 'object' && !Array.isArray(perProvider)
        ? Object.fromEntries(Object.entries(perProvider).filter(([, value]) => typeof value === 'string' && value.trim()))
        : {}
      settings.customProviders = Array.isArray(parsed.settings?.customProviders)
        ? parsed.settings.customProviders.filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
        : []
      if (parsed.settings?.settingsExposure === undefined && parsed.settings?.remoteSettings) settings.settingsExposure = 'lan'
      if (parsed.settings?.apiKeyScope === undefined) settings.apiKeyScope = parsed.settings?.authMode === 'optional' ? 'none' : 'localhost'
      return {
        ...EMPTY,
        ...parsed,
        settings,
        accounts: parsed.accounts ?? {},
        requests: Array.isArray(parsed.requests) ? parsed.requests : [],
        usageStats: {
          totals: Array.isArray(parsed.usageStats?.totals) ? parsed.usageStats.totals : [],
          recent: Array.isArray(parsed.usageStats?.recent) ? parsed.usageStats.recent : [],
        },
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      if (this.path === STORE_PATH && existsSync(LEGACY_STORE)) {
        await mkdir(dirname(this.path), { recursive: true })
        await copyFile(LEGACY_STORE, this.path)
        return this.read()
      }
      return structuredClone(EMPTY)
    }
  }

  /** @param {(state: any) => void | Promise<void>} mutate */
  async update(mutate) {
    const run = this.#lock.then(async () => {
      const state = await this.read()
      await mutate(state)
      await this.#write(state)
      return state
    })
    this.#lock = run.then(() => undefined, () => undefined)
    return run
  }

  async ensureApiKey() {
    return this.update(async (state) => {
      if (!state.settings.apiKey && !state.settings.apiKeys?.some((item) => item?.key)) {
        const key = `sta_${randomUUID().replaceAll('-', '')}`
        state.settings.apiKey = key
        state.settings.apiKeys = [{ id: randomUUID(), label: 'Основной', key }]
      }
    }).then((state) => state.settings.apiKey || state.settings.apiKeys?.find((item) => item?.key)?.key || '')
  }

  async #write(state) {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    await rename(temporary, this.path)
    await chmod(this.path, 0o600).catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
