/**
 * dsh-clean-desktop-shell — approval hover-card display model (pure).
 *
 * Two decisions live here so they are unit-testable without Electron:
 *   pickApprovalInfo  — which of a session's pending approvals the card
 *                       shows (the first = the one the web composer treats
 *                       as effective; the rest only count into "+N").
 *   computeApprovalBounds — where the side-mounted detail window sits next
 *                       to the task-list bubble window, clamped to the work
 *                       area, and which edge its tail points at.
 */

/** Card width inside the transparent margin ring (bubble uses 292). */
export const APPROVAL_CARD_W = 300
/** Transparent padding around the card (mirrors BUB_MARGIN). */
export const APPROVAL_MARGIN = 10
/** Gap between the bubble window edge and the detail window edge. */
export const APPROVAL_GAP = 8
/** Window width including the padding ring. */
export const APPROVAL_W = APPROVAL_CARD_W + APPROVAL_MARGIN * 2
/** First-frame height estimate until the renderer reports the real one. */
export const APPROVAL_EST_H = 236
/** Height bounds for the renderer-measured window. */
export const APPROVAL_H_MIN = 150
export const APPROVAL_H_MAX = 420

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * Effective approval info for one state-file session row.
 * @param {object|undefined|null} session - {pendingApprovals?, lastChangeAt?}
 * @returns {{toolName:string, reason:string|undefined, since:number, more:number}|null}
 *   null when there is no usable detail (older backend without the field).
 */
export function pickApprovalInfo(session) {
  if (!session || !Array.isArray(session.pendingApprovals)) return null
  const list = session.pendingApprovals
  if (list.length === 0) return null
  const first = list[0]
  const base = {
    toolName: '未知工具',
    reason: undefined,
    since: Number.isFinite(session.lastChangeAt) ? session.lastChangeAt : 0,
    more: Math.max(0, list.length - 1),
  }
  if (!first || typeof first !== 'object') return base
  if (typeof first.toolName === 'string' && first.toolName) base.toolName = first.toolName
  if (typeof first.reason === 'string' && first.reason) base.reason = first.reason
  if (Number.isFinite(first.since)) base.since = first.since
  return base
}

/**
 * Place the detail window beside the bubble window, on the bubble's OUTER
 * side (away from the orb), clamped into the work area.
 * @param {{x:number,y:number,width:number,height:number}} bub - bubble rect.
 * @param {number} detailH - current detail window height.
 * @param {{x:number,y:number,width:number,height:number}} wa - work area.
 * @param {'left'|'right'} bside - which side of the orb the bubble is on;
 *   the detail mounts on the opposite (outer) side of the bubble.
 * @returns {{x:number,y:number,width:number,height:number,tail:'left'|'right'}}
 *   tail = the detail card's edge that points back at the bubble.
 */
export function computeApprovalBounds(bub, detailH, wa, bside) {
  const h = clamp(Math.round(detailH), APPROVAL_H_MIN, APPROVAL_H_MAX)
  const mountRight = bside === 'right'
  let x = mountRight
    ? bub.x + bub.width + APPROVAL_GAP
    : bub.x - APPROVAL_GAP - APPROVAL_W
  x = clamp(Math.round(x), wa.x, Math.max(wa.x, wa.x + wa.width - APPROVAL_W))
  // Align the detail card top with the bubble's, but pull it up when it is
  // taller than the bubble so the pair stays visually anchored (24px inset).
  let y = bub.y + Math.max(-24, Math.min(0, bub.height - h) + 24)
  y = clamp(Math.round(y), wa.y, Math.max(wa.y, wa.y + wa.height - h))
  return { x, y, width: APPROVAL_W, height: h, tail: mountRight ? 'left' : 'right' }
}

/** "等了多久" 文案：8s → 「8 秒前」，95s → 「1 分 35 秒前」，2h → 「2 小时前」。 */
export function approvalAgeLabel(since, now) {
  if (!Number.isFinite(since) || !Number.isFinite(now) || since <= 0 || now < since) return ''
  const sec = Math.floor((now - since) / 1000)
  if (sec < 60) return sec + ' 秒前'
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return s ? m + ' 分 ' + s + ' 秒前' : m + ' 分钟前'
  }
  const h = Math.floor(sec / 3600)
  const rem = Math.floor((sec % 3600) / 60)
  return rem ? h + ' 小时 ' + rem + ' 分前' : h + ' 小时前'
}
