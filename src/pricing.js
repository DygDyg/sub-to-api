import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../data/prices.json'), 'utf8'))
const models = table.models
  .map((model) => ({ ...model, key: normalize(model.id) }))
  .sort((a, b) => b.key.length - a.key.length)

/** @param {string} id @param {{input?: number, output?: number, cacheRead?: number, cacheWrite?: number}} [tokens] */
export function requestCost(id, tokens = {}) {
  const key = normalize(String(id).split('/').at(-1) ?? '')
  const model = models.find((item) => key.startsWith(item.key))
  if (!model || model.unit || !Number.isFinite(model.input)) return undefined
  const input = Math.max(0, tokens.input ?? 0)
  const output = Math.max(0, tokens.output ?? 0)
  const cacheRead = Math.min(input, Math.max(0, tokens.cacheRead ?? 0))
  const cacheWrite = Math.min(Math.max(0, input - cacheRead), Math.max(0, tokens.cacheWrite ?? 0))
  const fresh = Math.max(0, input - cacheRead - cacheWrite)
  const amount = (fresh * model.input + cacheRead * model.input * 0.1 + cacheWrite * model.input * 1.25 + output * model.output) / 1_000_000
  return { amount, label: `≈ ${money(amount)}` }
}

/** @param {string} id */
export function priceEstimate(id) {
  const key = normalize(String(id).split('/').at(-1) ?? '')
  const model = models.find((item) => key.startsWith(item.key))
  if (!model) return undefined
  const source = table.sources[model.source]
  if (model.unit) {
    return {
      unit: `≈ ${money(model.amount)} / ${model.unit}`,
      title: `Публичная цена API, не списание подписки: ${money(model.amount)} за ${model.unit}. Ориентир для сравнения; фактическая цена может отличаться.${source ? ` ${source}` : ''}`,
    }
  }
  return {
    input: `≈ ${money(model.input * 0.1)}`,
    output: `≈ ${money(model.output * 0.1)}`,
    title: `Публичная цена API за 100K токенов, не списание подписки. Ориентир для сравнения; фактическая цена может отличаться. Вход ${money(model.input)} / 1M, выход ${money(model.output)} / 1M.${source ? ` ${source}` : ''}`,
  }
}

function normalize(id) {
  return id.toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
}

function money(value) {
  if (value > 0 && value < 0.1) return `$${value.toFixed(3).replace(/0$/, '')}`
  return `$${value.toFixed(2)}`
}
