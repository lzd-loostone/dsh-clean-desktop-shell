/** Pure DTO/selection/controller ports. No SDK, React, Slot or Remote binding. */
const INVALID = 'DELEGATION_INVALID_DTO'
const FAILED = 'DELEGATION_REMOTE_FAILED'
const states = new Set(['needs-config', 'publishing', 'active', 'failed'])
function fail(code = INVALID) { throw new TypeError(code) }
function ordinary(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key))) fail()
  }
  return value
}
function text(value) {
  if (typeof value !== 'string' || !value.trim()) fail()
  return value
}
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) fail(); return value }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function projectRoute(value) {
  if (value === null) return null
  ordinary(value)
  const result = { provider: text(value.provider), model: text(value.model) }
  if (Object.hasOwn(value, 'reasoningEffort')) result.reasoningEffort = text(value.reasoningEffort)
  return freeze(result)
}
// Frozen public union: publisher failure codes plus the gate diagnostics. Every other value,
// including raw or credential-shaped text, degrades to a generic failure.
export const PUBLIC_ERROR_CODES = Object.freeze(['INVALID_WORKER_ROUTE', 'WORKER_ROUTE_VALIDATION_FAILED',
  'PRESET_BUILD_FAILED', 'PRESET_RETIRE_FAILED', 'PRESET_REGISTER_FAILED', 'PRESET_HEALTH_FAILED',
  'PUBLISHER_STOPPED', 'WORKER_ROUTE_UNCONFIGURED', 'WORKER_ROUTE_RECOVERY_UNCONFIRMED',
  'WORKER_ROUTE_APPROVAL_UNAVAILABLE'])
const PUBLIC_CODES = new Set(PUBLIC_ERROR_CODES)
const LABEL_ERROR_CODES = new Set([...PUBLIC_ERROR_CODES, INVALID, FAILED])
function publicCode(value) {
  return PUBLIC_CODES.has(value) ? value : FAILED
}
// Locale keys of every user-visible label. The values below are the provisional Chinese copy; the
// formal client resolves these keys through the harness locale service (zh + en) and passes the
// result back as `labels`. The frozen DTO/status shapes never carry UI copy.
export const LABEL_KEYS = Object.freeze({
  savedRoute: 'delegation.savedRoute',
  publishedRoute: 'delegation.publishedRoute',
  modelDefault: 'delegation.modelDefault',
  truncated: 'delegation.truncated',
  saveAccepted: 'delegation.saveAccepted',
  loading: 'delegation.status.loading',
  unavailable: 'delegation.status.unavailable',
  needsConfig: 'delegation.status.needsConfig',
  publishing: 'delegation.status.publishing',
  publishingUnavailable: 'delegation.status.publishingUnavailable',
  active: 'delegation.status.active',
  failed: 'delegation.status.failed',
  failedRetained: 'delegation.status.failedRetained',
  stopped: 'delegation.status.stopped',
  catalogueEmpty: 'delegation.status.catalogueEmpty',
})
export const DEFAULT_LABELS = Object.freeze({
  savedRoute: '已保存配置',
  publishedRoute: '已发布执行配置',
  modelDefault: '模型默认',
  truncated: '目录已截断，仅显示部分选项',
  saveAccepted: '保存已接受，发布状态由状态流确认',
  loading: '正在读取分工设置',
  unavailable: '分工设置不可用',
  needsConfig: '需要配置 worker 路由',
  publishing: '发布中',
  publishingUnavailable: '暂不可用，正在发布',
  active: '已生效',
  failed: '发布失败',
  failedRetained: '上一次发布仍然生效，本次发布失败',
  stopped: '发布已停止',
  catalogueEmpty: '暂不可用，没有可用选项',
})
const STATE_LABEL_FIELDS = Object.freeze({ 'needs-config': 'needsConfig', publishing: 'publishing', active: 'active' })
/** The state-level label key of one projected status; a failed republish that kept its publication
 * is spelled out instead of being collapsed into the generic failure copy, and a stopped publisher
 * is named as stopped rather than as a retryable failure. */
export function statusLabelKey(value) {
  const status = projectDelegationStatus(value)
  if (status.state === 'failed') {
    if (status.publishedRoute === null && status.error === 'PUBLISHER_STOPPED') return LABEL_KEYS.stopped
    return status.publishedRoute === null ? LABEL_KEYS.failed : LABEL_KEYS.failedRetained
  }
  return LABEL_KEYS[STATE_LABEL_FIELDS[status.state]]
}
/** The label key of one public error code; unknown or credential-shaped text keeps the generic key. */
export function errorLabelKey(code) {
  return 'delegation.error.' + (LABEL_ERROR_CODES.has(code) ? code : FAILED)
}
function mergeLabels(overrides) {
  const merged = { ...DEFAULT_LABELS }
  if (overrides === undefined || overrides === null) return freeze(merged)
  try {
    ordinary(overrides)
    for (const field of Object.keys(DEFAULT_LABELS)) {
      if (!Object.hasOwn(overrides, field)) continue
      const value = overrides[field]
      if (typeof value === 'string' && value.trim()) merged[field] = value
    }
  } catch { /* An unusable override object keeps the default copy instead of breaking the UI. */ }
  return freeze(merged)
}
/** Resolve every label through a locale translate function; an unresolved key fails closed rather
 * than rendering the dictionary key as visible copy. */
export function labelsFrom(translate) {
  if (typeof translate !== 'function') fail(FAILED)
  const labels = {}
  for (const [field, key] of Object.entries(LABEL_KEYS)) {
    const value = translate(key)
    if (typeof value !== 'string' || !value.trim() || value === key) fail(FAILED)
    labels[field] = value
  }
  return freeze(labels)
}
export function projectDelegationStatus(value) {
  ordinary(value)
  if (!states.has(value.state) || (value.state === 'active' && value.publishedRoute === null)) fail()
  if (value.error !== null && typeof value.error !== 'string') fail()
  return freeze({
    settingsNs: value.settingsNs === null ? null : text(value.settingsNs), state: value.state,
    savedRoute: projectRoute(value.savedRoute), publishedRoute: projectRoute(value.publishedRoute),
    generation: value.generation === null ? null : integer(value.generation),
    error: value.error === null ? null : publicCode(value.error),
    // Missing field (older Host) means enabled: the shortcut is opt-out.
    runningCapsule: value.runningCapsule !== false,
  })
}
function projectRows(value, key) {
  ordinary(value)
  const rows = value[key]
  if (!Array.isArray(rows) || rows.length > 4096 || typeof value.truncated !== 'boolean') fail()
  const total = integer(value.total)
  if (total < rows.length || value.truncated !== (total > rows.length)) fail()
  const ids = new Set()
  const items = []
  for (const row of rows) {
    ordinary(row)
    const id = text(row.id)
    if (ids.has(id)) fail()
    ids.add(id)
    items.push({ id, name: text(row.name) })
  }
  return { [key]: items, total, truncated: value.truncated }
}
/**
 * The header capsule's list: running direct children, newest first, capped.
 * `entries` is the session projection's subagentCatalog; `running` answers
 * whether a child id is executing right now (sessionStatus / running map).
 * Pure and free of React so the ordering rule is tested, not eyeballed.
 * @param {unknown} entries
 * @param {(id: string) => boolean} running
 * @param {number} [limit]
 * @returns {{id: string, label: string, startedAt: number|null}[]}
 */
export function projectRunningChildren(entries, running, limit = RUNNING_CAPSULE_LIMIT) {
  const rows = Array.isArray(entries) ? entries : []
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : RUNNING_CAPSULE_LIMIT
  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id : ''
    if (!id) continue
    if (typeof running === 'function' && running(id) !== true) continue
    out.push(freeze({
      id,
      label: typeof row.label === 'string' && row.label ? row.label : id,
      startedAt: typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) ? row.startedAt : null,
    }))
  }
  // Newest first: the child that just started is the one the human is looking
  // for, and it is exactly the one the built-in dropdown buries at the bottom.
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  // Cap after sorting: capping first would keep the oldest ones and drop the
  // very child the human is waiting for.
  return freeze(out.slice(0, cap))
}

export const RUNNING_CAPSULE_LIMIT = 8

export function projectWorkerCatalogue(value) { return freeze(projectRows(value, 'items')) }
export function projectWorkerEfforts(value) {
  const result = projectRows(value, 'efforts')
  const defaultEffort = value.defaultEffort === null ? null : text(value.defaultEffort)
  if (defaultEffort !== null && !result.truncated && !result.efforts.some(item => item.id === defaultEffort)) fail()
  return freeze({ efforts: result.efforts, defaultEffort, total: result.total, truncated: result.truncated })
}
export function readDelegationResult(value, project) {
  try { ordinary(value) } catch { fail(FAILED) }
  if (value.ok !== true || !Object.hasOwn(value, 'value')) fail(FAILED)
  return project(value.value)
}
/**
 * @param {{read?: {
 * describeDelegation(signal: AbortSignal): Promise<unknown>,
 * listWorkerProviders(signal: AbortSignal): Promise<unknown>,
 * listWorkerModels(providerId: string, signal: AbortSignal): Promise<unknown>,
 * listWorkerEfforts(providerId: string, modelId: string, signal: AbortSignal): Promise<unknown>
 * }, observeDelegation?: (onValue: Function, onError: Function, signal: AbortSignal) => Function|Promise<Function>,
 * mutateWorkerRoute?: (settingsNs: string, ops: object[], expectedRevision: string|number) => Promise<boolean>,
 * labels?: Record<string, string>}} ports
 * observeDelegation is a pure callback port, NOT the SDK watchDelegation handle.
 * A later adapter must consume the proven handle and await its owned cleanup.
 * mutateWorkerRoute must later use only configForms.get(ns).mutate(ops, revision).
 * labels carries locale-resolved copy for LABEL_KEYS fields; anything unusable keeps DEFAULT_LABELS.
 */
export function createDelegationSettingsController(ports = {}) {
  const emptyCatalogue = freeze({ items: [], total: 0, truncated: false })
  const emptyEfforts = freeze({ efforts: [], defaultEffort: null, total: 0, truncated: false })
  const blankSelection = () => ({ provider: '', model: '', reasoningEffort: '' })
  const blankForm = () => ({ ready: false, writable: false, revision: null })
  let state = {
    connection: 'idle', status: null, providers: emptyCatalogue, models: emptyCatalogue,
    efforts: emptyEfforts, selection: blankSelection(), form: blankForm(),
    modelsLoading: false, effortsLoading: false, saving: false, saveState: 'idle', error: null,
    errorDetail: null,
    labels: mergeLabels(ports.labels),
  }
  let closed = false, epoch = 0, selectionEpoch = 0, writeEpoch = 0
  let rootController = null, modelsController = null, effortsController = null, observerCleanup = null, disposalPromise = null
  const listeners = new Set()
  const live = n => !closed && n === epoch
  const getSnapshot = () => freeze({ ...state })
  function update(patch) {
    state = { ...state, ...patch }
    const snapshot = getSnapshot()
    for (const listener of listeners) { try { listener(snapshot) } catch { /* isolate observers */ } }
  }
  function invalidateSave() {
    writeEpoch++
    update({ saving: false, saveState: 'idle' })
  }
  function abortDirectories() {
    modelsController?.abort(); effortsController?.abort()
    modelsController = null; effortsController = null
    selectionEpoch++
  }
/** One bounded line for the card that carries structure but never free-form text.
   * An error message can echo a provider payload or a credential, so only the machine code is
   * retained; the raw failure stays in the developer console.
   */
  function describeFailure(err) {
    if (err === null || err === undefined) return null
    const code = typeof err.code === 'string' ? err.code : ''
    const name = typeof err.name === 'string' && err.name !== 'Error' ? err.name : ''
    const text = [name, code].filter(Boolean).join(' / ').slice(0, 120)
    return text || null
  }
  function unavailable(code = FAILED, detail = null) {
    invalidateSave(); abortDirectories()
    update({ connection: 'unavailable', modelsLoading: false, effortsLoading: false, error: code, errorDetail: detail })
  }
  async function cleanup(disposer) {
    if (!disposer) return true
    try { await disposer(); return true } catch { return false }
  }
  function selected(id, rows) { return typeof id === 'string' && rows.some(item => item.id === id) }
  async function chooseProvider(providerId) {
    if (closed || state.connection !== 'ready' ||
      (providerId !== '' && !selected(providerId, state.providers.items))) return false
    if (providerId === state.selection.provider) return true
    abortDirectories(); invalidateSave()
    const n = epoch, choice = selectionEpoch
    update({ selection: { provider: providerId, model: '', reasoningEffort: '' },
      models: emptyCatalogue, efforts: emptyEfforts, modelsLoading: providerId !== '', effortsLoading: false, error: null })
    if (!providerId) return true
    const controller = new AbortController(); modelsController = controller
    try {
      const reply = await ports.read.listWorkerModels(providerId, controller.signal)
      if (!live(n) || choice !== selectionEpoch || controller.signal.aborted) return false
      update({ models: readDelegationResult(reply, projectWorkerCatalogue), modelsLoading: false })
      return true
    } catch {
      if (live(n) && choice === selectionEpoch && !controller.signal.aborted) {
        update({ models: emptyCatalogue, modelsLoading: false, error: FAILED })
      }
      return false
    }
  }
  async function chooseModel(modelId) {
    if (closed || state.connection !== 'ready' || state.modelsLoading ||
      (modelId !== '' && !selected(modelId, state.models.items))) return false
    if (modelId === state.selection.model) return true
    effortsController?.abort(); selectionEpoch++; invalidateSave()
    const n = epoch, choice = selectionEpoch, providerId = state.selection.provider
    update({ selection: { provider: providerId, model: modelId, reasoningEffort: '' },
      efforts: emptyEfforts, effortsLoading: modelId !== '', error: null })
    if (!modelId) return true
    const controller = new AbortController(); effortsController = controller
    try {
      const reply = await ports.read.listWorkerEfforts(providerId, modelId, controller.signal)
      if (!live(n) || choice !== selectionEpoch || controller.signal.aborted) return false
      update({ efforts: readDelegationResult(reply, projectWorkerEfforts), effortsLoading: false })
      return true
    } catch {
      if (live(n) && choice === selectionEpoch && !controller.signal.aborted) {
        update({ selection: { provider: providerId, model: '', reasoningEffort: '' },
          efforts: emptyEfforts, effortsLoading: false, error: FAILED })
      }
      return false
    }
  }
  function chooseEffort(reasoningEffort) {
    if (closed || state.connection !== 'ready' || !state.selection.model || state.effortsLoading ||
      (reasoningEffort !== '' && !selected(reasoningEffort, state.efforts.efforts))) return false
    if (reasoningEffort !== state.selection.reasoningEffort) {
      invalidateSave()
      update({ selection: { provider: state.selection.provider, model: state.selection.model, reasoningEffort } })
    }
    return true
  }
  function setFormSnapshot(value) {
    if (closed) return
    let form = blankForm()
    try {
      ordinary(value)
      if (typeof value.ready !== 'boolean' || typeof value.writable !== 'boolean') fail()
      const revision = typeof value.revision === 'string' && value.revision.trim() ? value.revision
        : Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : null
      form = { ready: value.ready, writable: value.writable, revision }
    } catch { /* invalid form stays unavailable */ }
    if (form.ready !== state.form.ready || form.writable !== state.form.writable || form.revision !== state.form.revision) {
      // A revision that moves under a PENDING write supersedes that write. Once the write has
      // settled, its acceptance stands: the form revision then advances *because* of it, and the
      // adapter re-pushes the refreshed revision for the next fence.
      writeEpoch++
      if (state.saving) update({ saving: false, saveState: 'idle' })
    }
    update({ form })
  }
  async function connect() {
    if (closed) return false
    const n = ++epoch
    rootController?.abort(); abortDirectories(); invalidateSave()
    const previous = observerCleanup; observerCleanup = null
    update({ connection: 'loading', status: null, providers: emptyCatalogue, models: emptyCatalogue,
      efforts: emptyEfforts, selection: blankSelection(), form: blankForm(),
      modelsLoading: false, effortsLoading: false, error: null })
    if (!await cleanup(previous)) { if (live(n)) unavailable('DELEGATION_CLEANUP_FAILED'); return false }
    if (!live(n)) return false
    const root = new AbortController(); rootController = root
    if (!ports.read || ['describeDelegation', 'listWorkerProviders', 'listWorkerModels', 'listWorkerEfforts']
      .some(name => typeof ports.read[name] !== 'function') || typeof ports.observeDelegation !== 'function') {
      unavailable('DELEGATION_UNAVAILABLE'); return false
    }
    try {
      const reply = await ports.read.describeDelegation(root.signal)
      if (!live(n)) return false
      const status = readDelegationResult(reply, projectDelegationStatus)
      const providerReply = await ports.read.listWorkerProviders(root.signal)
      if (!live(n)) return false
      update({ connection: 'ready', status, providers: readDelegationResult(providerReply, projectWorkerCatalogue) })
      const saved = status.savedRoute
      if (saved && selected(saved.provider, state.providers.items)) {
        const providerReady = await chooseProvider(saved.provider)
        if (!live(n)) return false
        if (providerReady && state.selection.provider === saved.provider && selected(saved.model, state.models.items)) {
          const modelReady = await chooseModel(saved.model)
          if (!live(n)) return false
          if (modelReady && state.selection.provider === saved.provider &&
            state.selection.model === saved.model && saved.reasoningEffort) chooseEffort(saved.reasoningEffort)
        }
      }
      const disposer = await ports.observeDelegation(value => {
        if (!live(n) || root.signal.aborted) return
        try {
          const next = projectDelegationStatus(value)
          if (next.settingsNs !== state.status?.settingsNs) {
            invalidateSave(); update({ form: blankForm() })
          }
          update({ status: next })
        } catch { unavailable(INVALID) }
      }, () => { if (live(n) && !root.signal.aborted) unavailable() }, root.signal)
      if (!live(n)) { await cleanup(disposer); return false }
      if (typeof disposer !== 'function') { unavailable('DELEGATION_UNAVAILABLE'); return false }
      observerCleanup = disposer
      return state.connection === 'ready'
    } catch (err) {
      // Keep the exact Remote failure next to the friendly code: a card that only says
      // "unavailable" makes a real adapter bug invisible to the person reporting it.
      if (live(n)) unavailable(FAILED, describeFailure(err))
      return false
    }
  }
  async function save() {
    const form = state.form, selection = state.selection, ns = state.status?.settingsNs
    if (closed || state.connection !== 'ready' || state.saving || state.modelsLoading || state.effortsLoading ||
      !form.ready || !form.writable || form.revision === null || !ns || typeof ports.mutateWorkerRoute !== 'function' ||
      !selected(selection.provider, state.providers.items) || !selected(selection.model, state.models.items) ||
      (selection.reasoningEffort && !selected(selection.reasoningEffort, state.efforts.efforts))) return false
    const route = { provider: selection.provider, model: selection.model }
    if (selection.reasoningEffort) route.reasoningEffort = selection.reasoningEffort
    const n = epoch, write = ++writeEpoch
    update({ saving: true, saveState: 'saving', error: null })
    try {
      const accepted = await ports.mutateWorkerRoute(ns, [{ op: 'set', path: ['workerRoute'], value: freeze(route) }], form.revision)
      if (!live(n) || write !== writeEpoch) return false
      update({ saving: false, saveState: accepted === true ? 'accepted' : 'rejected',
        error: accepted === true ? null : 'DELEGATION_SAVE_REJECTED' })
      return accepted === true
    } catch {
      if (live(n) && write === writeEpoch) update({ saving: false, saveState: 'failed', error: 'DELEGATION_SAVE_FAILED' })
      return false
    }
  }
  /**
   * Persist the header-shortcut switch. Same write face as workerRoute: one
   * config op against the revision the form last reported.
   * @param {boolean} next
   * @returns {Promise<boolean>}
   */
  async function saveCapsule(next) {
    const form = state.form, ns = state.status?.settingsNs
    if (closed || state.connection !== 'ready' || state.saving || !form.ready || !form.writable ||
      form.revision === null || !ns || typeof ports.mutateWorkerRoute !== 'function') return false
    const n = epoch, write = ++writeEpoch
    update({ saving: true, saveState: 'saving', error: null })
    try {
      const accepted = await ports.mutateWorkerRoute(ns, [{ op: 'set', path: ['runningCapsule'], value: next === true }], form.revision)
      if (!live(n) || write !== writeEpoch) return false
      update({ saving: false, saveState: accepted === true ? 'accepted' : 'rejected',
        error: accepted === true ? null : 'DELEGATION_SAVE_REJECTED' })
      return accepted === true
    } catch {
      if (live(n) && write === writeEpoch) update({ saving: false, saveState: 'failed', error: 'DELEGATION_SAVE_FAILED' })
      return false
    }
  }
  function dispose() {
    if (disposalPromise) return disposalPromise
    closed = true; epoch++; rootController?.abort(); abortDirectories(); invalidateSave()
    update({ connection: 'unavailable', modelsLoading: false, effortsLoading: false })
    listeners.clear()
    const disposer = observerCleanup; observerCleanup = null
    disposalPromise = cleanup(disposer).then(ok => { if (!ok) update({ error: 'DELEGATION_CLEANUP_FAILED' }) })
    return disposalPromise
  }
  return { getSnapshot, connect, chooseProvider, chooseModel, chooseEffort, setFormSnapshot, save, saveCapsule, dispose,
    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener); listener(getSnapshot())
      return () => { listeners.delete(listener) }
    },
  }
}
