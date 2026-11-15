// Responses API reports cached reads inside input_tokens, not beside them.
export function usageOf(usage) {
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const cacheReadTokens = usage?.input_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens = usage?.input_tokens_details?.cache_write_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: Math.min(cacheReadTokens, inputTokens),
    cacheWriteTokens: Math.min(cacheWriteTokens, Math.max(0, inputTokens - cacheReadTokens)),
  }
}
