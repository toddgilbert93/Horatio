import type { SessionListItem } from '../../preload/index'

/** Humanized fallback when a session has no AI title yet. */
export function sessionLabel(s: SessionListItem): string {
  if (s.title?.trim()) return s.title.trim()
  const src = s.startedAt || s.id
  const m = String(src).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})[:-](\d{2})[:-](\d{2})/
  )
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    }
  }
  const d = new Date(src)
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }
  return s.id
}
