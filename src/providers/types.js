/** @typedef {'codex' | 'claude' | 'grok' | 'grokbot' | 'copilot' | 'antigravity'} ProviderId */

export const PROVIDER_IDS = ['codex', 'claude', 'grok', 'grokbot', 'copilot', 'antigravity']

export const PROVIDER_LABELS = {
  codex: 'ChatGPT / Codex',
  claude: 'Claude',
  grok: 'Grok',
  grokbot: 'Grok Bot',
  copilot: 'GitHub Copilot',
  antigravity: 'Google Antigravity',
}

/**
 * @typedef {Object} AccountView
 * @property {string} key
 * @property {string} [label]
 * @property {string} [plan]
 * @property {number} [expiresAt]
 * @property {boolean} isDefault
 */

/**
 * @typedef {Object} UsageWindow
 * @property {'session' | 'weekly' | 'other'} kind
 * @property {number} usedPercent
 * @property {number} [resetsAt]
 */

/**
 * @typedef {Object} UsageSnapshot
 * @property {boolean} supported
 * @property {string} [plan]
 * @property {UsageWindow[]} windows
 * @property {string} [error]
 * @property {number} fetchedAt
 */

/**
 * @typedef {Object} ModelInfo
 * @property {string} id
 * @property {string} name
 * @property {number} [contextWindow]
 * @property {string[]} [efforts]
 * @property {boolean} [supportsTools]
 * @property {boolean} [supportsImages]
 */

/**
 * @typedef {Object} CanonicalMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string} [content]
 * @property {string} [name]
 * @property {string} [toolCallId]
 * @property {{id: string, name: string, arguments: string}[]} [toolCalls]
 * @property {Record<string, {id?: string, summary?: unknown[], status?: string, encrypted_content: string}[]>} [reasoningByCallId]
 */

/**
 * @typedef {Object} CanonicalTool
 * @property {string} name
 * @property {string} [description]
 * @property {Record<string, unknown>} parameters
 */

/**
 * @typedef {Object} CanonicalRequest
 * @property {string} model
 * @property {CanonicalMessage[]} messages
 * @property {CanonicalTool[]} [tools]
 * @property {number} [maxTokens]
 * @property {string} [reasoningEffort]
 * @property {string} [promptCacheKey]
 * @property {boolean} stream
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} CanonicalEvent
 * @property {'text' | 'reasoning' | 'tool_call' | 'reasoning_replay' | 'usage' | 'done' | 'error'} type
 * @property {string} [text]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [arguments]
 * @property {{id?: string, summary?: unknown[], status?: string, encrypted_content: string}} [item]
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 * @property {string} [finishReason]
 * @property {string} [code]
 * @property {number} [status]
 */

/**
 * @typedef {Object} ProviderAdapter
 * @property {ProviderId} id
 * @property {string} label
 * @property {'oauth' | 'device'} loginKind
 * @property {(input: {clientId?: string}) => Promise<{authorizeUrl?: string, userCode?: string, verificationUrl?: string, instructions: string}>} beginLogin
 * @property {(input: {callback?: string, code?: string}) => Promise<AccountView>} completeLogin
 * @property {() => void} cancelLogin
 * @property {() => Promise<AccountView[]>} listAccounts
 * @property {(key: string) => Promise<void>} removeAccount
 * @property {(key: string) => Promise<void>} setDefaultAccount
 * @property {(accountKey?: string, signal?: AbortSignal) => Promise<ModelInfo[]>} listModels
 * @property {(accountKey?: string, signal?: AbortSignal) => Promise<UsageSnapshot>} usage
 * @property {(request: CanonicalRequest, accountKey?: string) => AsyncIterable<CanonicalEvent>} stream
 */
