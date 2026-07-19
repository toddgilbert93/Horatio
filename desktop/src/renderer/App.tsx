import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import type { SessionListItem } from '../preload/index'
import bustIcon from '@/assets/brand/bust-icon.png'
import { Feed } from './components/Feed'
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

  const filteredSessions = useMemo(() => {
    if (projectFilter === ALL_PROJECTS) return sessions
    if (projectFilter === '_unlinked') return sessions.filter((s) => !s.blendId)
    return sessions.filter((s) => s.blendId === projectFilter)
  }, [sessions, projectFilter])

  const loadSession = useCallback(async (s: SessionListItem) => {
    setSelected(s)
    selectedRef.current = s
    const d = await window.flightrec.getDigest(s.dir)
    setDigest(d)
  }, [])

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
    async (preferId?: string | null) => {
      const [list, projs] = await Promise.all([
        window.flightrec.listAllSessions(),
        window.flightrec.listProjects(),
      ])
      setSessions(list)
      setProjects(projs)

      const filter = projectFilterRef.current
      const visible =
        filter === ALL_PROJECTS
          ? list
          : filter === '_unlinked'
            ? list.filter((s) => !s.blendId)
            : list.filter((s) => s.blendId === filter)
      await pickSession(visible, preferId)
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
      void refresh(selectedRef.current?.id)
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
    <div
      className="flex h-full flex-col"
      style={
        {
          backgroundColor: '#041300',
          // Keep design tokens from painting lighter washes over the ink ground.
          ['--background' as string]: '#041300',
          ['--card' as string]: '#041300',
          ['--muted' as string]: '#041300',
          // Elevated fill so secondary toolbar buttons read against the ink ground.
          ['--secondary' as string]: '#30372e',
          ['--sidebar' as string]: '#041300',
          ['--input' as string]: 'transparent',
        } as CSSProperties
      }
    >
      <header
        className="flex items-center justify-end gap-2 py-2 pr-4 pl-[72px]"
        style={{ WebkitAppRegion: 'drag', backgroundColor: '#041300' } as CSSProperties}
      >
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
                {sessionLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

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
      </header>

      <div className="flex min-h-0 flex-1" style={{ backgroundColor: '#041300' }}>
        <div
          className="flex w-[200px] shrink-0 items-center justify-center p-2"
          style={{ backgroundColor: '#041300' }}
        >
          <div className="size-[180px] overflow-hidden" style={{ backgroundColor: '#041300' }}>
            <BustErrorBoundary fallback={<BustFallback />}>
              <Suspense fallback={<BustFallback />}>
                <BustViewer rotating materialId="bone" style={{ maxWidth: 180, maxHeight: 180 }} />
              </Suspense>
            </BustErrorBoundary>
          </div>
        </div>

        <div className="min-w-0 flex-1 py-3 pr-4 pl-1" style={{ backgroundColor: '#041300' }}>
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

      <SessionToolbar
        selected={selected}
        sessions={sessions}
        projects={projects}
        onChanged={(preferId) => void refresh(preferId)}
      />
    </div>
  )
}
