import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import type { SessionListItem } from '../preload/index'
import bustIcon from '@/assets/brand/bust-icon.png'
import { Feed } from './components/Feed'
import { FluidBackground } from './components/FluidBackground'
import { SessionToolbar } from './components/SessionToolbar'
import { sessionLabel } from '@/lib/session'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { showToast } from '@/lib/toast'

const BustViewer = lazy(() =>
  import('@/components/bust').then((m) => ({ default: m.BustViewer }))
)

const ALL_PROJECTS = '__all__'


type ProjectInfo = {
  id: string
  name: string
  blendPath: string
  sessionCount: number
  blendExists: boolean
  dir: string
}

class BustErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[horatio] BustViewer failed', error, info)
  }

  render() {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

function BustFallback() {
  return (
    <img
      src={bustIcon}
      alt=""
      className="size-full object-cover"
      draggable={false}
    />
  )
}

const selectTriggerClass =
  'h-8 min-w-0 border-0 !bg-transparent px-2 shadow-none text-[13px] hover:!bg-transparent focus-visible:ring-0 focus-visible:border-transparent dark:!bg-transparent dark:hover:!bg-transparent'

export default function App() {
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS)
  const projectFilterRef = useRef(projectFilter)
  projectFilterRef.current = projectFilter
  const [selected, setSelected] = useState<SessionListItem | null>(null)
  const selectedRef = useRef<SessionListItem | null>(null)
  selectedRef.current = selected
  const [digest, setDigest] = useState<unknown[]>([])
  // Last digest mtime the user has "seen" per session id. Baseline is set on
  // first sight (no dots at startup); a later mtime means unseen activity.
  const [seenMtimes, setSeenMtimes] = useState<Record<string, number>>({})
  const baselinedRef = useRef(false)
  // Digest mtimes from the previous refresh — lets a watch-triggered refresh
  // spot which sessions actually gained activity, to auto-jump the viewer.
  const lastMtimesRef = useRef<Record<string, number>>({})

  const markSeen = useCallback((s: SessionListItem) => {
    setSeenMtimes((prev) => ({ ...prev, [s.id]: s.digestMtimeMs ?? 0 }))
  }, [])

  const isUnseen = useCallback(
    (s: SessionListItem) => {
      const seen = seenMtimes[s.id]
      return seen !== undefined && (s.digestMtimeMs ?? 0) > seen
    },
    [seenMtimes]
  )

  useEffect(() => {
    document.documentElement.dataset.theme = 'archive'
  }, [])

  const filteredSessions = useMemo(() => {
    if (projectFilter === ALL_PROJECTS) return sessions
    if (projectFilter === '_unlinked') return sessions.filter((s) => !s.blendId)
    return sessions.filter((s) => s.blendId === projectFilter)
  }, [sessions, projectFilter])

  const loadSession = useCallback(
    async (s: SessionListItem) => {
      setSelected(s)
      selectedRef.current = s
      markSeen(s) // viewing a session clears its alert dot
      const d = await window.flightrec.getDigest(s.dir)
      setDigest(d)
    },
    [markSeen]
  )

  const pickSession = useCallback(
    async (list: SessionListItem[], preferId?: string | null) => {
      const keepId = preferId ?? selectedRef.current?.id
      const next = (keepId && list.find((s) => s.id === keepId)) || list[0] || null
      if (next) await loadSession(next)
      else {
        setSelected(null)
        selectedRef.current = null
        setDigest([])
      }
    },
    [loadSession]
  )

  const refresh = useCallback(
    async (preferId?: string | null, opts?: { jumpToLatest?: boolean }) => {
      const [list, projs] = await Promise.all([
        window.flightrec.listAllSessions(),
        window.flightrec.listProjects(),
      ])
      setSessions(list)
      setProjects(projs)
      // First load baselines everything at its current mtime (quiet startup);
      // sessions that appear later baseline at 0 so their first digest dots.
      const firstLoad = !baselinedRef.current
      baselinedRef.current = true
      setSeenMtimes((prev) => {
        const next = { ...prev }
        for (const s of list) {
          if (next[s.id] === undefined) next[s.id] = firstLoad ? (s.digestMtimeMs ?? 0) : 0
        }
        return next
      })

      const filter = projectFilterRef.current
      const visible =
        filter === ALL_PROJECTS
          ? list
          : filter === '_unlinked'
            ? list.filter((s) => !s.blendId)
            : list.filter((s) => s.blendId === filter)

      // Follow the action: on watch-triggered refreshes, jump to the visible
      // session whose digest advanced most recently (if any did).
      let jumpId: string | null = null
      if (opts?.jumpToLatest) {
        const prev = lastMtimesRef.current
        const advanced = visible.filter(
          (s) => (s.digestMtimeMs ?? 0) > (prev[s.id] ?? 0)
        )
        if (advanced.length > 0) {
          jumpId = advanced.reduce((a, b) =>
            (b.digestMtimeMs ?? 0) > (a.digestMtimeMs ?? 0) ? b : a
          ).id
        }
      }
      lastMtimesRef.current = Object.fromEntries(
        list.map((s) => [s.id, s.digestMtimeMs ?? 0])
      )

      await pickSession(visible, jumpId ?? preferId)
    },
    [pickSession]
  )

  useEffect(() => {
    void (async () => {
      try {
        await window.flightrec.ensureHome()
        const h = await window.flightrec.getHome()
        await refresh()
        await window.flightrec.watchStart(h.home)
      } catch (err) {
        showToast(String(err), true)
      }
    })()
    const unsub = window.flightrec.onWatchChanged(() => {
      void refresh(selectedRef.current?.id, { jumpToLatest: true })
    })
    return () => {
      unsub()
      void window.flightrec.watchStop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function selectProjectFilter(id: string) {
    setProjectFilter(id)
    projectFilterRef.current = id
    const visible =
      id === ALL_PROJECTS
        ? sessions
        : id === '_unlinked'
          ? sessions.filter((s) => !s.blendId)
          : sessions.filter((s) => s.blendId === id)
    await pickSession(visible, selectedRef.current?.id)
  }

  return (
    <div className="bg-background relative isolate flex h-full flex-col">
      {/* Base: theme ground + bust */}
      <div className="bg-background absolute inset-0 z-0">
        <div className="absolute top-1/2 left-2 flex size-[180px] -translate-y-1/2 items-center justify-center overflow-hidden">
          <BustErrorBoundary fallback={<BustFallback />}>
            <Suspense fallback={<BustFallback />}>
              <BustViewer rotating materialId="bone" style={{ maxWidth: 180, maxHeight: 180 }} />
            </Suspense>
          </BustErrorBoundary>
        </div>
      </div>

      {/* Fluid wash on top of ground + bust */}
      <FluidBackground />

      <header
        className="relative z-10 flex items-end justify-end gap-2 pt-5 pb-2 pr-4 pl-[72px]"
        style={{ WebkitAppRegion: 'drag', backgroundColor: 'transparent' } as CSSProperties}
      >
        <div className="flex shrink-0 flex-col">
          <span className="px-2 text-[10px] leading-none text-muted-foreground">Projects</span>
          <Select value={projectFilter} onValueChange={(v) => void selectProjectFilter(v)}>
            <SelectTrigger
              className={`${selectTriggerClass} w-[120px] shrink-0 text-muted-foreground`}
              style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            >
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS} className="text-[13px]">
                All projects
              </SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-[13px]">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="relative flex min-w-0 flex-col">
          <span className="px-2 text-[10px] leading-none text-muted-foreground">
            Sessions
            {filteredSessions.some(isUnseen) && (
              <span
                className="ml-1.5 inline-block size-[6px] animate-pulse rounded-full bg-primary align-middle"
                aria-label="New session activity"
              />
            )}
          </span>
          <Select
            value={selected?.id}
            onValueChange={(id) => {
              const s = filteredSessions.find((x) => x.id === id)
              if (s) void loadSession(s)
            }}
            disabled={filteredSessions.length === 0}
          >
            <SelectTrigger
              className={`${selectTriggerClass} w-[200px] max-w-[200px] min-w-0 shrink-0 overflow-hidden`}
              style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            >
              <SelectValue placeholder="No sessions yet" />
            </SelectTrigger>
            <SelectContent>
              {filteredSessions.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-[13px]">
                  <span className="flex items-center gap-1.5">
                    {sessionLabel(s)}
                    {isUnseen(s) && (
                      <span className="inline-block size-[6px] shrink-0 animate-pulse rounded-full bg-primary" />
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1">
        <div className="w-[200px] shrink-0" />
        <div className="min-w-0 flex-1 py-3 pr-4 pl-1">
          {selected ? (
            <Feed
              records={digest}
              sessionDir={selected.dir}
              emptyHint="Session started — activity will appear here."
            />
          ) : (
            <div className="flex h-full items-center">
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Wrap blender under Preferences (⌘,), then run a Blender MCP session.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="relative z-10">
        <SessionToolbar
          selected={selected}
          sessions={sessions}
          projects={projects}
          onChanged={(preferId) => void refresh(preferId)}
        />
      </div>
    </div>
  )
}
