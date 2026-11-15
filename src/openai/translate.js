/** @param {any} body @param {Record<string, string | string[] | undefined>} [headers] */
export function chatCompletionToCanonical(body, headers) {
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
    throw Object.assign(new Error('Expected { model, messages }'), { status: 400, code: 'invalid_request' })
  }
  return {
    model: body.model,
    stream: body.stream === true,
    maxTokens: numberOrUndefined(body.max_completion_tokens ?? body.max_tokens),
    reasoningEffort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
    promptCacheKey: cacheKey(body.prompt_cache_key ?? headerValue(headers, 'x-prompt-cache-key')),
    messages: body.messages.map(normalizeMessage),
    tools: Array.isArray(body.tools) ? body.tools.flatMap(normalizeTool) : undefined,
    complexityOverride: complexityOverride(body.complexity ?? headerValue(headers, 'x-complexity')),
  }
}

function complexityOverride(value) {
  if (value === undefined || value === null || value === '') return undefined
  const tier = String(value).trim().toLowerCase()
  if (!['light', 'medium', 'heavy'].includes(tier)) {
    throw Object.assign(new Error('complexity должен быть light, medium или heavy'), { status: 400, code: 'invalid_request' })
  }
  return tier
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') throw Object.assign(new Error('Invalid message'), { status: 400 })
  const content = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      : ''
  return {
    role: message.role,
    content,
    name: message.name,
    toolCallId: message.tool_call_id,
    toolCalls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          id: String(call.id),
          name: String(call.function?.name ?? ''),
          arguments: String(call.function?.arguments ?? '{}'),
        }))
      : undefined,
    reasoningByCallId: reasoningReplay(message.reasoning_items),
  }
}

function reasoningReplay(items) {
  if (!Array.isArray(items)) return undefined
  /** @type {Record<string, {id?: string, summary?: unknown[], status?: string, encrypted_content: string}[]>} */
  const byCall = {}
  for (const item of items) {
    if (!item || typeof item.encrypted_content !== 'string' || !item.call_id) continue
    const replay = {
      ...(item.id ? { id: String(item.id) } : {}),
      ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
      ...(item.status ? { status: String(item.status) } : {}),
      encrypted_content: item.encrypted_content,
    }
    byCall[String(item.call_id)] = [...(byCall[String(item.call_id)] ?? []), replay]
  }
  return Object.keys(byCall).length ? byCall : undefined
}

function normalizeTool(tool) {
  if (tool?.type !== 'function' || typeof tool.function?.name !== 'string') return []
  return [{
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters ?? { type: 'object', properties: {} },
  }]
}

function numberOrUndefined(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function headerValue(headers, name) {
  const value = headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function cacheKey(value) {
  if (typeof value !== 'string') return undefined
  if (/[\u0000-\u001f]/.test(value)) {
    throw Object.assign(new Error('prompt_cache_key must be 1-256 characters without control chars'), { status: 400, code: 'invalid_request' })
  }
  const key = value.trim()
  if (!key || key.length > 256) {
    throw Object.assign(new Error('prompt_cache_key must be 1-256 characters without control chars'), { status: 400, code: 'invalid_request' })
  }
  return key
}

function usageOf(event) {
  const prompt = event.inputTokens ?? 0
  const completion = event.outputTokens ?? 0
  const cached = Math.max(0, event.cacheReadTokens ?? 0)
  const written = Math.max(0, event.cacheWriteTokens ?? 0)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached || written ? { prompt_tokens_details: { ...(cached ? { cached_tokens: cached } : {}), ...(written ? { cache_write_tokens: written } : {}) } } : {}),
  }
}

/** @param {string} model @param {AsyncIterable<any>} events */
export async function collectChatCompletion(model, events) {
  let text = ''
  let reasoning = ''
  /** @type {Map<string, {id: string, name: string, arguments: string}>} */
  const calls = new Map()
  let usage
  /** @type {{call_id: string, id?: string, summary?: unknown[], status?: string, encrypted_content: string}[]} */
  const reasoningItems = []
  let finishReason = 'stop'
  for await (const event of events) {
    if (event.type === 'text') text += event.text ?? ''
    if (event.type === 'reasoning') reasoning += event.text ?? ''
    if (event.type === 'tool_call') {
      finishReason = 'tool_calls'
      const current = calls.get(event.id) ?? { id: event.id, name: event.name ?? '', arguments: '' }
      current.name = event.name || current.name
      current.arguments += event.arguments ?? ''
      calls.set(event.id, current)
    }
    if (event.type === 'reasoning_replay' && event.item?.encrypted_content && event.id) reasoningItems.push({ call_id: event.id, ...event.item })
    if (event.type === 'usage') usage = usageOf(event)
    if (event.type === 'done' && event.finishReason) finishReason = event.finishReason
    if (event.type === 'error') throw Object.assign(new Error(event.text ?? 'Provider error'), { status: event.status ?? 502, code: event.code })
  }
  return {
    id: `chatcmpl_${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.size ? { tool_calls: [...calls.values()].map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
        ...(reasoningItems.length ? { reasoning_items: reasoningItems } : {}),
      },
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  }
}

/** @param {import('node:http').ServerResponse} response @param {string} model @param {AsyncIterable<any>} events */
export async function writeChatStream(response, model, events) {
  const id = `chatcmpl_${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
  const calls = new Map()
  /** @type {{call_id: string, id?: string, summary?: unknown[], status?: string, encrypted_content: string}[]} */
  const reasoningItems = []
  let finishReason = 'stop'
  let usage
  let failed = false
  for await (const event of events) {
    if (event.type === 'text' || event.type === 'reasoning') {
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: event.type === 'text' ? { content: event.text ?? '' } : { reasoning_content: event.text ?? '' }, finish_reason: null }] })
    } else if (event.type === 'tool_call') {
      const first = !calls.has(event.id)
      if (first) calls.set(event.id, calls.size)
      finishReason = 'tool_calls'
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: calls.get(event.id), ...(first ? { id: event.id, type: 'function' } : {}), function: { ...(event.name ? { name: event.name } : {}), arguments: event.arguments ?? '' } }] }, finish_reason: null }] })
    } else if (event.type === 'reasoning_replay' && event.item?.encrypted_content && event.id) {
      reasoningItems.push({ call_id: event.id, ...event.item })
    } else if (event.type === 'usage') {
      usage = usageOf(event)
    } else if (event.type === 'done') {
      finishReason = event.finishReason || finishReason
    } else if (event.type === 'error') {
      failed = true
      send({ error: { message: event.text ?? 'Provider error', type: event.code ?? 'provider_error' } })
      break
    }
  }
  if (!failed) send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: reasoningItems.length ? { reasoning_items: reasoningItems } : {}, finish_reason: finishReason }], ...(usage ? { usage } : {}) })
  response.end('data: [DONE]\n\n')
}
