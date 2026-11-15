import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const APP_DIR = process.env.SUB_TO_API_HOME || join(root, 'settings')
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
    requestLogLimit: 200,
    logPrompts: false,
    saveFullRequest: false,
    enabledModels: {},
  },
  accounts: {},
  requests: [],
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
      if (parsed.settings?.settingsExposure === undefined && parsed.settings?.remoteSettings) settings.settingsExposure = 'lan'
      return {
        ...EMPTY,
        ...parsed,
        settings,
        accounts: parsed.accounts ?? {},
        requests: Array.isArray(parsed.requests) ? parsed.requests : [],
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
      if (!state.settings.apiKey) state.settings.apiKey = `sta_${randomUUID().replaceAll('-', '')}`
    }).then((state) => state.settings.apiKey)
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
