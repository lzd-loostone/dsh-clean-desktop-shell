/**
 * Shell config persistence (userData/config.json).
 *
 * Fields:
 *  - targetUrl:    DEFAULT_TARGET_URL — set to any remote DSH address to
 *                  run the shell as a pure window.
 *  - closeToTray:  default true.
 *  - backendPath:  folder containing the dsh CLI (tray "set backend folder").
 *  - shortcutAsked: true once the first-run shortcut prompt was shown.
 *
 * Persistence is atomic (tmp file + rename) and load-time type-checked, so
 * a crash mid-write or a hand-edited file can never poison the shell.
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Single source of truth for the local dsh web endpoint. Every module that
// needs the default URL or its port imports it from here — no duplicated
// literals.
export const DEFAULT_TARGET_URL = 'http://127.0.0.1:3080'

const DEFAULTS = {
  targetUrl: DEFAULT_TARGET_URL,
  closeToTray: true,
  backendPath: null,
  // True once the first-run "create a desktop shortcut?" prompt was shown
  // (so it never nags again). The tray item stays available regardless.
  shortcutAsked: false,
  // Task overlay window (GPU-monitor style always-on-top status card).
  //  pos: null → auto (top-right of the primary display); set by dragging.
  overlay: {
    enabled: true,
    opacity: 0.86,
    theme: 'dark', // 'dark' | 'light'
    fontSize: 13,
    pos: null,
    // width: null → default 280; set by dragging the right edge.
    // Height always adapts to the row count — no user height.
    width: null,
  },
}

let cached = null

function configPath() {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig() {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
    // Keep only known fields with expected types — unknown/legacy keys
    // (e.g. the never-wired `windowMode`) are dropped on the next save.
    cached = { ...DEFAULTS }
    if (typeof parsed.targetUrl === 'string' && parsed.targetUrl) cached.targetUrl = parsed.targetUrl
    if (typeof parsed.closeToTray === 'boolean') cached.closeToTray = parsed.closeToTray
    if (typeof parsed.backendPath === 'string' || parsed.backendPath === null) cached.backendPath = parsed.backendPath
    if (typeof parsed.shortcutAsked === 'boolean') cached.shortcutAsked = parsed.shortcutAsked
    // Overlay: per-field validated; anything unknown falls back to the
    // default. A hand-corrupted file can never poison the overlay.
    if (parsed.overlay && typeof parsed.overlay === 'object') {
      const o = { ...DEFAULTS.overlay }
      const src = parsed.overlay
      if (typeof src.enabled === 'boolean') o.enabled = src.enabled
      if (typeof src.opacity === 'number' && src.opacity >= 0.2 && src.opacity <= 1) o.opacity = src.opacity
      if (src.theme === 'dark' || src.theme === 'light') o.theme = src.theme
      if (typeof src.fontSize === 'number' && src.fontSize >= 11 && src.fontSize <= 18) o.fontSize = Math.round(src.fontSize)
      if (src.pos && typeof src.pos.x === 'number' && typeof src.pos.y === 'number') o.pos = { x: Math.round(src.pos.x), y: Math.round(src.pos.y) }
      if (typeof src.width === 'number' && src.width >= 220 && src.width <= 640) o.width = Math.round(src.width)
      cached.overlay = o
    }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

/** Current overlay settings (validated view of config.overlay). */
export function loadOverlay() {
  return { ...DEFAULTS.overlay, ...loadConfig().overlay }
}

/** Merge a patch into the overlay block and persist. Returns the new block. */
export function saveOverlay(patch) {
  const cur = loadConfig()
  const next = { ...cur, overlay: { ...cur.overlay, ...patch } }
  saveConfig(next)
  return loadOverlay()
}

export function saveConfig(next) {
  cached = { ...DEFAULTS, ...next }
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  // Atomic persistence: write a sibling tmp file, then rename over the real
  // one (rename is atomic within a volume). A crash mid-write leaves the
  // old config intact instead of a truncated file.
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(cached, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows rename can briefly fail with EPERM/EBUSY (AV scan) — drop the
    // target and retry; fall back to a non-atomic write as a last resort.
    try {
      rmSync(file, { force: true })
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, JSON.stringify(cached, null, 2), 'utf8')
    }
  }
  return cached
}
