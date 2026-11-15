import { estimateTokens } from './pools.js'

export const TIERS = ['light', 'medium', 'heavy']
export const CLASSIFIERS = ['heuristic', 'llm', 'auto']

export const TIER_INFO = {
  light: 'Быстрые и дешёвые модели: короткие ответы, перевод, переформулировка, простые вопросы, болтовня.',
  medium: 'Универсальные модели: обычный код, объяснения, правки по описанию, работа с инструментами средней длины.',
  heavy: 'Самые сильные модели с рассуждениями: архитектура, сложная отладка, большой контекст, длинные агентные циклы.',
}

const DEFAULTS = {
  heuristic: { enabled: false, mediumAt: 1, heavyAt: 3 },
  llm: { enabled: false, model: '', timeoutMs: 1500 },
}

function fail(message) {
  return Object.assign(new Error(message), { status: 400 })
}

/** Настройки сложности с подставленными значениями по умолчанию. */
export function complexityOf(settings) {
  const raw = settings?.complexity ?? {}
  return {
    heuristic: { ...DEFAULTS.heuristic, ...(raw.heuristic ?? {}) },
    llm: { ...DEFAULTS.llm, ...(raw.llm ?? {}) },
  }
}

/** Проверяет и сливает частичное обновление настроек сложности. */
export function normalizeComplexity(input, current) {
  const base = complexityOf({ complexity: current })
  if (!input || typeof input !== 'object') throw fail('complexity должен быть объектом')
  const heuristic = { ...base.heuristic, ...(input.heuristic ?? {}) }
  const llm = { ...base.llm, ...(input.llm ?? {}) }
  heuristic.enabled = Boolean(heuristic.enabled)
  heuristic.mediumAt = Number(heuristic.mediumAt)
  heuristic.heavyAt = Number(heuristic.heavyAt)
  if (!Number.isInteger(heuristic.mediumAt) || !Number.isInteger(heuristic.heavyAt) || Math.abs(heuristic.mediumAt) > 50 || Math.abs(heuristic.heavyAt) > 50) {
    throw fail('Пороги эвристик — целые числа от -50 до 50')
  }
  if (heuristic.heavyAt <= heuristic.mediumAt) throw fail('Порог heavy должен быть больше порога medium')
  llm.enabled = Boolean(llm.enabled)
  llm.model = String(llm.model ?? '').trim()
  llm.timeoutMs = Number(llm.timeoutMs)
  if (llm.model && !/^[a-z]+\/\S+$/.test(llm.model)) throw fail('Модель классификатора — вида provider/model')
  if (llm.enabled && !llm.model) throw fail('Для LLM-классификатора выберите модель')
  if (!Number.isInteger(llm.timeoutMs) || llm.timeoutMs < 300 || llm.timeoutMs > 10000) throw fail('Таймаут классификатора — от 300 до 10000 мс')
  return { heuristic, llm }
}

/** Какие классификаторы сейчас можно использовать. */
export function enabledClassifiers(settings) {
  const cfg = complexityOf(settings)
  const list = []
  if (cfg.heuristic.enabled) list.push('heuristic')
  if (cfg.llm.enabled && cfg.llm.model) list.push('llm')
  if (list.length === 2) list.push('auto')
  return list
}

export function normalizeTier(value) {
  const tier = String(value ?? '').trim().toLowerCase()
  return TIERS.includes(tier) ? tier : undefined
}

export function tierOf(tiers, member) {
  return normalizeTier(tiers?.[member]) ?? 'medium'
}

export function tierOrder(tier) {
  if (tier === 'light') return ['light', 'medium', 'heavy']
  if (tier === 'heavy') return ['heavy', 'medium', 'light']
  return ['medium', 'heavy', 'light']
}

export function lastUserText(request) {
  const message = [...(request?.messages ?? [])].reverse().find((item) => item?.role === 'user')
  return String(message?.content ?? '')
}

const HEAVY_WORDS = /архитектур|рефактор|спроектир|проектирован|докаж|оптимизир|найди (баг|ошибк)|почему не работает|утечк|гонк[аи]|многопоточ|алгоритм|сложност[ьи] алгоритм|миграци|\bdebug|refactor|architect|prove|race condition|memory leak|deadlock|optimi[sz]e|design a/i
const HEAVY_WORDS_ALL = new RegExp(HEAVY_WORDS.source, 'gi')
const LIGHT_START = /^(привет|здравствуй|спасибо|ок\b|окей|понял|переведи|перевод|исправь опечат|hi\b|hello|thanks|thank you|translate|ok\b)/i
const CODE = /```|\bfunction\b|\bclass\b|=>|\bdef |\bimport |#include|\bconst |\blet |SELECT .* FROM/i

/** Оценка сложности без сетевых вызовов. */
export function classifyHeuristic(request, thresholds = {}) {
  const mediumAt = Number.isFinite(thresholds.mediumAt) ? thresholds.mediumAt : DEFAULTS.heuristic.mediumAt
  const heavyAt = Number.isFinite(thresholds.heavyAt) ? thresholds.heavyAt : DEFAULTS.heuristic.heavyAt
  const messages = request?.messages ?? []
  const text = lastUserText(request)
  const tokens = estimateTokens(request)
  let score = 0
  const effort = String(request?.reasoningEffort ?? '').toLowerCase()
  if (effort === 'high' || effort === 'xhigh') score += 3
  else if (effort === 'minimal' || effort === 'low' || effort === 'none') score -= 2
  if (tokens > 30_000) score += 2
  else if (tokens > 8_000) score += 1
  if (text.length > 2_000) score += 1
  if (text.length < 120) score -= 1
  if (CODE.test(text)) score += 1
  if ((request?.tools?.length ?? 0) > 5) score += 1
  if (messages.filter((item) => item?.role === 'tool').length > 10) score += 1
  const heavyHits = new Set((text.match(HEAVY_WORDS_ALL) ?? []).map((word) => word.toLowerCase())).size
  if (heavyHits) score += 1 + Math.min(heavyHits, 3)
  if (LIGHT_START.test(text.trim())) score -= 2
  const tier = score >= heavyAt ? 'heavy' : score >= mediumAt ? 'medium' : 'light'
  return { tier, score }
}

export const CLASSIFIER_PROMPT = 'Ты классификатор сложности запросов. Оцени, какой уровень модели нужен для ответа на последний запрос пользователя. ' +
  'light — простой короткий ответ, перевод, болтовня. medium — обычный код и объяснения. heavy — архитектура, сложная отладка, глубокие рассуждения, большой контекст. ' +
  'Ответь строго одним словом: light, medium или heavy.'

/** Разбирает ответ LLM-классификатора. */
export function parseTier(text) {
  const match = /\b(light|medium|heavy)\b/i.exec(String(text ?? ''))
  return match ? match[1].toLowerCase() : undefined
}

/** Текст-инструкция для ИИ, который расставляет уровни моделей. */
export const TIERS_GUIDE = `Ты настраиваешь уровни моделей в шлюзе SubToAPI. Уровень нужен пулам со стратегией «По сложности запроса»: шлюз оценивает сложность запроса и отправляет его в модель подходящего уровня.

Уровни:
- light — ${TIER_INFO.light}
- medium — ${TIER_INFO.medium}
- heavy — ${TIER_INFO.heavy}

Как оценивать модель:
1. Флагманские и reasoning-модели (opus, gpt-5 без суффиксов mini/nano, grok-4 heavy, модели с efforts high) — heavy.
2. Основные модели среднего класса (sonnet, gpt-5 с умеренной ценой, обычные grok, gemini pro) — medium.
3. Модели с суффиксами mini, nano, flash, lite, haiku, fast и самые дешёвые по полю price — light.
4. Учитывай contextWindow: модели с маленьким окном (меньше 32K) не ставь в heavy.
5. Если не уверен — medium. Модели без уровня шлюз считает medium.
6. Не ставь уровень моделям изображений и видео — в списке только чат-модели.

Порядок работы:
1. GET {BASE}/v1/model-tiers с заголовком Authorization: Bearer {API_KEY}. В ответе: models[] с полями id, name, provider, tier, tierSet, contextWindow, efforts, supportsTools, supportsImages, price.
2. Реши уровень для каждой модели по критериям выше.
3. Одним запросом сохрани всё: POST {BASE}/api/model-tiers, заголовки Content-Type: application/json и x-settings-key: {SETTINGS_KEY}, тело {"tiers": {"provider/model": "light|medium|heavy", ...}}. Значение null сбрасывает уровень.
4. Покажи пользователю таблицу: модель, уровень, короткое обоснование. Проверь ответ POST — там итоговая карта уровней.

Ручное переопределение для отдельного запроса: заголовок x-complexity: light|medium|heavy или поле "complexity" в теле /v1/chat/completions.`
