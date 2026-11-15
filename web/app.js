const tabNames = { home: 'Главная', settings: 'Настройки', models: 'Модели', pools: 'Пулы', journal: 'Журнал', docs: 'Документация' }
const providers = document.querySelector('#providers')
let poolCatalog = []
let poolMembers = []
let poolEditingId = null
let poolDragIndex = -1
const requests = document.querySelector('#requests')
const journalPending = document.querySelector('#journal-pending')
let journalWatch = false
let appReady = false
let journalSeq = 0
let pendingJournal = null
let journalReleaseTimer = 0
let journalQuietUntil = 0

const themeButton = document.querySelector('#theme')
applyTheme(localStorage.getItem('theme') || 'light')
themeButton.onclick = () => applyTheme(document.documentElement.dataset.bsTheme === 'dark' ? 'light' : 'dark')
document.querySelector('#refresh').onclick = () => {
  load({ refreshUsage: true })
  if (document.querySelector('#tab-models').classList.contains('active')) loadCatalog(true)
}
const tabNav = document.querySelector('nav.tabs')
document.querySelectorAll('[data-tab]').forEach((button) => {
  button.onclick = () => showTab(button.dataset.tab)
})
window.addEventListener('wheel', (event) => {
  if (tabNav.scrollWidth <= tabNav.clientWidth) return
  if (!event.target.closest('.sidebar')) return
  tabNav.scrollLeft += event.deltaY || event.deltaX
  event.preventDefault()
}, { passive: false })
showTab(localStorage.getItem('tab') || 'home')

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === name
    button.setAttribute('aria-selected', String(selected))
    button.classList.toggle('active', selected)
  })
  document.querySelector('#crumb').textContent = tabNames[name] || name
  document.querySelector(`[data-tab="${name}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.id === `tab-${name}`))
  localStorage.setItem('tab', name)
  journalWatch = name === 'journal'
  if (!journalWatch) setPending(0)
  if (name === 'models') loadCatalog(false)
  if (name === 'pools') loadPools()
  if (journalWatch) refreshJournal()
}

function applyTheme(theme) {
  document.documentElement.dataset.bsTheme = theme
  localStorage.setItem('theme', theme)
  themeButton.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'
  themeButton.setAttribute('aria-label', themeButton.title)
  themeButton.innerHTML = theme === 'dark'
    ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg>'
}

async function load({ refreshUsage = false } = {}) {
  const seq = ++journalSeq
  const overview = await api('/api/overview')
  const origin = overview.settings.url ?? location.origin
  const base = `${origin}/v1`
  document.querySelector('#base-url').textContent = base
  setLink('#docs-base', base)
  setLink('#link-models', `${base}/models`)
  setLink('#link-chat', `${base}/chat/completions`)
  setLink('#link-images', `${base}/images/generations`)
  setLink('#link-videos', `${base}/videos`)
  setLink('#link-usage', `${origin}/api/usage`)
  document.querySelector('#curl-example').textContent = curlExample(base, overview.settings.apiKey)
  document.querySelector('#port').value = overview.settings.port
  document.querySelector('#exposure').value = overview.settings.exposure || 'localhost'
  document.querySelector('#auth-mode').value = overview.settings.authMode || 'required'
  document.querySelector('#settings-exposure').value = overview.settings.settingsExposure || 'localhost'
  document.querySelector('#settings-key-scope').value = overview.settings.settingsKeyScope || 'internet'
  document.querySelector('#settings-key').value = overview.settings.settingsKey || ''
  document.querySelector('#api-key').value = overview.settings.apiKey || ''
  const saveFull = document.querySelector('#save-full')
  saveFull.checked = Boolean(overview.settings.saveFullRequest)
  if (seq === journalSeq) syncJournal(overview.requests)
  document.querySelector('#network-note').textContent = networkNote(overview.settings)
  syncSettingsAccess()
  if (overview.settings.effectivePort && overview.settings.effectivePort !== overview.settings.port) {
    document.querySelector('#port-status').textContent = `Сейчас открыт ${overview.settings.effectivePort}: порт ${overview.settings.port} занят.`
  }
  document.querySelector('#active').textContent = String(overview.activeRequests)
  const open = new Set(JSON.parse(localStorage.getItem('provider-open') || '[]'))
  const connected = overview.providers.filter((provider) => provider.accounts.length)
  const available = overview.providers.filter((provider) => !provider.accounts.length)
  providers.replaceChildren(...connected.map((provider) => renderProvider(provider, open.has(provider.id))))
  document.querySelector('#open-connect').onclick = () => openConnect(available)
  limitsSeq += 1
  const usage = api(`/api/usage${refreshUsage ? '?refresh=1' : ''}`).catch((error) => ({ providers: [], error: error.message }))
  await Promise.all([
    renderSideLimits(usage),
    ...[...providers.children].map((card, index) => Promise.all([
      fillUsage(card, connected[index], usage),
      fillModels(card, connected[index], refreshUsage),
    ])),
  ])
}

function requestKey(request) {
  return request.id || `${request.started}:${request.model}`
}

function noteJournalActivity() {
  journalQuietUntil = Date.now() + 1200
  clearTimeout(journalReleaseTimer)
  journalReleaseTimer = setTimeout(releaseJournal, 1200)
}

function journalReading() {
  if (Date.now() < journalQuietUntil) return true
  if (document.querySelector('#full-log')?.open) return true
  const selection = document.getSelection()
  if (selection && !selection.isCollapsed && requests.contains(selection.anchorNode)) return true
  if (requests.querySelector('details[open]')) return true
  return window.scrollY > 32
}

function sameJournal(items) {
  const wanted = items.map(requestKey)
  const have = [...requests.children].map((card) => card.dataset.id)
  return wanted.length === have.length && wanted.every((id, index) => id === have[index])
}

function newLabel(count) {
  return `Показать новые (${count})`
}

function setPending(count) {
  journalPending.hidden = count < 1
  if (count > 0) journalPending.textContent = newLabel(count)
}

function syncJournal(items) {
  const openFull = document.querySelector('#open-full')
  const disabled = !items.some((request) => request.hasFull)
  if (openFull.disabled !== disabled) openFull.disabled = disabled
  if (sameJournal(items)) {
    pendingJournal = null
    setPending(0)
    return
  }
  if (journalReading()) {
    const have = new Set([...requests.children].map((card) => card.dataset.id))
    const added = items.filter((request) => !have.has(requestKey(request))).length
    pendingJournal = added ? items : null
    setPending(added)
    return
  }
  applyJournal(items)
}

function applyJournal(items) {
  const existing = new Map([...requests.children].map((card) => [card.dataset.id, card]))
  const next = items.map((request) => existing.get(requestKey(request)) ?? row(request))
  if (next.length !== requests.children.length || next.some((card, index) => card !== requests.children[index])) {
    requests.replaceChildren(...next)
  }
  pendingJournal = null
  setPending(0)
}

function releaseJournal() {
  if (!pendingJournal) return
  if (journalReading()) {
    const wait = journalQuietUntil - Date.now()
    if (wait > 0) {
      clearTimeout(journalReleaseTimer)
      journalReleaseTimer = setTimeout(releaseJournal, wait)
    }
    return
  }
  applyJournal(pendingJournal)
}

async function refreshJournal() {
  if (!appReady || !journalWatch || document.hidden) return
  const seq = ++journalSeq
  try {
    const payload = await api('/api/journal')
    if (seq === journalSeq) syncJournal(payload.requests ?? [])
  } catch { /* следующая попытка подхватит журнал */ }
}

function row(request) {
  const card = document.createElement('details')
  card.className = 'card journal shadow-sm'
  card.dataset.id = requestKey(request)
  const facts = [
    Number.isFinite(request.inputTokens) ? `вход ${request.inputTokens}` : '',
    Number.isFinite(request.outputTokens) ? `выход ${request.outputTokens}` : '',
    request.cacheReadTokens ? `кеш ${request.cacheReadTokens}` : Number.isFinite(request.inputTokens) ? 'кеш не сработал' : '',
    request.cacheWriteTokens ? `запись кеша ${request.cacheWriteTokens}` : '',
    request.cost ?? '',
    request.durationMs ? `${Math.round(request.durationMs / 100) / 10} с` : '',
  ].filter(Boolean)
  const kind = request.status === 'ok' ? 'ok' : 'error'
  const badge = kind === 'ok' ? 'text-bg-success' : 'text-bg-danger'
  card.innerHTML = `<summary class="card-header d-flex align-items-center gap-2"><code>${escape(request.model || '—')}</code><span class="text-body-secondary small ms-auto">${new Date(request.started).toLocaleString()}</span><span class="badge ${badge}">${escape(request.status || 'ошибка')}</span></summary><div class="card-body vstack gap-2">${request.error ? `<p class="error mb-0">${escape(request.error)}</p>` : ''}${facts.length ? `<p class="text-body-secondary small mb-0">${escape(facts.join(' · '))}</p>` : ''}${request.request ? `<strong>Запрос</strong><pre>${escape(request.request)}</pre>` : '<p class="text-body-secondary mb-0">Текст этого запроса не сохранён</p>'}${request.response ? `<strong>Ответ</strong><pre>${escape(request.response)}</pre>` : ''}</div>`
  return card
}

function renderProvider(provider, opened) {
  const card = document.createElement('details')
  card.className = 'card provider shadow-sm'
  card.dataset.id = provider.id
  card.open = opened
  card.ontoggle = () => localStorage.setItem('provider-open', JSON.stringify([...providers.querySelectorAll('details[open]')].map((item) => item.dataset.id)))
  const connected = provider.accounts.length > 0
  const accounts = connected
    ? provider.accounts.map((account) => `<li class="list-group-item d-flex justify-content-between align-items-center gap-2"><span>${escape(account.label ?? account.key)}${account.isDefault ? ' · основной' : ''}</span><button type="button" class="btn btn-outline-danger btn-sm" data-logout="${escape(account.key)}">Выйти</button></li>`).join('')
    : '<li class="list-group-item text-body-secondary">Нет аккаунтов</li>'
  card.innerHTML = `
    <summary class="card-header d-flex align-items-center gap-2"><div class="d-flex flex-grow-1 justify-content-between align-items-baseline gap-2 min-w-0"><h3 class="h6 mb-0">${escape(provider.label)}</h3><p class="text-body-secondary small mb-0 text-truncate" data-summary>${provider.loginKind}</p></div></summary>
    <div class="card-body vstack gap-3">
      <ul class="list-group">${accounts}</ul>
      <div data-usage class="vstack gap-3"><p class="text-body-secondary mb-0">Квота загружается…</p></div>
      <div data-models><p class="text-body-secondary mb-0">Модели загружаются…</p></div>
      <p class="error small mb-0" data-status></p>
      ${provider.id === 'antigravity' ? `<input class="form-control" name="clientId" placeholder="Google OAuth client ID" value="${escape(provider.clientId ?? '')}">` : ''}
      <form hidden class="vstack gap-2">
        <input class="form-control" name="callback" placeholder="Callback URL или код">
        <div class="d-flex gap-2"><button class="btn btn-primary" type="submit">Завершить вход</button><button type="button" class="btn btn-outline-secondary" data-cancel>Отмена</button></div>
        <p class="text-body-secondary small mb-0" data-instructions></p>
      </form>
    </div>`
  const form = card.querySelector('form')
  card.querySelectorAll('[data-logout]').forEach((logout) => {
    logout.onclick = async () => {
      await api(`/api/providers/${provider.id}/accounts/${encodeURIComponent(logout.dataset.logout)}`, { method: 'DELETE' })
      await load()
    }
  })
  return card
}

function openConnect(available) {
  const dialog = document.querySelector('#connect-dialog')
  const list = document.querySelector('#connect-list')
  const status = document.querySelector('#connect-status')
  const form = document.querySelector('#connect-form')
  let current = ''
  status.textContent = ''
  form.hidden = true
  list.innerHTML = available.map((provider) => `<div class="d-flex justify-content-between align-items-center gap-3 border rounded p-3"><div><strong>${escape(provider.label)}</strong><br><span class="text-body-secondary small">${provider.loginKind === 'disabled' ? 'вход через подписку запрещён' : provider.loginKind}</span></div><button type="button" class="btn btn-primary btn-sm" data-connect="${provider.id}">Подключить</button></div>`).join('') || '<p class="text-body-secondary mb-0">Все провайдеры уже подключены</p>'
  list.querySelectorAll('[data-connect]').forEach((button) => {
    button.onclick = async () => {
      current = button.dataset.connect
      status.textContent = ''
      try {
        const login = await api(`/api/providers/${current}/login`, { method: 'POST', body: JSON.stringify({ clientId: form.querySelector('[name="clientId"]').value }) })
        const url = login.authorizeUrl || login.verificationUrl
        if (url) window.open(url, '_blank', 'noopener')
        form.hidden = false
        form.querySelector('[data-instructions]').textContent = login.userCode ? `Код: ${login.userCode}. ${login.instructions}` : login.instructions
      } catch (error) { status.textContent = error.message }
    }
  })
  document.querySelector('#connect-cancel').onclick = async () => {
    if (current) await api(`/api/providers/${current}/cancel`, { method: 'POST', body: '{}' })
    form.hidden = true
  }
  document.querySelector('#connect-finish').onclick = async () => {
    try {
      await api(`/api/providers/${current}/complete`, { method: 'POST', body: JSON.stringify({ callback: form.querySelector('[name="callback"]').value }) })
      dialog.close()
      await load()
    } catch (error) { status.textContent = error.message }
  }
  dialog.showModal()
}

let catalogRows = []
async function loadCatalog(refresh = false) {
  const target = document.querySelector('#catalog')
  catalogRows = (await api(`/api/catalog${refresh ? '?refresh=1' : ''}`).catch((error) => ({ data: [], error: error.message }))).data ?? []
  if (!catalogRows.length) {
    target.innerHTML = '<p class="text-body-secondary">Модели появятся после входа в провайдера</p>'
    return
  }
  renderCatalog()
}
document.querySelector('#model-search').oninput = renderCatalog

function renderCatalog() {
  const query = document.querySelector('#model-search').value.trim().toLowerCase()
  const rows = catalogRows.filter((model) => `${model.id} ${model.name} ${model.description ?? ''}`.toLowerCase().includes(query))
  const groups = new Map()
  for (const model of rows) {
    const name = model.provider || 'Другие'
    groups.set(name, [...(groups.get(name) ?? []), model])
  }
  const sections = [...groups].map(([name, models]) => {
    const section = document.createElement('section')
    section.className = 'card catalog-group shadow-sm'
    section.innerHTML = `<div class="card-header fw-semibold">${escape(name)}</div>`
    const list = document.createElement('div')
    list.className = 'list-group list-group-flush'
    list.append(...models.map(catalogItem))
    section.append(list)
    return section
  })
  document.querySelector('#catalog').replaceChildren(...sections)
}

const icon = {
  provider: '<svg viewBox="0 0 24 24"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 1 1 18 0z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/></svg>',
  hidden: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 22 12s-3.5 6-10 6a9 9 0 0 1-4.2-1"/><path d="M6.1 6.1A10 10 0 0 0 2 12s3.5 6 10 6"/></svg>',
  context: '<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16"/><path d="M8 15V9M12 15V7M16 15v-3"/></svg>',
  vision: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  tools: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.6 5.6L3 18l3 3 6.1-6.1a4 4 0 0 0 5.6-5.6l-3 3-2-2z"/></svg>',
  reasoning: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 22h4"/><path d="M8 14a6 6 0 1 1 8 0c-.8.8-1.5 1.5-1.5 3h-5c0-1.5-.7-2.2-1.5-3z"/></svg>',
  price: '<svg viewBox="0 0 24 24"><path d="M12 2v20"/><path d="M16 7.5c0-1.5-1.8-2.5-4-2.5s-4 1-4 2.5 1.8 2.5 4 2.5 4 1 4 2.5-1.8 2.5-4 2.5-4-1-4-2.5"/></svg>',
}

function catalogItem(model) {
  const card = document.createElement('article')
  card.className = 'list-group-item catalog-item d-flex justify-content-between gap-3'
  const tags = [
    ['provider', icon.provider, model.provider],
    [model.capability, model.capability === 'image' ? icon.image : model.capability === 'video' ? icon.video : icon.chat, model.capability === 'image' ? 'изображение' : model.capability === 'video' ? 'видео' : 'чат'],
    model.enabled ? null : ['hidden', icon.hidden, 'скрыта'],
    model.contextWindow ? ['context', icon.context, `${Math.round(model.contextWindow / 1000)}K контекст`] : null,
    model.supportsImages ? ['vision', icon.vision, 'принимает изображения'] : null,
    model.supportsTools ? ['tools', icon.tools, 'инструменты'] : null,
    model.efforts?.length ? ['reasoning', icon.reasoning, model.efforts.join(', ')] : null,
  ].filter(Boolean)
  const price = model.price?.input
    ? `<span>за 100K</span><div>вход <strong>${escape(model.price.input)}</strong></div><div>выход <strong>${escape(model.price.output)}</strong></div>`
    : model.price?.unit ? `<strong>${escape(model.price.unit)}</strong>` : ''
  card.innerHTML = `<div class="min-w-0"><strong>${escape(model.name)}</strong><div class="catalog-id"><code>${escape(model.id)}</code><button type="button" class="btn btn-outline-secondary btn-icon" title="Копировать идентификатор" aria-label="Копировать идентификатор"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/></svg></button></div>${model.description ? `<p class="text-body-secondary small mb-0">${escape(model.description)}</p>` : ''}<div class="tags">${tags.map(([kind, mark, text]) => `<span class="badge rounded-pill ${kind === 'hidden' ? 'text-bg-danger' : 'bg-body-tertiary text-body-secondary border'}">${mark}${escape(text)}</span>`).join('')}</div></div>${price ? `<div class="price-col" title="${escape(model.price.title)}">${price}</div>` : ''}`
  card.querySelector('button').onclick = () => navigator.clipboard.writeText(model.id)
  return card
}

async function fillModels(card, provider, refresh = false) {
  const target = card.querySelector('[data-models]')
  const payload = await api(`/api/providers/${provider.id}/models${refresh ? '?refresh=1' : ''}`).catch((error) => ({ data: [], error: error.message }))
  if (!payload.data?.length) {
    target.innerHTML = `<p class="text-body-secondary mb-0">${escape(payload.error || 'Модели появятся после входа')}</p>`
    return
  }
  const enabled = payload.data.filter((model) => model.enabled).length
  card.querySelector('[data-summary]').textContent = `${provider.accounts.length ? 'подключён' : 'не подключён'} · модели ${enabled}/${payload.data.length}`
  target.innerHTML = `<details class="border rounded model-picker"><summary class="d-flex justify-content-between align-items-center gap-2 px-3 py-2"><strong>Доступные модели</strong><span class="text-body-secondary small">${enabled} из ${payload.data.length}</span></summary><div class="p-3 vstack gap-2"><div class="d-flex gap-2"><button type="button" class="btn btn-outline-secondary btn-sm" data-all>Все</button><button type="button" class="btn btn-outline-secondary btn-sm" data-none>Ничего</button></div><div class="model-list vstack">${payload.data.map((model) => `<label class="form-check form-switch py-2 mb-0"><input class="form-check-input" type="checkbox" role="switch" value="${escape(model.id)}" ${model.enabled ? 'checked' : ''}><span class="form-check-label"><strong>${escape(model.name || model.id)}</strong>${model.description ? `<small class="d-block text-body-secondary">${escape(model.description)}</small>` : ''}</span></label>`).join('')}</div><button type="button" class="btn btn-primary btn-sm" data-save-models>Сохранить модели</button></div></details>`
  target.querySelector('[data-all]').onclick = () => target.querySelectorAll('input').forEach((input) => { input.checked = true })
  target.querySelector('[data-none]').onclick = () => target.querySelectorAll('input').forEach((input) => { input.checked = false })
  target.querySelector('[data-save-models]').onclick = async () => {
    const ids = [...target.querySelectorAll('input:checked')].map((input) => input.value)
    await api(`/api/providers/${provider.id}/models`, { method: 'POST', body: JSON.stringify({ ids }) })
    target.querySelector('[data-save-models]').textContent = 'Сохранено'
  }
}

const sideLimits = document.querySelector('#side-limits')
const USAGE_REFRESH_MS = 5 * 60 * 1000
let limitsTimer = 0
let limitsSeq = 0
let limitsDue = false
let limitsSignature = ''

function scheduleLimitsRefresh() {
  clearTimeout(limitsTimer)
  limitsDue = false
  limitsTimer = setTimeout(() => {
    limitsTimer = 0
    if (document.hidden) {
      limitsDue = true
      return
    }
    refreshLimits()
  }, USAGE_REFRESH_MS + 1000)
}

async function refreshLimits() {
  if (document.hidden) {
    limitsDue = true
    return
  }
  const seq = ++limitsSeq
  try {
    const payload = await api('/api/usage')
    if (seq !== limitsSeq) return
    await renderSideLimits(Promise.resolve(payload))
    for (const card of providers.children) fillUsage(card, { id: card.dataset.id }, Promise.resolve(payload))
  } catch {
    if (seq !== limitsSeq) return
    clearTimeout(limitsTimer)
    limitsTimer = setTimeout(refreshLimits, 60 * 1000)
  }
}

async function renderSideLimits(usageRequest) {
  const payload = await usageRequest
  scheduleLimitsRefresh()
  const rows = (payload.providers ?? []).filter((provider) => provider.usage?.windows?.length)
  const signature = rows.map((provider) => `${provider.id}:${provider.usage.windows.map((item) => `${item.kind}:${item.scope ?? ''}:${item.usedPercent}:${item.resetsAt ?? ''}`).join(',')}`).join('|')
  if (!rows.length) {
    limitsSignature = ''
    sideLimits.hidden = true
    sideLimits.replaceChildren()
    return
  }
  if (signature === limitsSignature) return
  limitsSignature = signature
  sideLimits.hidden = false
  const title = document.createElement('p')
  title.className = 'side-limits-title'
  title.textContent = 'Лимиты'
  sideLimits.replaceChildren(title, ...rows.map(sideLimit))
}

function sideLimit(provider) {
  const section = document.createElement('section')
  section.className = 'side-limit'
  section.dataset.id = provider.id
  const name = document.createElement('div')
  name.className = 'side-limit-name'
  const label = document.createElement('span')
  label.textContent = provider.label
  name.append(label)
  section.append(name, ...provider.usage.windows.map(sideMeter))
  return section
}

function sideMeter(item) {
  const remaining = Math.max(0, Math.min(100, 100 - item.usedPercent))
  const rounded = Math.round(remaining)
  const meter = document.createElement('div')
  meter.className = 'side-meter'
  const caption = document.createElement('span')
  caption.textContent = sideWindowLabel(item)
  const reset = document.createElement('span')
  reset.className = 'side-reset'
  if (item.resetsAt) {
    reset.dataset.reset = String(item.resetsAt)
    reset.textContent = resetShort(item.resetsAt)
  }
  const value = document.createElement('strong')
  value.textContent = `${rounded}%`
  const bar = document.createElement('div')
  bar.className = 'progress'
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-valuenow', String(rounded))
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', '100')
  const fill = document.createElement('div')
  fill.className = `progress-bar ${usageBar(item.usedPercent)}`
  fill.style.width = `${remaining}%`
  bar.append(fill)
  meter.title = item.resetsAt ? `${rounded}% осталось. ${resetAbsolute(item.resetsAt)}` : `${rounded}% осталось`
  meter.append(caption, reset, value, bar)
  return meter
}

function resetShort(timestamp) {
  const left = timestamp - Date.now()
  if (left <= 0) return 'сейчас'
  const minutes = Math.ceil(left / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days) return hours ? `${days}д ${hours}ч` : `${days}д`
  if (hours) return mins ? `${hours}ч ${mins}м` : `${hours}ч`
  return `${mins || 1}м`
}

function tickSideResets() {
  if (document.hidden || sideLimits.hidden) return
  sideLimits.querySelectorAll('[data-reset]').forEach((node) => {
    const at = Number(node.dataset.reset)
    if (Number.isFinite(at)) node.textContent = resetShort(at)
  })
}

function sideWindowLabel(item) {
  const kind = item.kind === 'session' ? '5 ч' : item.kind === 'weekly' ? '7 д' : ''
  if (item.scope) return kind ? `${item.scope} · ${kind}` : item.scope
  return kind || 'Лимит'
}

async function fillUsage(card, provider, usageRequest) {
  const payload = await usageRequest
  const usage = payload.providers?.find((item) => item.id === provider.id)?.usage
    ?? (payload.error ? { windows: [], error: payload.error } : { windows: [], error: 'Нет данных о квоте' })
  const target = card.querySelector('[data-usage]')
  if (!target) return
  if (usage.windows?.length) {
    target.innerHTML = usage.windows.map((item) => {
      const remaining = Math.max(0, Math.min(100, 100 - item.usedPercent))
      return `<div><div class="d-flex justify-content-between gap-2 small mb-1"><span class="text-body-secondary">${escape(windowLabel(item))}</span><strong${item.resetsAt ? ` title="${escape(resetAbsolute(item.resetsAt))}"` : ''}>${Math.round(remaining)}% осталось${resetText(item)}</strong></div><div class="progress" role="progressbar" aria-valuenow="${Math.round(remaining)}" aria-valuemin="0" aria-valuemax="100" style="height:8px"><div class="progress-bar ${usageBar(item.usedPercent)}" style="width:${remaining}%"></div></div></div>`
    }).join('')
  } else {
    target.innerHTML = `<p class="text-body-secondary mb-0">${escape(usage.error || 'Нет данных о квоте')}</p>`
  }
}

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...options.headers }
  const settingsKey = sessionStorage.getItem('settingsKey')
  if (settingsKey) headers['x-settings-key'] = settingsKey
  const response = await fetch(path, { ...options, headers })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 401 && payload.error?.code === 'settings_auth') {
    const entered = await askSettingsKey(payload.error.message)
    if (!entered) throw new Error('Вход отменён')
    sessionStorage.setItem('settingsKey', entered)
    return api(path, options)
  }
  if (!response.ok) throw new Error(payload.error?.message ?? response.statusText)
  return payload
}

let settingsLogin
function askSettingsKey(message) {
  if (settingsLogin) return settingsLogin
  const dialog = document.querySelector('#settings-login')
  const input = document.querySelector('#settings-login-key')
  const status = document.querySelector('#settings-login-status')
  const cancel = document.querySelector('#settings-login-cancel')
  const form = dialog.querySelector('form')
  status.textContent = message === 'Неверный ключ настроек' ? message : ''
  input.value = ''
  settingsLogin = new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      form.onsubmit = null
      cancel.onclick = null
      dialog.removeEventListener('close', onClose)
      if (dialog.open) dialog.close()
      resolve(value)
    }
    const onClose = () => finish('')
    form.onsubmit = (event) => {
      event.preventDefault()
      const key = input.value.trim()
      if (!key) return
      finish(key)
    }
    cancel.onclick = () => finish('')
    dialog.addEventListener('close', onClose)
    dialog.showModal()
    input.focus()
  }).finally(() => { settingsLogin = null })
  return settingsLogin
}

function resetText(item) {
  if (!item.resetsAt) return ''
  const left = item.resetsAt - Date.now()
  if (left <= 0) return ' · сброс сейчас'
  const minutes = Math.floor(left / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const parts = []
  if (days) parts.push(`${days}д`)
  if (hours) parts.push(`${hours}ч`)
  if (!days && minutes % 60) parts.push(`${minutes % 60}м`)
  return ` · сброс через ${parts.join(' ') || 'меньше минуты'}`
}

function resetAbsolute(timestamp) {
  return `Сброс ${new Date(timestamp).toLocaleString()}`
}

function windowLabel(item) {
  const base = item.kind === 'session' ? 'Окно 5 часов' : item.kind === 'weekly' ? 'Неделя' : 'Окно'
  return item.scope ? `${base} · ${item.scope}` : base
}

function usageBar(percent) {
  if (percent >= 95) return 'bg-danger'
  if (percent >= 80) return 'bg-warning'
  return 'bg-success'
}

function networkNote(settings) {
  const port = settings.effectivePort || settings.port
  const page = settings.settingsExposure || 'localhost'
  if (settings.exposure === 'lan') {
    const addresses = settings.lanAddresses?.length ? settings.lanAddresses.map((ip) => `http://${ip}:${port}/v1`).join(', ') : 'адрес локальной сети не найден'
    return `Для других компьютеров сети: ${addresses}. Брандмауэр Windows может запросить разрешение.`
  }
  if (settings.exposure === 'internet') {
    return `Сервер слушает все сетевые интерфейсы. Проброс порта и брандмауэр настраиваются отдельно. ${settingsNote(settings)}`
  }
  if (page !== 'localhost') {
    const addresses = settings.lanAddresses?.length ? settings.lanAddresses.map((ip) => `http://${ip}:${port}/`).join(', ') : 'адрес локальной сети не найден'
    return `API отвечает только на этом компьютере. Страница настроек: ${addresses}.`
  }
  return 'Сервер отвечает только на этом компьютере.'
}

function settingsNote(settings) {
  return settingsAccessNote(settings.settingsExposure || 'localhost', settings.settingsKeyScope || 'internet')
}

function settingsAccessNote(exposure, scope) {
  if (exposure === 'localhost') return 'Страница настроек доступна только с этого компьютера. Ключ с него не спрашивается.'
  if (exposure === 'lan' && scope === 'lan') return 'Страница настроек открыта в локальной сети. С других компьютеров сети нужен ключ, с этого — нет.'
  if (exposure === 'lan') return 'Страница настроек открыта в локальной сети без ключа. Из интернета она не откроется.'
  if (scope === 'lan') return 'Страница настроек открыта из интернета. Ключ нужен и из локальной сети, и из интернета. С этого компьютера — нет.'
  return 'Страница настроек открыта из интернета. Ключ нужен только оттуда: в локальной сети и на этом компьютере он не спрашивается.'
}

function syncSettingsAccess() {
  const exposure = document.querySelector('#settings-exposure').value
  const scope = document.querySelector('#settings-key-scope').value
  const key = document.querySelector('#settings-key').value.trim()
  const needsKey = exposure === 'internet' || (exposure === 'lan' && scope === 'lan')
  document.querySelector('#remote-note').textContent = settingsAccessNote(exposure, scope)
  document.querySelector('#settings-key-note').textContent = needsKey && !key
    ? 'Укажите ключ: без него такой доступ к настройкам не сохранится.'
    : 'С этого компьютера ключ не спрашивается, чтобы нельзя было закрыть себе вход.'
}
document.querySelector('#settings-exposure').onchange = syncSettingsAccess
document.querySelector('#settings-key-scope').onchange = syncSettingsAccess
document.querySelector('#settings-key').oninput = syncSettingsAccess

function bindReveal(inputId, buttonId) {
  document.querySelector(buttonId).onclick = () => {
    const input = document.querySelector(inputId)
    const button = document.querySelector(buttonId)
    const hidden = input.type === 'password'
    input.type = hidden ? 'text' : 'password'
    button.title = hidden ? 'Скрыть' : 'Показать'
    button.setAttribute('aria-label', button.title)
  }
}
bindReveal('#api-key', '#show-key')
bindReveal('#settings-key', '#show-settings-key')
document.querySelector('#copy-key').onclick = async () => {
  await navigator.clipboard.writeText(document.querySelector('#api-key').value)
  document.querySelector('#port-status').textContent = 'Ключ скопирован'
}
document.querySelector('#copy-settings-key').onclick = async () => {
  await navigator.clipboard.writeText(document.querySelector('#settings-key').value)
  document.querySelector('#port-status').textContent = 'Ключ настроек скопирован'
}
document.querySelector('#regenerate-key').onclick = async () => {
  const status = document.querySelector('#port-status')
  status.textContent = 'Создаю ключ…'
  try {
    const saved = await api('/api/settings', { method: 'POST', body: JSON.stringify({ regenerateKey: true }) })
    document.querySelector('#api-key').value = saved.apiKey
    status.textContent = 'Новый ключ сохранён'
  } catch (error) {
    status.textContent = error.message
  }
}
document.querySelector('#regenerate-settings-key').onclick = async () => {
  const status = document.querySelector('#port-status')
  status.textContent = 'Создаю ключ настроек…'
  try {
    const saved = await api('/api/settings', { method: 'POST', body: JSON.stringify({ regenerateSettingsKey: true }) })
    document.querySelector('#settings-key').value = saved.settingsKey
    syncSettingsAccess()
    status.textContent = 'Новый ключ настроек сохранён'
  } catch (error) {
    status.textContent = error.message
  }
}
document.querySelector('#apply-port').onclick = async () => {
  const button = document.querySelector('#apply-port')
  const status = document.querySelector('#port-status')
  const port = Number(document.querySelector('#port').value.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    status.textContent = 'Порт должен быть числом от 1 до 65535'
    return
  }
  button.disabled = true
  status.textContent = 'Проверяю порт…'
  try {
    const saved = await api('/api/settings', { method: 'POST', body: JSON.stringify({ port }) })
    const unchanged = saved.url === `${location.origin}/`
    status.textContent = unchanged ? 'Этот порт уже используется приложением. Изменения не нужны.' : 'Порт свободен. Переключаю…'
    if (!unchanged) setTimeout(() => { location.href = saved.url }, 400)
  } catch (error) {
    status.textContent = error.message
  } finally {
    button.disabled = false
  }
}
const strategyName = { 'most-remaining': 'Где больше остаток', 'first-available': 'Первая с лимитом' }
const poolIcons = {
  grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="7" r="1.4"/><circle cx="15" cy="7" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="17" r="1.4"/><circle cx="15" cy="17" r="1.4"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m6 14 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 10 6 6 6-6"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
}
function poolModelName(id) {
  return poolCatalog.find((model) => model.id === id)?.name || ''
}
function pluralModels(count) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return `${count} модель`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} модели`
  return `${count} моделей`
}
function setPoolPicker(open) {
  document.querySelector('#pool-picker').hidden = !open
  document.querySelector('#pool-add-toggle').setAttribute('aria-expanded', String(open))
  if (open) document.querySelector('#pool-search').focus()
}
function movePoolMember(from, to) {
  if (from === to || from < 0 || to < 0 || from >= poolMembers.length || to >= poolMembers.length) return
  const [item] = poolMembers.splice(from, 1)
  poolMembers.splice(from < to ? to - 1 : to, 0, item)
  renderPoolPicked()
}
function renderPoolMembers() {
  const query = document.querySelector('#pool-search').value.trim().toLowerCase()
  const selected = new Set(poolMembers)
  const models = poolCatalog.filter((model) => !selected.has(model.id) && `${model.id} ${model.name} ${model.provider || ''}`.toLowerCase().includes(query))
  const box = document.querySelector('#pool-members')
  if (!models.length) {
    const empty = document.createElement('p')
    empty.className = 'text-body-secondary small mb-0 px-2 py-2'
    empty.textContent = poolCatalog.length && poolCatalog.every((model) => selected.has(model.id)) ? 'Все подходящие модели уже в пуле' : 'Ничего не найдено'
    box.replaceChildren(empty)
    return
  }
  box.replaceChildren(...models.map((model) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'list-group-item list-group-item-action text-start'
    button.innerHTML = `<code>${escape(model.id)}</code><small class="d-block text-body-secondary">${escape(model.name || model.provider || '')}</small>`
    button.onclick = () => {
      poolMembers.push(model.id)
      renderPoolPicked()
      renderPoolMembers()
    }
    return button
  }))
}
function renderPoolPicked() {
  const box = document.querySelector('#pool-picked')
  if (!poolMembers.length) {
    const empty = document.createElement('p')
    empty.className = 'text-body-secondary border rounded p-3 mb-0'
    empty.textContent = 'Добавьте хотя бы две модели'
    box.replaceChildren(empty)
    return
  }
  box.replaceChildren(...poolMembers.map((id, index) => {
    const row = document.createElement('div')
    row.className = 'list-group-item d-flex align-items-center gap-2 pool-member'
    const name = poolModelName(id)
    row.innerHTML = `<span class="pool-grip" title="Перетащите, чтобы изменить порядок">${poolIcons.grip}</span><span class="text-body-secondary small" style="width:1.25rem">${index + 1}</span><span class="min-w-0 flex-grow-1"><code>${escape(id)}</code>${name ? `<small class="d-block text-body-secondary">${escape(name)}</small>` : ''}</span><span class="pool-actions"><button type="button" class="btn btn-outline-secondary btn-icon" data-up title="Выше" aria-label="Выше"${index === 0 ? ' disabled' : ''}>${poolIcons.up}</button><button type="button" class="btn btn-outline-secondary btn-icon" data-down title="Ниже" aria-label="Ниже"${index === poolMembers.length - 1 ? ' disabled' : ''}>${poolIcons.down}</button><button type="button" class="btn btn-outline-secondary btn-icon" data-remove title="Убрать" aria-label="Убрать">${poolIcons.remove}</button></span>`
    const grip = row.querySelector('.pool-grip')
    grip.draggable = true
    grip.ondragstart = (event) => {
      poolDragIndex = index
      row.classList.add('dragging')
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(index))
    }
    grip.ondragend = () => {
      poolDragIndex = -1
      row.classList.remove('dragging')
    }
    row.ondragover = (event) => {
      if (poolDragIndex < 0) return
      event.preventDefault()
      row.classList.add('drag-over')
    }
    row.ondragleave = () => row.classList.remove('drag-over')
    row.ondrop = (event) => {
      event.preventDefault()
      row.classList.remove('drag-over')
      const from = poolDragIndex >= 0 ? poolDragIndex : Number(event.dataTransfer.getData('text/plain'))
      movePoolMember(from, index)
    }
    row.querySelector('[data-up]').onclick = () => movePoolMember(index, index - 1)
    row.querySelector('[data-down]').onclick = () => movePoolMember(index, index + 1)
    row.querySelector('[data-remove]').onclick = () => {
      poolMembers.splice(index, 1)
      renderPoolPicked()
      renderPoolMembers()
    }
    return row
  }))
}
function openPoolDialog(pool) {
  const form = document.querySelector('#pool-form')
  poolEditingId = pool?.id ?? null
  poolMembers = pool ? [...pool.members] : []
  form.reset()
  form.elements.id.value = pool?.id ?? ''
  form.elements.strategy.value = pool?.strategy === 'first-available' ? 'first-available' : 'most-remaining'
  document.querySelector('#pool-dialog-title').textContent = pool ? 'Редактировать пул' : 'Новый пул'
  document.querySelector('#pool-status').textContent = ''
  document.querySelector('#pool-search').value = ''
  setPoolPicker(false)
  renderPoolPicked()
  renderPoolMembers()
  document.querySelector('#pool-dialog').showModal()
  if (!pool) form.elements.id.focus()
}
async function loadPools() {
  const [catalog, pools] = await Promise.all([api('/api/catalog'), api('/api/pools')])
  poolCatalog = catalog.data.filter((model) => model.capability === 'chat' && model.enabled)
  const list = document.querySelector('#pool-list')
  list.replaceChildren(...(pools.data.length ? pools.data.map((pool) => {
    const card = document.createElement('article')
    card.className = 'card shadow-sm pool-card'
    card.innerHTML = `<div class="card-body d-flex justify-content-between align-items-start gap-3"><div class="min-w-0"><code>pool/${escape(pool.id)}</code><small class="d-block text-body-secondary">${escape(strategyName[pool.strategy] || pool.strategy)} · ${pluralModels(pool.members.length)}</small><ol class="small text-body-secondary mb-0 mt-2 ps-3">${pool.members.map((id) => `<li><code>${escape(id)}</code></li>`).join('')}</ol></div><div class="d-flex gap-2 flex-none"><button type="button" class="btn btn-outline-secondary btn-icon" data-edit title="Редактировать" aria-label="Редактировать">${poolIcons.pencil}</button><button type="button" class="btn btn-outline-secondary btn-sm" data-delete>Удалить</button></div></div>`
    card.querySelector('[data-edit]').onclick = () => openPoolDialog(pool)
    card.querySelector('[data-delete]').onclick = async () => {
      await api(`/api/pools/${encodeURIComponent(pool.id)}`, { method: 'DELETE' })
      await loadPools()
    }
    return card
  }) : [Object.assign(document.createElement('p'), { className: 'text-body-secondary border rounded p-3 mb-0', textContent: 'Пока нет сохранённых пулов' })]))
}
document.querySelector('#open-pool').onclick = () => openPoolDialog()
document.querySelector('[data-pool-close]').onclick = () => document.querySelector('#pool-dialog').close()
document.querySelector('#pool-add-toggle').onclick = () => setPoolPicker(document.querySelector('#pool-picker').hidden)
document.querySelector('#pool-search').oninput = () => renderPoolMembers()
document.querySelector('#pool-search').onkeydown = (event) => {
  if (event.key === 'Enter') event.preventDefault()
}
document.addEventListener('click', (event) => {
  const picker = document.querySelector('#pool-picker')
  if (!picker || picker.hidden) return
  if (event.target.closest('#pool-picker, #pool-add-toggle')) return
  setPoolPicker(false)
})
document.querySelector('#pool-dialog').addEventListener('close', () => setPoolPicker(false))
document.querySelector('#pool-form').onsubmit = async (event) => {
  event.preventDefault()
  const status = document.querySelector('#pool-status')
  const form = new FormData(event.currentTarget)
  if (poolMembers.length < 2) {
    status.textContent = 'В пуле нужны хотя бы две модели'
    return
  }
  try {
    const saved = await api('/api/pools', {
      method: 'POST',
      body: JSON.stringify({
        id: form.get('id'),
        strategy: form.get('strategy'),
        members: poolMembers,
      }),
    })
    if (poolEditingId && poolEditingId !== saved.id) await api(`/api/pools/${encodeURIComponent(poolEditingId)}`, { method: 'DELETE' })
    status.textContent = ''
    document.querySelector('#pool-dialog').close()
    await loadPools()
  } catch (error) {
    status.textContent = error.message
  }
}
document.querySelector('#save-full').onchange = async (event) => {
  const enabled = event.currentTarget.checked
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ saveFullRequest: enabled }) })
    if (!enabled) document.querySelector('#open-full').disabled = true
  } catch (error) {
    event.currentTarget.checked = !enabled
    document.querySelector('#port-status').textContent = error.message
  }
}
document.querySelector('#open-full').onclick = async () => {
  const full = await api('/api/requests/last')
  document.querySelector('#full-request').textContent = full.request || 'Пусто'
  document.querySelector('#full-response').textContent = full.response || 'Пусто'
  document.querySelector('#full-log').showModal()
}
document.querySelector('#settings-form').onsubmit = async (event) => {
  event.preventDefault()
  const status = document.querySelector('#port-status')
  status.textContent = 'Сохраняю…'
  try {
    const form = new FormData(event.currentTarget)
    const saved = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        exposure: form.get('exposure'),
        authMode: form.get('authMode'),
        settingsExposure: form.get('settingsExposure'),
        settingsKeyScope: form.get('settingsKeyScope'),
        settingsKey: form.get('settingsKey'),
        apiKey: form.get('apiKey'),
      }),
    })
    status.textContent = 'Сохранено'
    if (saved.url && saved.url !== `${location.origin}/`) setTimeout(() => { location.href = saved.url }, 400)
    else await load()
  } catch (error) {
    status.textContent = error.message
  }
}

function setLink(selector, href) {
  const link = document.querySelector(selector)
  link.href = href
  link.textContent = href
}

function curlExample(base, key) {
  const auth = key ? ` \\\n  -H "Authorization: Bearer ${key}"` : ''
  return `curl ${base}/chat/completions${auth} \\\n  -H "Content-Type: application/json" \\\n  -d "{\\"model\\":\\"codex/gpt-5\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Привет\\"}]}"`
}

async function copyText(value, button) {
  await navigator.clipboard.writeText(value)
  const previous = button.textContent
  button.title = 'Скопировано'
  setTimeout(() => { button.title = previous }, 1200)
}

document.querySelectorAll('[data-copy-target]').forEach((button) => {
  button.onclick = async () => {
    const target = document.getElementById(button.dataset.copyTarget)
    await copyText(target.tagName === 'A' ? target.href : target.textContent, button)
  }
})
document.querySelectorAll('.url-line a').forEach((link) => {
  link.onclick = (event) => {
    if (link.id === 'link-chat') event.preventDefault()
  }
})

function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

journalPending.onclick = () => {
  if (!pendingJournal) return
  applyJournal(pendingJournal)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
const journalTab = document.querySelector('#tab-journal')
journalTab.addEventListener('pointerdown', noteJournalActivity)
journalTab.addEventListener('wheel', noteJournalActivity, { passive: true })
journalTab.addEventListener('keydown', noteJournalActivity)
requests.addEventListener('toggle', () => { setTimeout(releaseJournal, 0) })
document.querySelector('#full-log').addEventListener('close', releaseJournal)
document.addEventListener('selectionchange', () => { if (pendingJournal) releaseJournal() })
window.addEventListener('scroll', () => {
  if (!journalWatch || !pendingJournal) return
  clearTimeout(journalReleaseTimer)
  journalReleaseTimer = setTimeout(releaseJournal, 180)
}, { passive: true })
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  if (journalWatch) refreshJournal()
  if (limitsDue) refreshLimits()
  tickSideResets()
})
setInterval(tickSideResets, 60 * 1000)
setInterval(() => { if (journalWatch && !document.hidden) refreshJournal() }, 4000)
load().catch((error) => {
  const status = document.querySelector('#port-status')
  if (status) status.textContent = error.message
}).finally(() => {
  appReady = true
  if (journalWatch) refreshJournal()
})
