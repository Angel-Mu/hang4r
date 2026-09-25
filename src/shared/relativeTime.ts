/** Compact age for the session list: now, 5m, 2h, 3d, 2mo. */
export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(1, Math.floor((now - ts) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return `${Math.floor(d / 30)}mo`
}
