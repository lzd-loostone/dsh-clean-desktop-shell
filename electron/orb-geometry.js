/**
 * dsh-clean-desktop-shell — orb window geometry (pure, Electron-free).
 *
 * The single place that turns overlay config + work area into orb window
 * positions. Every exported function is total: whatever garbage the
 * persisted config carries (NaN/undefined/out-of-range), the result is
 * always a finite integer — a bad config can no longer reach
 * BrowserWindow.setPosition and throw "setPosition NaN" mid-slide.
 */

/** Allowed orb diameter range (mirrors settings slider). */
export const ORB_MIN = 40
export const ORB_MAX = 96
/** Fallback diameter when the stored value is missing or not a number. */
export const ORB_DEFAULT = 56

function fin(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Plain numeric clamp (no NaN guard — callers pass validated inputs). */
export function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * Orb container side: clamped diameter + ring/badge headroom on each side.
 * @param {{orbSize?: unknown}|undefined|null} cfg - overlay config block.
 * @param {number} margin - transparent headroom (ORB_MARGIN).
 * @returns {number} always a finite integer.
 */
export function orbArea(cfg, margin) {
  const size = cfg && fin(cfg.orbSize) ? cfg.orbSize : ORB_DEFAULT
  const m = fin(margin) ? margin : 8
  return Math.round(clamp(size, ORB_MIN, ORB_MAX)) + m * 2
}

/**
 * Orb window x. Snap mode: docked at `side`'s edge. Free mode: the dragged
 * `pos.x` when usable, else the right-edge default; always clamped inside.
 * @param {{edgeSnap?: boolean}} cfg
 * @param {{x:number,width:number}} wa - work area.
 * @param {'left'|'right'} side - docked edge (snap mode).
 * @param {{x?: unknown, y?: unknown}|null} pos - free-mode window origin.
 * @param {number} margin - ORB_MARGIN.
 * @returns {number} finite integer x.
 */
export function orbWinX(cfg, wa, side, pos, margin) {
  const s = orbArea(cfg, margin)
  const wx = fin(wa && wa.x) ? wa.x : 0
  const ww = fin(wa && wa.width) ? wa.width : s
  let out
  if (cfg && cfg.edgeSnap) {
    out = side === 'left' ? wx : wx + ww - s
  } else {
    const px = pos && fin(pos.x) ? pos.x : wx + ww - s
    out = clamp(px, wx, Math.max(wx, wx + ww - s))
  }
  return fin(out) ? Math.round(out) : wx
}

/**
 * Orb window y. Usable anchorY/pos.y first (per mode), then the wa.y+16
 * default; clamped so the whole square stays inside the work area.
 * @param {{edgeSnap?: boolean}} cfg
 * @param {{x?: number,y:number,width?:number,height:number}} wa
 * @param {number|null|undefined} anchorY - snap-mode orb top y.
 * @param {{x?: unknown, y?: unknown}|null} pos - free-mode window origin.
 * @param {number} margin - ORB_MARGIN.
 * @returns {number} finite integer y.
 */
export function orbWinY(cfg, wa, anchorY, pos, margin) {
  const s = orbArea(cfg, margin)
  const wy = fin(wa && wa.y) ? wa.y : 0
  const wh = fin(wa && wa.height) ? wa.height : s
  let y = null
  if (cfg && cfg.edgeSnap) {
    if (fin(anchorY)) y = anchorY
  } else {
    if (pos && fin(pos.y)) y = pos.y
    else if (fin(anchorY)) y = anchorY
  }
  if (y === null) y = wy + 16
  const out = clamp(y, wy, Math.max(wy, wy + wh - s))
  return fin(out) ? Math.round(out) : wy + 16
}
