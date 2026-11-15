// Anthropic wire translation, independent of DSH runtime services.
function invalid(message) { return Object.assign(new Error(message), { status: 400, code: 'invalid_request' }) }
export function claudeRequest(request) {
  const system = []; const messages = []
  for (const message of request.messages) {
    if (message.role === 'system') { if (message.content) system.push(message.content); continue }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = []
    if (message.role === 'tool') content.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content ?? '' })
    else {
      if (message.content) content.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        let input
        try { input = JSON.parse(call.arguments || '{}') } catch { throw invalid('Claude: invalid tool arguments JSON') }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Claude: tool arguments must be an object')
        content.push({ type: 'tool_use', id: call.id, name: call.name, input })
      }
    }
    if (!content.length) content.push({ type: 'text', text: '' })
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content)
    else messages.push({ role, content })
  }
  if (request.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoningEffort)) throw invalid('Claude: unsupported reasoning effort')
  const maxTokens = request.maxTokens ?? 32000
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw invalid('Claude: maxTokens must be a positive integer')
  markCache(messages)
  // tools render before system, so this one mark covers both. Five minutes omits ttl: a one-hour write costs 2× and spends the plan window faster on rapid turns.
  const systemBlocks = system.length ? [{ type: 'text', text: system.join('\n\n'), cache_control: { type: 'ephemeral' } }] : undefined
  return { model: request.model, max_tokens: maxTokens, stream: true, messages,
    ...(systemBlocks ? { system: systemBlocks } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
    ...(request.reasoningEffort ? { output_config: { effort: request.reasoningEffort } } : {}),
  }
}

// Anthropic looks back 20 blocks for a previous write. One agent turn can append more than that, so marks stay 15 blocks apart. Four marks total; system already took one.
function markCache(messages) {
  const blocks = messages.flatMap((message) => message.content)
  for (let mark = 0; mark < 3; mark++) {
    const at = blocks.length - 1 - mark * 15
    if (at < 0) return
    blocks[at].cache_control = { type: 'ephemeral' }
  }
}

// Decode across arbitrary UTF-8/chunk boundaries, including CRLF split in two chunks.
async function* sse(body, signal) {
  if (!body) throw new Error('Claude: empty response body')
  const reader = body.getReader(); const decoder = new TextDecoder()
  let pending = ''; let data = []; let ended = false
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const result = await reader.read()
      signal?.throwIfAborted()
      pending += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true })
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1)
        if (line === '') { if (data.length) { yield data.join('\n'); data = [] } }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (result.done) { ended = true; break }
    }
    if (pending.startsWith('data:')) data.push(pending.slice(5).replace(/^ /, '').replace(/\r$/, ''))
    if (data.length) yield data.join('\n')
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!ended) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function* streamClaude(body, signal) {
  const tools = new Map(); let inputTokens = 0; let outputTokens = 0; let cacheReadTokens = 0; let cacheWriteTokens = 0; let finishReason = 'stop'; let stopped = false
  for await (const raw of sse(body, signal)) {
    if (raw === '[DONE]') continue
    let event
    try { event = JSON.parse(raw) } catch { throw new Error('Claude: malformed SSE JSON') }
    if (event.type === 'error') throw Object.assign(new Error(event.error?.message || 'Claude stream error'), { code: event.error?.type || 'provider_error', status: event.error?.type === 'overloaded_error' ? 529 : 502 })
    if (event.type === 'message_start') {
      const usage = event.message?.usage ?? {}
      cacheReadTokens = usage.cache_read_input_tokens ?? 0
      cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
      inputTokens = (usage.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens
      outputTokens = usage.output_tokens ?? 0
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block?.type === 'tool_use') {
        if (!block.id || !block.name) throw new Error('Claude: invalid tool block')
        tools.set(event.index, { id: block.id, name: block.name, initial: block.input, arguments: '' })
      } else if (block?.type === 'text' && block.text) yield { type: 'text', text: block.text }
      else if (block?.type === 'thinking' && block.thinking) yield { type: 'reasoning', text: block.thinking }
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta?.type === 'text_delta') yield { type: 'text', text: delta.text ?? '' }
      if (delta?.type === 'thinking_delta') yield { type: 'reasoning', text: delta.thinking ?? '' }
      if (delta?.type === 'input_json_delta') {
        const tool = tools.get(event.index)
        if (!tool) throw new Error('Claude: tool delta without tool block')
        tool.arguments += delta.partial_json ?? ''
      }
    }
    if (event.type === 'content_block_stop' && tools.has(event.index)) {
      const tool = tools.get(event.index); tools.delete(event.index)
      const args = tool.arguments || JSON.stringify(tool.initial ?? {})
      try { JSON.parse(args) } catch { throw new Error('Claude: malformed streamed tool arguments') }
      yield { type: 'tool_call', id: tool.id, name: tool.name, arguments: args }
    }
    if (event.type === 'message_delta') {
      outputTokens = event.usage?.output_tokens ?? outputTokens
      const reason = event.delta?.stop_reason
      if (reason) finishReason = reason === 'tool_use' ? 'tool_calls' : reason === 'max_tokens' ? 'length' : 'stop'
    }
    if (event.type === 'message_stop') { stopped = true; break }
  }
  if (!stopped || tools.size) throw new Error('Claude: truncated event stream')
  yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
  yield { type: 'done', finishReason }
}
