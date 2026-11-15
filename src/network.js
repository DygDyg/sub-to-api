import { networkInterfaces } from 'node:os'

export const EXPOSURES = ['localhost', 'lan', 'internet']
export const AUTH_MODES = ['required', 'optional']
export const API_KEY_SCOPES = ['none', 'internet', 'lan', 'localhost']
export const SETTINGS_KEY_SCOPES = ['internet', 'lan']
const EXPOSURE_RANK = { localhost: 0, lan: 1, internet: 2 }

export function normalizeExposure(value) {
  return EXPOSURES.includes(value) ? value : 'localhost'
}

export function normalizeAuthMode(value) {
  return AUTH_MODES.includes(value) ? value : 'required'
}

export function apiKeyScopeOf(settings) {
  if (API_KEY_SCOPES.includes(settings?.apiKeyScope)) return settings.apiKeyScope
  return normalizeAuthMode(settings?.authMode) === 'optional' ? 'none' : 'localhost'
}

export function apiKeyRequired(remote, scope) {
  const mode = API_KEY_SCOPES.includes(scope) ? scope : 'localhost'
  if (mode === 'none') return false
  if (mode === 'localhost') return true
  if (isLoopback(remote)) return false
  if (mode === 'lan') return true
  return !isPrivate(remote)
}

export function apiKeysOf(settings) {
  const listed = Array.isArray(settings?.apiKeys) ? settings.apiKeys : []
  const keys = []
  for (const item of listed) {
    const key = String(item?.key ?? '').trim()
    const label = String(item?.label ?? '').trim()
    if (!key || !label) continue
    if (keys.some((entry) => entry.key === key)) continue
    keys.push({ id: String(item.id || ''), label: label.slice(0, 80), key })
  }
  if (!keys.length && String(settings?.apiKey ?? '').trim()) {
    keys.push({ id: 'legacy', label: 'Основной', key: String(settings.apiKey).trim() })
  }
  return keys
}

export function normalizeSettingsKeyScope(value) {
  return value === 'lan' ? 'lan' : 'internet'
}

export function settingsExposureOf(source) {
  if (typeof source === 'string') return normalizeExposure(source)
  if (EXPOSURES.includes(source?.settingsExposure)) return source.settingsExposure
  if (source?.remoteSettings) return 'lan'
  return 'localhost'
}

export function widerExposure(left, right) {
  const a = normalizeExposure(left)
  const b = normalizeExposure(right)
  return EXPOSURE_RANK[a] >= EXPOSURE_RANK[b] ? a : b
}

export function hostFor(exposure) {
  return normalizeExposure(exposure) === 'localhost' ? '127.0.0.1' : '0.0.0.0'
}

export function allowedByExposure(remote, exposure) {
  const mode = normalizeExposure(exposure)
  if (isLoopback(remote)) return true
  if (mode === 'localhost') return false
  if (mode === 'lan') return isPrivate(remote)
  return true
}

export function canReachSettings(remote, runtime = {}) {
  return allowedByExposure(remote, settingsExposureOf(runtime))
}

export function settingsKeyRequired(remote, scope) {
  if (isLoopback(remote)) return false
  if (normalizeSettingsKeyScope(scope) === 'lan') return true
  return !isPrivate(remote)
}

export function settingsKeyMustBeSet(exposure, scope) {
  const mode = settingsExposureOf(exposure)
  if (mode === 'internet') return true
  return mode === 'lan' && normalizeSettingsKeyScope(scope) === 'lan'
}

export function bareAddress(address) {
  return String(address ?? '').replace(/^::ffff:/, '')
}

export function isLoopback(address) {
  const ip = bareAddress(address)
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
}

export function isPrivate(address) {
  const ip = bareAddress(address).toLowerCase()
  if (isLoopback(ip)) return true
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true
  const match = /^172\.(\d+)\./.exec(ip)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')
}

export function lanAddresses() {
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  return addresses
}
