import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
import { APP_VERSION } from './version.js'

export const UPDATE_REPO = 'DygDyg/sub-to-api'
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
export const FIRST_CHECK_DELAY_MS = 30_000
const MIN_RECHECK_MS = 10 * 60 * 1000
const ASSET_PATTERN = /^SubToAPI-.+-win-x64\.zip$/
const SUMS_NAME = 'SHA256SUMS.txt'
const PACKAGE_FILES = ['sub-to-api.exe', 'tray.ps1', 'update.ps1']

/** Разбирает версию вида 1.2.3 или v1.2.3. Пре-релизы возвращают prerelease = true. */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(String(value ?? '').trim())
  if (!match) return undefined
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: Boolean(match[4]) }
}

/** @returns {number} -1, 0 или 1; некорректная версия считается самой старой. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] > right.parts[index] ? 1 : -1
  }
  if (left.prerelease === right.prerelease) return 0
  return left.prerelease ? -1 : 1
}

export function pickAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  return {
    archive: assets.find((asset) => ASSET_PATTERN.test(asset?.name ?? '')),
    sums: assets.find((asset) => asset?.name === SUMS_NAME),
  }
}

/** Разбирает вывод sha256sum: «<hex>  <имя>» или «<hex> *<имя>». */
export function parseSums(text) {
  const result = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (match) result.set(match[2], match[1].toLowerCase())
  }
  return result
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export class Updater {
  /**
   * @param {{
   *   dir: string,
   *   appDir?: string,
   *   currentVersion?: string,
   *   repo?: string,
   *   supported?: boolean,
   *   fetch?: typeof fetch,
   *   enabled?: () => Promise<boolean>,
   *   launchArgs?: string[],
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.dir = options.dir
    this.appDir = options.appDir ?? (isSea() ? dirname(process.execPath) : undefined)
    this.currentVersion = options.currentVersion ?? APP_VERSION
    this.repo = options.repo ?? UPDATE_REPO
    this.supported = options.supported ?? isSea()
    this.fetch = options.fetch ?? globalThis.fetch
    this.enabled = options.enabled ?? (async () => true)
    /** Флаги запуска, с которыми приложение перезапустится после обновления. */
    this.launchArgs = options.launchArgs ?? []
    this.now = options.now ?? Date.now
    this.cachePath = join(this.dir, 'update.json')
    this.workDir = join(this.dir, 'update')
    /** @type {'idle' | 'checking' | 'downloading' | 'installing' | 'error'} */
    this.state = 'idle'
    this.error = ''
    this.release = undefined
    this.checkedAt = 0
    this.loaded = false
    this.checking = undefined
    this.timer = undefined
  }

  async #load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const saved = JSON.parse(await readFile(this.cachePath, 'utf8'))
      this.checkedAt = Number(saved.checkedAt) || 0
      this.release = saved.release
    } catch { /* нет кеша — проверим заново */ }
  }

  async #save() {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.cachePath, JSON.stringify({ checkedAt: this.checkedAt, release: this.release }, null, 2))
  }

  async status() {
    await this.#load()
    const latest = this.release?.version
    return {
      supported: this.supported,
      current: this.currentVersion,
      latest: latest ?? null,
      available: Boolean(latest && compareVersions(latest, this.currentVersion) > 0 && this.release?.archive),
      notes: this.release?.notes ?? '',
      url: this.release?.url ?? `https://github.com/${this.repo}/releases`,
      publishedAt: this.release?.publishedAt ?? null,
      checkedAt: this.checkedAt || null,
      state: this.state,
      error: this.error,
    }
  }

  /** @param {{ force?: boolean }} [options] */
  async check({ force = false } = {}) {
    await this.#load()
    if (!force && this.checkedAt && this.now() - this.checkedAt < MIN_RECHECK_MS) return this.status()
    if (this.checking) return this.checking
    this.checking = this.#check().finally(() => { this.checking = undefined })
    return this.checking
  }

  async #check() {
    if (this.state === 'downloading' || this.state === 'installing') return this.status()
    this.state = 'checking'
    try {
      const response = await this.fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `sub-to-api/${this.currentVersion}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 404) throw new Error('Релизы не найдены')
      if (response.status === 403 || response.status === 429) throw new Error('GitHub ограничил число запросов, попробуйте позже')
      if (!response.ok) throw new Error(`GitHub ответил ${response.status}`)
      const release = await response.json()
      const version = String(release.tag_name ?? '').replace(/^v/, '')
      if (!parseVersion(version)) throw new Error(`Непонятная версия релиза: ${release.tag_name}`)
      const { archive, sums } = pickAssets(release)
      this.release = {
        version,
        tag: release.tag_name,
        notes: String(release.body ?? '').slice(0, 4000),
        url: release.html_url,
        publishedAt: release.published_at,
        prerelease: Boolean(release.prerelease),
        archive: archive ? { name: archive.name, url: archive.browser_download_url, size: archive.size, digest: archive.digest } : undefined,
        sums: sums ? { name: sums.name, url: sums.browser_download_url } : undefined,
      }
      this.error = ''
      this.state = 'idle'
    } catch (error) {
      this.error = error instanceof Error ? (error.name === 'TimeoutError' ? 'GitHub не ответил' : error.message) : String(error)
      this.state = 'error'
    }
    this.checkedAt = this.now()
    await this.#save().catch(() => undefined)
    return this.status()
  }

  /** Фоновая проверка: первая через 30 с, дальше раз в 6 ч. */
  start() {
    if (!this.supported || this.timer) return
    const tick = async () => {
      try {
        if (await this.enabled()) await this.check()
      } catch { /* фоновая проверка не должна ронять сервер */ }
    }
    const first = setTimeout(() => {
      tick()
      this.timer = setInterval(tick, CHECK_INTERVAL_MS)
      this.timer.unref?.()
    }, FIRST_CHECK_DELAY_MS)
    first.unref?.()
    this.timer = first
  }

  stop() {
    clearTimeout(this.timer)
    clearInterval(this.timer)
    this.timer = undefined
  }

  async #download(url, accept = 'application/octet-stream') {
    const response = await this.fetch(url, {
      headers: { accept, 'user-agent': `sub-to-api/${this.currentVersion}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(5 * 60_000),
    })
    if (!response.ok) throw new Error(`Не удалось скачать ${url}: ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  async #expectedHash(archive, sums) {
    if (sums?.url) {
      const list = parseSums((await this.#download(sums.url, 'text/plain')).toString('utf8'))
      const hash = list.get(archive.name)
      if (hash) return hash
    }
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(archive.digest ?? '')
    if (digest) return digest[1].toLowerCase()
    throw new Error('В релизе нет контрольной суммы архива')
  }

  /**
   * Скачивает и распаковывает релиз, затем запускает update.ps1 и вызывает exit().
   * @param {{ pid: number, port: number, exit: () => void | Promise<void> }} options
   */
  async install({ pid, port, exit }) {
    if (!this.supported) throw Object.assign(new Error('Обновление работает только в портативной сборке'), { status: 400 })
    if (this.state === 'downloading' || this.state === 'installing') throw Object.assign(new Error('Обновление уже идёт'), { status: 409 })
    const status = await this.check()
    if (!status.available) throw Object.assign(new Error(status.error || 'Новой версии нет'), { status: 409 })
    const { archive, sums } = this.release
    this.state = 'downloading'
    this.error = ''
    try {
      await rm(this.workDir, { recursive: true, force: true })
      await mkdir(this.workDir, { recursive: true })
      const expected = await this.#expectedHash(archive, sums)
      const bytes = await this.#download(archive.url)
      const actual = sha256(bytes)
      if (actual !== expected) throw new Error('Контрольная сумма архива не совпала')
      const zip = join(this.workDir, archive.name)
      await writeFile(zip, bytes)
      const extractDir = join(this.workDir, 'extract')
      await mkdir(extractDir, { recursive: true })
      const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      const unpacked = spawnSync(existsSync(tar) ? tar : 'tar.exe', ['-xf', zip, '-C', extractDir], { windowsHide: true })
      if (unpacked.status !== 0) throw new Error(`Не удалось распаковать архив: ${unpacked.stderr?.toString() || unpacked.status}`)
      const source = join(extractDir, 'SubToAPI')
      for (const name of PACKAGE_FILES) {
        if (!existsSync(join(source, name))) throw new Error(`В архиве нет ${name}`)
      }
      // Скрипт запускается из папки update, чтобы копирование не трогало исполняемый файл скрипта.
      const script = join(this.workDir, 'update.ps1')
      await copyFile(join(source, 'update.ps1'), script)
      this.state = 'installing'
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const child = spawn(existsSync(powershell) ? powershell : 'powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
        '-ServerPid', String(pid),
        '-Source', source,
        '-Target', this.appDir,
        '-Port', String(port),
        '-Settings', this.dir,
        ...(this.launchArgs.length ? ['-AppArgs', this.launchArgs.join(' ')] : []),
      ], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      setTimeout(() => { Promise.resolve(exit()).catch(() => process.exit(0)) }, 300).unref?.()
      return { ok: true, version: this.release.version }
    } catch (error) {
      this.state = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      throw Object.assign(new Error(this.error), { status: 500 })
    }
  }
}
