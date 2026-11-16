import { usageOf } from './usage.js'

/** call id → reasoning items captured from the previous response. Cursor does not echo encrypted reasoning, so the gateway replays it on the next tool round-trip. */
const reasoningCache = new Map()
const rejectedReasoning = new Set()
const REASONING_CACHE_LIMIT = 200

export function rememberReasoning(callId, items) {
  if (!callId || !items?.length) return
  reasoningCache.delete(callId)
  reasoningCache.set(callId, items)
  while (reasoningCache.size > REASONING_CACHE_LIMIT) reasoningCache.delete(reasoningCache.keys().next().value)
}

export function reasoningFor(callId) {
  return reasoningCache.get(callId)
}

/** Drop replay items Codex refused to decrypt so the next turn does not send them again. */
export function forgetReasoning(items) {
  const ids = items.map((item) => item?.id).filter(Boolean)
  if (!ids.length) return
  for (const id of ids) {
    rejectedReasoning.add(id)
    if (rejectedReasoning.size > REASONING_CACHE_LIMIT) rejectedReasoning.delete(rejectedReasoning.keys().next().value)
  }
  const blocked = new Set(ids)
  for (const [callId, cached] of reasoningCache) {
    if (cached.some((item) => blocked.has(item.id))) reasoningCache.delete(callId)
  }
}

const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful coding assistant.'

/**
 * Canonical messages → Responses `instructions` + `input`.
 * System text becomes instructions. Every tool call is its own function_call
 * item; a tool result is function_call_output. Reasoning replay, when the
 * client sent encrypted items, rides ahead of the matching call and is
 * deduped by array reference so parallel calls of one response replay once.
 * @param {import('./types.js').CanonicalRequest} request
 * @param {{ defaultInstructions?: string, replayReasoning?: boolean }} [options]
 */
export function toResponsesInput(request, options = {}) {
  const systemTexts = request.messages.filter((message) => message.role === 'system').map((message) => message.content).filter(Boolean)
  const instructions = systemTexts.join('\n\n') || options.defaultInstructions
  /** @type {Record<string, unknown>[]} */
  const input = []
  let lastReplay
  const replayed = []
  for (const message of request.messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      if (!message.toolCallId) throw Object.assign(new Error('tool result has no call id'), { status: 400, code: 'invalid_request' })
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content ?? '' })
      continue
    }
    /** @type {Record<string, unknown>[]} */
    let content = []
    const flush = () => {
      if (!content.length) return
      input.push({ type: 'message', role: message.role, content })
      content = []
    }
    if (message.content) content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content })
    for (const call of message.toolCalls ?? []) {
      flush()
      const replay = replayItems(options.replayReasoning === false ? undefined : (message.reasoningByCallId?.[call.id] ?? reasoningFor(call.id)))
      if (replay && replay !== lastReplay) {
        for (const item of replay) {
          input.push({
            type: 'reasoning',
            ...(item.id ? { id: item.id } : {}),
            ...(item.summary ? { summary: item.summary } : {}),
            encrypted_content: item.encrypted_content,
          })
        }
        replayed.push(...replay)
        lastReplay = replay
      }
      input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
    }
    flush()
  }
  return { ...(instructions ? { instructions } : {}), input, replayed }
}

/**
 * Canonical tools → Responses function tools.
 * @param {import('./types.js').CanonicalTool[]} tools
 * @param {{ strict?: false }} [options]
 */
export function toResponsesTools(tools, options = {}) {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(options.strict === undefined ? {} : { strict: options.strict }),
  }))
}

/**
 * @param {import('./types.js').CanonicalRequest} request
 * @param {{ strict?: false, defaultInstructions?: string, includeEncryptedReasoning?: boolean, replayReasoning?: boolean }} [options]
 */
export function responsesBody(request, options = {}) {
  const resolved = toResponsesInput(request, options)
  delete resolved.replayed
  return {
    model: request.model,
    ...resolved,
    ...(request.tools?.length ? { tools: toResponsesTools(request.tools, options), tool_choice: 'auto', parallel_tool_calls: true } : {}),
    ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort, ...(options.includeEncryptedReasoning ? { summary: 'auto' } : {}) } } : {}),
    ...(options.includeEncryptedReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
    ...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
    store: false,
    stream: true,
  }
}

export function codexResponsesBody(request, options = {}) {
  const resolved = toResponsesInput(request, { ...options, defaultInstructions: DEFAULT_CODEX_INSTRUCTIONS })
  const { replayed = [], ...input } = resolved
  const body = responsesBody(request, { strict: false, defaultInstructions: DEFAULT_CODEX_INSTRUCTIONS, includeEncryptedReasoning: true, replayReasoning: false, ...options })
  Object.assign(body, input)
  body.instructions ??= DEFAULT_CODEX_INSTRUCTIONS
  return { body, replayed }
}

/** Codex rejects encrypted reasoning minted by another model with HTTP 400 invalid_encrypted_content. */
export function invalidEncryptedContent(error) {
  return error?.status === 400 && /invalid_encrypted_content|encrypted content/i.test(error.message ?? '')
}

/**
 * Push-model Responses SSE translator. Call {@link push} with each parsed
 * event; it returns canonical events. `response.completed` finishes with
 * `tool_calls` when any function call was seen, otherwise `stop`.
 */
export class ResponsesStreamTranslator {
  #calls = new Map()
  #sawToolCall = false
  #textItems = new Set()
  #pendingReasoning = []
  #replayed = false
  terminated = false

  /**
   * @param {Record<string, any>} event
   * @returns {import('./types.js').CanonicalEvent[]}
   */
  push(event) {
    if (this.terminated || !event || typeof event !== 'object') return []
    switch (event.type) {
      case 'response.output_item.added':
        return this.#open(event.item)
      case 'response.function_call_arguments.delta':
        return this.#arguments(event)
      case 'response.output_item.done':
        return this.#done(event.item)
      case 'response.output_text.delta':
        this.#textItems.add(event.item_id ?? '')
        return [{ type: 'text', text: event.delta ?? '' }]
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return [{ type: 'reasoning', text: event.delta ?? '' }]
      case 'response.completed':
        return this.#complete(event)
      case 'response.failed':
      case 'response.incomplete':
      case 'error':
        throw Object.assign(new Error(failureText(event)), { status: 502, code: 'provider_error' })
      default:
        return []
    }
  }

  #open(item) {
    if (item?.type !== 'function_call') return []
    const key = itemKey(item)
    this.#sawToolCall = true
    const call = this.#calls.get(key) ?? { id: item.call_id || item.id || key, name: item.name ?? '', arguments: '' }
    call.name = item.name || call.name
    call.id = item.call_id || call.id
    this.#calls.set(key, call)
    if (item.id) this.#calls.set(item.id, call)
    return [{ type: 'tool_call', id: call.id, name: call.name, arguments: '' }, ...this.#attachReplay(call.id)]
  }

  #arguments(event) {
    const key = event.item_id || ''
    let call = this.#calls.get(key)
    if (!call) {
      this.#sawToolCall = true
      call = { id: key || `call_${this.#calls.size}`, name: '', arguments: '' }
      this.#calls.set(key, call)
    }
    call.arguments += event.delta ?? ''
    return [{ type: 'tool_call', id: call.id, ...(call.name ? { name: call.name } : {}), arguments: event.delta ?? '' }]
  }

  #done(item) {
    if (!item) return []
    if (item.type === 'function_call') {
      const key = itemKey(item)
      const call = this.#calls.get(key) ?? this.#calls.get(item.id)
      if (call && !call.arguments && item.arguments) {
        call.arguments = item.arguments
        return [{ type: 'tool_call', id: call.id, ...(call.name ? { name: call.name } : {}), arguments: item.arguments }]
      }
      return []
    }
    if (item.type === 'reasoning' && item.encrypted_content) {
      this.#pendingReasoning.push({
        ...(item.id ? { id: item.id } : {}),
        ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
        encrypted_content: item.encrypted_content,
      })
      const target = [...this.#calls.values()].at(-1)
      return target ? this.#attachReplay(target.id) : []
    }
    if (item.type === 'message' && item.id !== undefined && !this.#textItems.has(item.id)) {
      const text = (item.content ?? []).filter((part) => part?.type === 'output_text' && part.text).map((part) => part.text).join('')
      if (!text) return []
      this.#textItems.add(item.id)
      return [{ type: 'text', text }]
    }
    return []
  }

  #attachReplay(callId) {
    if (this.#replayed || !this.#pendingReasoning.length || !callId) return []
    const items = this.#pendingReasoning
    this.#pendingReasoning = []
    this.#replayed = true
    rememberReasoning(callId, items)
    return items.map((item) => ({ type: 'reasoning_replay', id: callId, item }))
  }

  #complete(event) {
    this.terminated = true
    const usage = event.response?.usage
    const trailing = this.#attachReplay([...this.#calls.values()].at(-1)?.id)
    return [
      ...trailing,
      ...(usage ? [{ type: 'usage', ...usageOf(usage) }] : []),
      { type: 'done', finishReason: this.#sawToolCall ? 'tool_calls' : 'stop' },
    ]
  }
}

/**
 * Consume a Responses SSE body and yield canonical events.
 * @param {ReadableStream<Uint8Array>} stream
 */
export async function* streamResponses(stream) {
  const translator = new ResponsesStreamTranslator()
  for await (const sse of parseSse(stream)) {
    let event
    try {
      event = JSON.parse(sse.data)
    } catch {
      throw Object.assign(new Error('Malformed Responses SSE payload'), { status: 502, code: 'malformed_response' })
    }
    yield* translator.push(event)
    if (translator.terminated) return
  }
  throw Object.assign(new Error('Responses SSE stream ended before response.completed'), { status: 502, code: 'stream_closed' })
}

function replayItems(items) {
  if (!items?.length) return undefined
  const kept = items.filter((item) => item?.encrypted_content && !rejectedReasoning.has(item.id))
  return kept.length ? kept : undefined
}

function itemKey(item) {
  return item.id || item.call_id || ''
}

function failureText(event) {
  return event.response?.error?.message
    ?? event.message
    ?? event.response?.incomplete_details?.reason
    ?? event.code
    ?? 'the provider reported a failed response'
}

async function* parseSse(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let eventName = ''
  let data = []
  const flush = function* () {
    if (!data.length && !eventName) return
    yield { event: eventName, data: data.join('\n') }
    eventName = ''
    data = []
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const parts = pending.split(/\r?\n/)
    pending = parts.pop() ?? ''
    for (const line of parts) {
      if (line === '') {
        yield* flush()
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
  }
  if (pending) {
    if (pending.startsWith('data:')) data.push(pending.slice(5).trimStart())
    else if (pending.startsWith('event:')) eventName = pending.slice(6).trim()
  }
  yield* flush()
}
