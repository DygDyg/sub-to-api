const RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases?per_page=30'
export const CODEX_VERSION_FALLBACK = '0.170.0'
const FRESH_MS = 6 * 60 * 60 * 1000

/** Стабильная версия из тега rust-v0.170.0 или 0.170.0. Пре-релизы не подходят. */
export function codexVersion(tag) {
  const match = /^(?:rust-v)?(\d+\.\d+\.\d+)$/.exec(String(tag ?? '').trim())
  return match?.[1]
}

/** Ручной выбор используется, только если он есть в списке. Иначе берётся последняя известная. */
export function resolveCodexVersion(saved, versions, fallback = CODEX_VERSION_FALLBACK) {
  const list = Array.isArray(versions) ? versions.filter((version) => codexVersion(version) === version) : []
  if (saved && saved !== 'auto' && (!list.length || list.includes(saved)) && codexVersion(saved)) return saved
  return list[0] || fallback
}

export class CodexVersions {
  /** @param {typeof fetch} [fetchImpl] */
  constructor(fetchImpl = globalThis.fetch) {
    this.fetch = fetchImpl
    this.versions = []
    this.at = 0
    /** @type {Promise<string[]> | undefined} */
    this.pending = undefined
  }

  /** @param {{ force?: boolean }} [options] */
  async list({ force = false } = {}) {
    if (!force && this.versions.length && Date.now() - this.at < FRESH_MS) return this.versions
    if (this.pending) return this.pending
    this.pending = this.#load().finally(() => { this.pending = undefined })
    return this.pending
  }

  async #load() {
    try {
      const response = await this.fetch(RELEASES_URL, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'sub-to-api', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`GitHub ответил ${response.status}`)
      const releases = await response.json()
      const versions = []
      for (const release of Array.isArray(releases) ? releases : []) {
        if (release?.draft || release?.prerelease) continue
        const version = codexVersion(release?.tag_name)
        if (version && !versions.includes(version)) versions.push(version)
      }
      if (versions.length) {
        this.versions = versions.slice(0, 20)
        this.at = Date.now()
      }
    } catch { /* остаётся предыдущий список, а без него — запасная версия */ }
    return this.versions
  }
}
