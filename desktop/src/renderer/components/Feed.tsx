import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

export type FeedEvent = {
  kind: 'event'
  type: string
  ts: string
  summary: string
  error?: { message: string; resolved: boolean; resolution?: string }
  artifacts?: string[]
}

function artifactAbs(sessionDir: string, rel: string): string {
  // Merged-session events carry absolute paths already.
  if (rel.startsWith('/')) return rel
  return `${sessionDir.replace(/[/\\]+$/, '')}/${rel.replace(/^[/\\]+/, '')}`
}

function artifactUrl(sessionDir: string, rel: string): string {
  return `flightrec-file://local/?p=${encodeURIComponent(artifactAbs(sessionDir, rel))}`
}

function formatTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Paths mentioned in summary text — covers digests distilled before `artifacts` existed. */
const ARTIFACT_IN_TEXT =
  /(?:^|[\s("`'])(artifacts\/[A-Za-z0-9._/-]+\.(?:png|jpe?g|webp|gif))\b/gi

function artifactsFromSummary(summary: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of summary.matchAll(ARTIFACT_IN_TEXT)) {
    const rel = m[1]
    if (!seen.has(rel)) {
      seen.add(rel)
      out.push(rel)
    }
  }
  return out
}

function resolveArtifacts(event: { artifacts?: string[]; summary: string }): string[] {
  if (event.artifacts && event.artifacts.length > 0) return event.artifacts
  return artifactsFromSummary(event.summary)
}

/** Flatten digest.jsonl into newest-first events (no batch chrome). */
export function flattenDigest(records: unknown[]): FeedEvent[] {
  const events: FeedEvent[] = []
  for (const row of records) {
    const r = row as FeedEvent & { kind?: string }
    if (r?.kind === 'event' && typeof r.summary === 'string') {
      events.push({
        kind: 'event',
        type: r.type,
        ts: r.ts,
        summary: r.summary,
        error: r.error,
        artifacts: resolveArtifacts(r),
      })
    }
  }
  return events.reverse()
}

function Entry({
  event,
  sessionDir,
  prominent,
}: {
  event: FeedEvent
  sessionDir: string
  prominent?: boolean
}) {
  const isError = event.type === 'error'
  return (
    <div className={cn(prominent ? 'pb-4' : 'py-2.5')}>
      <div className="flex items-baseline gap-2">
        <p
          className={cn(
            'min-w-0 flex-1 leading-snug text-foreground',
            prominent ? 'text-[15px]' : 'text-[13px]',
            isError && 'text-destructive'
          )}
        >
          {event.summary}
        </p>
        {event.ts ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {formatTime(event.ts)}
          </span>
        ) : null}
      </div>
      {event.error?.message ? (
        <p className="mt-1 text-[12px] leading-snug text-destructive/90">
          {event.error.message}
          {event.error.resolved ? ' (resolved)' : ''}
        </p>
      ) : null}
      {event.artifacts && event.artifacts.length > 0 ? (
        <div className={cn('flex w-full flex-col gap-1.5', prominent ? 'mt-2' : 'mt-1.5')}>
          {event.artifacts.map((rel) => {
            const abs = artifactAbs(sessionDir, rel)
            const name = rel.split(/[/\\]/).pop() ?? rel
            return (
              <button
                key={rel}
                type="button"
                title={name}
                className="block w-full overflow-hidden bg-black p-0 transition-opacity hover:opacity-90"
                onClick={() => void window.flightrec.openPath(abs)}
              >
                <img
                  src={artifactUrl(sessionDir, rel)}
                  alt={name}
                  className="block h-auto w-full object-cover"
                  draggable={false}
                />
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function Feed({
  records,
  sessionDir,
  emptyHint,
}: {
  records: unknown[]
  sessionDir: string
  emptyHint?: string
}) {
  const events = flattenDigest(records)
  if (events.length === 0) {
    return (
      <div className="flex h-full items-center px-1">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {emptyHint ?? 'Waiting for activity…'}
        </p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="pr-2">
        {events.map((ev, i) => (
          <Entry
            key={`${ev.ts}-${i}`}
            event={ev}
            sessionDir={sessionDir}
            prominent={i === 0}
          />
        ))}
      </div>
    </ScrollArea>
  )
}
