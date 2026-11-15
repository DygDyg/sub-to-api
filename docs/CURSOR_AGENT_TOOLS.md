# Cursor Agent: tool calls через OpenAI-compatible шлюз

Инструкция для DeepSeek Harness / SubToAPI: почему Agent в Cursor «завершает разговор» после фраз вроде «проверю…», и что чинить в адаптерах Grok/Codex (Responses API).

Эталон в DSH: [`src/translate/responses.ts`](https://github.com/DygDyg/dsh-plugin-subscriptions-ru/blob/main/src/translate/responses.ts) — `toResponsesInput`, `toResponsesTools`, `ResponsesStreamTranslator`, `streamResponses`.

---

## Симптом

1. Override Base URL указывает на шлюз (например `http://<public-ip>:8787/v1`).
2. Простые ответы работают.
3. В Agent модель пишет «сейчас проверю» / «открою файл» и ход заканчивается без tool-вызовов.

Причина: клиент Cursor Agent ждёт OpenAI `chat.completions` stream с `delta.tool_calls` и финальным `finish_reason: "tool_calls"`. Если парсер Responses API отдаёт только текст и всегда `stop`, цикл агента обрывается.

Отдельно: `http://127.0.0.1:8787` даёт `403 Access to private networks is forbidden` — запросы идут с серверов Cursor, не из IDE. Нужен публично достижимый URL (не путать с багом tools).

---

## Что править

### 1. Исходящий запрос (Grok/Codex → Responses)

Как `toResponsesInput` / `toResponsesTools` в DSH:

- `tools` → `{ type: "function", name, description, parameters }` (и при необходимости `strict: false` для Codex).
- Каждый assistant `tool-call` → отдельный item `{ type: "function_call", call_id, name, arguments }` — **все** вызовы, не только первый.
- Tool result → `{ type: "function_call_output", call_id, output }`.
- Reasoning после tool round-trip — replay через `encrypted_content` (`reasoningFor`), иначе модель часто теряет цепочку мысли.

Типичные ошибки упрощённого порта:

- в body нет `tools` (часто Codex);
- в `input` только `toolCalls[0]`.

### 2. Входящий SSE (Responses → внутренние события)

Как `ResponsesStreamTranslator.push`:

| SSE event | Действие |
|---|---|
| `response.output_item.added` + `item.type === "function_call"` | открыть tool-call (`id`, `call_id`, `name`) |
| `response.function_call_arguments.delta` | копить `arguments` |
| `response.output_item.done` + `function_call` | закрыть call; если args пустые — взять `item.arguments` |
| `response.output_text.delta` | текст |
| `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` | reasoning (опционально наружу) |
| `response.completed` | usage + finish: **`tool-calls`**, если был хоть один call, иначе `stop` |

Запрещено в конце всегда слать `finishReason: "stop"`.

Нельзя игнорировать `function_call` / `function_call_arguments.delta` и оставлять только `output_text` + `reasoning`.

### 3. Наружу в Cursor (OpenAI chat.completions chunks)

Слой вроде `writeChatStream` / chat-completions translator должен отдавать:

```text
choices[0].delta.tool_calls = [{
  index,           // стабильный на весь стрим одного call
  id?,             // на первом чанке call
  type: "function",
  function: { name?, arguments }
}]
...
choices[0].finish_reason = "tool_calls"
```

Несколько tools — разные `index`. Не схлопывать все calls в `index: 0`.

Для Copilot-подобного chat.completions wire см. DSH `src/translate/chat-completions.ts`.

### 4. Что не смешивать

- Claude — другой протокол (`tool_use` / `input_json_delta`). Эталон для Grok/Codex — только `responses.ts`, не Claude-транслятор.
- Текстовый «я вызову tool» без wire `tool_calls` для Agent бесполезен.

---

## Где смотреть в DSH

| Файл | Роль |
|---|---|
| `src/translate/responses.ts` | request assembly + SSE → StreamChunk для Grok/Codex |
| `src/translate/chat-completions.ts` | chat.completions (Copilot) |
| `src/providers/grok.ts` / `codex.ts` | должны гнать стрим через `streamResponses` / `ResponsesStreamTranslator`, не урезанный `parseResponses` |

Практичный фикс шлюза для Cursor: перенести `ResponsesStreamTranslator` + `toResponsesInput` / `toResponsesTools` из DSH как есть.

---

## Проверка

1. Agent в Cursor: «прочитай файл X» — в upstream SSE есть `output_item.added` (`function_call`) и/или `function_call_arguments.delta`.
2. В ответе шлюза клиенту — чанки `tool_calls` и финальный `finish_reason: "tool_calls"`, не только текст.
3. Второй ход: в `input` уходят `function_call` + `function_call_output` (и reasoning replay, если модель reasoning).
4. Регрессия: обычный ответ без tools по-прежнему заканчивается `finish_reason: "stop"`.

---

## Краткий чеклист для PR

- [ ] В Responses request передаются `tools`
- [ ] Все `function_call` / `function_call_output` в `input` (не один call)
- [ ] SSE: `output_item.added` + `function_call_arguments.delta` + `output_item.done`
- [ ] `response.completed` → `tool-calls` при наличии calls
- [ ] OpenAI stream наружу: `delta.tool_calls` + `finish_reason: "tool_calls"`
- [ ] Стабильные `index` для параллельных tools
- [ ] (Grok/Codex reasoning) replay `encrypted_content` на tool round-trip
