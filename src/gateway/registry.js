import { PROVIDER_IDS, PROVIDER_LABELS } from '../providers/types.js'

export class ProviderRegistry {
  /** @param {import('../providers/types.js').ProviderAdapter[]} adapters */
  constructor(adapters) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]))
    /** @type {Map<string, any>} */
    this.custom = new Map()
  }

  /** Заменяет набор своих API-провайдеров. @param {any[]} adapters */
  setCustom(adapters) {
    this.custom = new Map(adapters.filter((adapter) => !this.adapters.has(adapter.id)).map((adapter) => [adapter.id, adapter]))
  }

  list() {
    return [...PROVIDER_IDS.map((id) => this.adapters.get(id)).filter(Boolean), ...this.custom.values()]
  }

  /** Встроенные и свои провайдеры: id и название (для настроек прокси). */
  ids() {
    return this.list().map((adapter) => ({ id: adapter.id, label: adapter.label, custom: Boolean(adapter.custom) }))
  }

  /** @param {string} id */
  get(id) {
    const adapter = this.adapters.get(id) ?? this.custom.get(id)
    if (!adapter) throw Object.assign(new Error(`Unknown provider: ${id}`), { status: 404 })
    return adapter
  }

  /** @param {string} publicModel */
  resolve(publicModel) {
    const slash = publicModel.indexOf('/')
    if (slash <= 0) throw Object.assign(new Error('Model must look like provider/model-id'), { status: 400 })
    return { adapter: this.get(publicModel.slice(0, slash)), model: publicModel.slice(slash + 1), publicModel }
  }

  label(id) {
    return PROVIDER_LABELS[id] ?? this.custom.get(id)?.label ?? id
  }
}
