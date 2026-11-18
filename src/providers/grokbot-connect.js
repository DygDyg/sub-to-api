import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const ROLE = { user: 1, assistant: 2 }

/**
 * @param {string} machineId
 * @param {number} [now]
 */
export function cursorChecksum(machineId, now = Date.now()) {
  const time = Math.floor(now / 1e6)
  const bytes = Uint8Array.from([
    (time >> 40) & 255,
    (time >> 32) & 255,
    (time >> 24) & 255,
    (time >> 16) & 255,
    (time >> 8) & 255,
    time & 255,
  ])
  let seed = 165
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = ((bytes[index] ^ seed) + (index % 256)) & 255
    seed = bytes[index]
  }
  return `${Buffer.from(bytes).toString('base64url')}${machineId}`
}

/** Challenge is the hash of the verifier string, not of the raw random bytes. */
export function loginChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** @param {string} challenge @param {string} uuid */
export function loginUrl(challenge, uuid) {
  const url = new URL('https://cursor.com/loginDeepControl')
  url.searchParams.set('challenge', challenge)
  url.searchParams.set('uuid', uuid)
  url.searchParams.set('mode', 'login')
  url.searchParams.set('redirectTarget', 'sand')
  url.searchParams.set('supportsSelectedTeamLogin', 'true')
  return url.toString()
}

/**
 * Encode a canonical chat request as one uncompressed Connect frame.
 * The live sand schema accepts the model id in field 5 and requested_model.1.
 * Native tool results and system roles are flattened: the server rejects those roles.
 * @param {import('./types.js').CanonicalRequest} request
 * @param {{invocationId?: string, conversationId?: string}} [ids]
 */
export function encodeInferenceFrame(request, ids = {}) {
  const root = new Proto()
  for (const message of flattenMessages(request.messages ?? [])) root.messageField(1, encodeMessage(message))
  for (const tool of request.tools ?? []) root.messageField(2, encodeTool(tool))
  const model = request.model || 'grok-4.6'
  root.stringField(5, model)
  root.stringField(6, ids.invocationId || 'invoke')
  const requested = new Proto()
  requested.stringField(1, model)
  root.messageField(7, requested)
  root.stringField(8, ids.conversationId || ids.invocationId || 'conversation')
  return frame(0, root.finish())
}

/**
 * @param {Buffer} body
 */
export function inspectInferenceRequest(body) {
  const payload = body.subarray(5)
  const fields = readFields(payload)
  const texts = []
  const tools = []
  let modelId = ''
  for (const field of fields) {
    if (field.field === 1) {
      const message = readFields(field.value)
      const text = stringField(message, 2)
      if (text) texts.push(text)
    } else if (field.field === 2) {
      const tool = readFields(field.value)
      tools.push({
        name: stringField(tool, 1),
        description: stringField(tool, 2),
        hasParameters: Boolean(stringField(tool, 5)),
      })
    } else if (field.field === 5) {
      modelId = field.value.toString('utf8')
    }
  }
  return { modelId, texts, tools }
}

/**
 * Decode a Connect response stream as frames arrive.
 * @param {ReadableStream<Uint8Array>} stream
 */
export async function* streamInference(stream) {
  const decoder = new InferenceDecoder()
  const reader = stream.getReader()
  let pending = Buffer.alloc(0)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending = Buffer.concat([pending, Buffer.from(value)])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const flags = pending[0]
        const payload = pending.subarray(5, 5 + length)
        pending = pending.subarray(5 + length)
        yield* decoder.push(flags, payload)
      }
    }
    if (pending.length) throw new Error('Обрезанный кадр Grok Bot')
    yield* decoder.finish()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/**
 * Decode a Connect response body into canonical events.
 * @param {Buffer} body
 */
export function eventsFromInference(body) {
  const decoder = new InferenceDecoder()
  const events = []
  let offset = 0
  while (offset + 5 <= body.length) {
    const flags = body[offset]
    const length = body.readUInt32BE(offset + 1)
    const end = offset + 5 + length
    if (end > body.length) throw new Error('Обрезанный кадр Grok Bot')
    events.push(...decoder.push(flags, body.subarray(offset + 5, end)))
    offset = end
  }
  events.push(...decoder.finish())
  return events
}

/** @param {string} text */
export function textFrame(text, isFinal = false) {
  const part = new Proto()
  part.stringField(1, text)
  if (isFinal) part.varintField(2, 1)
  const root = new Proto()
  root.messageField(1, part)
  return frame(0, root.finish())
}

/** @param {{id: string, name?: string, args?: string, complete?: boolean}} call */
export function toolFrame(call) {
  const part = new Proto()
  part.stringField(1, call.id)
  if (call.name) part.stringField(2, call.name)
  if (call.args) part.stringField(3, call.args)
  if (call.complete) part.varintField(4, 1)
  const root = new Proto()
  root.messageField(2, part)
  return frame(0, root.finish())
}

/** @param {{input?: number, output?: number, cached?: number}} usage */
export function usageFrame(usage) {
  const part = new Proto()
  part.varintField(1, usage.input ?? 0)
  part.varintField(2, usage.output ?? 0)
  if (usage.cached != null) part.varintField(3, usage.cached)
  const root = new Proto()
  root.messageField(5, part)
  return frame(0, root.finish())
}

/** @param {string} message */
export function errorTrailer(message) {
  return frame(0x02, Buffer.from(JSON.stringify({ error: { code: 'resource_exhausted', message } })))
}

class InferenceDecoder {
  text = ''
  /** @type {Map<string, {name: string, args: string}>} */
  calls = new Map()
  sawTool = false
  failed = false
  /** @type {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number} | undefined} */
  usage

  push(flags, payload) {
    const body = flags & 1 ? gunzipSync(payload) : payload
    if (flags & 2) return this.#trailer(body)
    if (flags & ~1) throw new Error('Неизвестный кадр Grok Bot')
    return this.#response(body)
  }

  finish() {
    if (this.failed) return []
    return [
      ...(this.usage ? [{ type: 'usage', ...this.usage }] : []),
      { type: 'done', finishReason: this.sawTool ? 'tool_calls' : 'stop' },
    ]
  }

  #trailer(body) {
    const payload = JSON.parse(body.toString('utf8'))
    if (!payload.error) return []
    this.failed = true
    const code = payload.error.code || 'provider_error'
    const message = payload.error.message || 'Grok Bot отклонил запрос'
    return [{ type: 'error', text: code === 'provider_error' ? message : `${code}: ${message}`, code, status: 502 }]
  }

  #response(body) {
    const arm = readFields(body).find((field) => field.wire === 2 && field.field >= 1 && field.field <= 10)
    if (!arm) return []
    if (arm.field === 1) return this.#text(arm.value)
    if (arm.field === 2) return this.#tool(arm.value)
    if (arm.field === 3 || arm.field === 5) {
      this.usage = usageOf(arm.value, arm.field === 5)
      return []
    }
    if (arm.field === 8) {
      this.failed = true
      return [{ type: 'error', text: stringsOf(arm.value).join(' ') || 'Grok Bot вернул ошибку', code: 'provider_error', status: 502 }]
    }
    if (arm.field === 9) {
      const text = stringField(readFields(arm.value), 1)
      return text ? [{ type: 'reasoning', text }] : []
    }
    return []
  }

  #text(body) {
    const fields = readFields(body)
    const text = stringField(fields, 1)
    const isFinal = varintField(fields, 2) === 1n
    if (!text) return []
    if (isFinal && (text === this.text || this.text.endsWith(text))) return []
    if (isFinal && text.startsWith(this.text)) {
      const extra = text.slice(this.text.length)
      this.text = text
      return extra ? [{ type: 'text', text: extra }] : []
    }
    this.text += text
    return [{ type: 'text', text }]
  }

  #tool(body) {
    const fields = readFields(body)
    const id = stringField(fields, 1) || `call_${this.calls.size}`
    const name = stringField(fields, 2)
    const args = stringField(fields, 3)
    const complete = varintField(fields, 4) === 1n
    const current = this.calls.get(id) ?? { name: '', args: '' }
    const events = []
    if (name && name !== current.name) {
      current.name = name
      events.push({ type: 'tool_call', id, name, arguments: '' })
    }
    if (args) {
      const extra = args.startsWith(current.args) ? args.slice(current.args.length) : args
      current.args = args.startsWith(current.args) ? args : current.args + args
      if (extra) events.push({ type: 'tool_call', id, arguments: extra })
    }
    if (complete || name || args) this.sawTool = true
    this.calls.set(id, current)
    return events
  }
}

function flattenMessages(messages) {
  const out = []
  let pending = ''
  const flush = () => {
    if (!pending) return
    out.push({ role: 'user', content: pending })
    pending = ''
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      flush()
      const calls = (message.toolCalls ?? []).map((call) => `${call.name}(${call.arguments || '{}'})`).join(', ')
      const text = [message.content, calls].filter(Boolean).join('\n')
      if (text) out.push({ role: 'assistant', content: text })
      continue
    }
    const text = message.role === 'system'
      ? `[SYSTEM]\n${message.content ?? ''}`
      : message.role === 'tool'
        ? `TOOL_RESULT ${message.name || 'tool'}: ${message.content ?? ''}`
        : message.content ?? ''
    pending = pending ? `${pending}\n${text}` : text
  }
  flush()
  return out
}

function encodeMessage(message) {
  const out = new Proto()
  out.varintField(1, ROLE[message.role])
  if (message.content) out.stringField(2, message.content)
  return out
}

function encodeTool(tool) {
  const out = new Proto()
  out.stringField(1, tool.name)
  if (tool.description) out.stringField(2, tool.description)
  if (tool.parameters) out.stringField(5, JSON.stringify(tool.parameters))
  return out
}

function usageOf(body, extended) {
  const fields = readFields(body)
  const input = Number(varintField(fields, 1) ?? 0n)
  const output = Number(varintField(fields, 2) ?? 0n)
  const cached = extended ? varintField(fields, 3) : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cached == null ? {} : { cacheReadTokens: Number(cached) }),
  }
}

function stringsOf(body, depth = 0) {
  if (depth > 4) return []
  const found = []
  for (const field of readFields(body)) {
    if (field.wire !== 2) continue
    const text = field.value.toString('utf8')
    if (text && /^[\x20-\x7e]+$/.test(text)) found.push(text)
    else found.push(...stringsOf(field.value, depth + 1))
  }
  return found
}

function stringField(fields, number) {
  return fields.find((field) => field.field === number && field.wire === 2)?.value.toString('utf8') ?? ''
}

function varintField(fields, number) {
  return fields.find((field) => field.field === number && field.wire === 0)?.value
}

function readFields(body) {
  const fields = []
  let offset = 0
  while (offset < body.length) {
    const [tag, next] = readVarint(body, offset)
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    offset = next
    if (wire === 0) {
      const [value, after] = readVarint(body, offset)
      fields.push({ field, wire, value })
      offset = after
    } else if (wire === 2) {
      const [length, after] = readVarint(body, offset)
      const end = after + Number(length)
      fields.push({ field, wire, value: body.subarray(after, end) })
      offset = end
    } else if (wire === 1) offset += 8
    else if (wire === 5) offset += 4
    else throw new Error('Неизвестное поле Grok Bot')
  }
  return fields
}

function readVarint(body, offset) {
  let value = 0n
  let shift = 0n
  let index = offset
  while (index < body.length) {
    const byte = body[index++]
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [value, index]
    shift += 7n
    if (shift > 70n) break
  }
  throw new Error('Обрезанный varint Grok Bot')
}

function frame(flags, payload) {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

class Proto {
  chunks = []
  tag(field, wire) { this.raw(varint(BigInt((field << 3) | wire))) }
  raw(value) { this.chunks.push(Buffer.from(value)) }
  varintField(field, value) { this.tag(field, 0); this.raw(varint(BigInt(value))) }
  stringField(field, value) {
    const bytes = Buffer.from(String(value))
    this.tag(field, 2)
    this.raw(varint(BigInt(bytes.length)))
    this.raw(bytes)
  }
  messageField(field, message) {
    const bytes = message.finish()
    if (!bytes.length) return
    this.tag(field, 2)
    this.raw(varint(BigInt(bytes.length)))
    this.raw(bytes)
  }
  finish() { return Buffer.concat(this.chunks) }
}

function varint(value) {
  const bytes = []
  let rest = value
  do {
    let byte = Number(rest & 0x7fn)
    rest >>= 7n
    if (rest > 0n) byte |= 0x80
    bytes.push(byte)
  } while (rest > 0n)
  return Buffer.from(bytes)
}
