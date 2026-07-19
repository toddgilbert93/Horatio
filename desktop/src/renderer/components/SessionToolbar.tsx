import { useState, type CSSProperties } from 'react'
import type { SessionListItem } from '../../preload/index'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { sessionLabel } from '@/lib/session'
import { showToast } from '@/lib/toast'
import { ScrambleText } from './ScrambleText'

type ProjectOption = { id: string; name: string; blendPath: string }

const btnClass = 'font-doto text-[13px]'

export function SessionToolbar({
  selected,
  sessions,
  projects,
  onChanged,
}: {
  selected: SessionListItem | null
  sessions: SessionListItem[]
  projects: ProjectOption[]
  onChanged: (preferId?: string) => void
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  // "Other sessions in the current project" — same tag as the selected
  // session (or fellow untagged sessions when it has none).
  const mergeCandidates = selected
    ? sessions.filter(
        (s) =>
          s.id !== selected.id &&
          (selected.blendId ? s.blendId === selected.blendId : !s.blendId)
      )
    : []
  const checkedIds = mergeCandidates.filter((s) => checked[s.id]).map((s) => s.id)

  async function doMerge(blendPath?: string) {
    if (!selected || checkedIds.length === 0) return
    setBusy(true)
    try {
      const res = await window.flightrec.mergeSessions(checkedIds, selected.id, blendPath)
      if (!res.ok) {
        showToast(res.error || 'Merge failed', true)
        return
      }
      if (res.error) showToast(res.error, true)
      else showToast(`Merged ${res.merged} session${res.merged === 1 ? '' : 's'}`)
      setChecked({})
      onChanged(selected.id)
    } finally {
      setBusy(false)
    }
  }

  async function mergeToPickedBlend() {
    const pick = await window.flightrec.pickBlend()
    if (pick.canceled || !pick.blendPath) return
    await doMerge(pick.blendPath)
  }

  async function doLink(blendPath: string) {
    if (!selected) return
    setBusy(true)
    try {
      const res = await window.flightrec.linkSession(selected.id, blendPath)
      if (!res.ok) showToast(res.error || 'Link failed', true)
      else showToast('Session moved')
      onChanged(selected.id)
    } finally {
      setBusy(false)
    }
  }

  async function linkToPickedBlend() {
    const pick = await window.flightrec.pickBlend()
    if (pick.canceled || !pick.blendPath) return
    await doLink(pick.blendPath)
  }

  async function doExport() {
    if (!selected) return
    setBusy(true)
    try {
      const res = await window.flightrec.exportSession(selected.id)
      if (res.ok && res.outPath) showToast(`Exported to ${res.outPath}`)
      else if (!res.ok && !res.canceled) showToast(res.error || 'Export failed', true)
    } finally {
      setBusy(false)
    }
  }

  const disabled = !selected || busy
  const linkTargets = projects.filter(
    (p) => p.blendPath && p.id !== selected?.blendId
  )

  return (
    <footer
      className="flex items-center justify-end gap-3 pr-4 pl-2 pb-4"
      style={{ backgroundColor: 'transparent' }}
    >
      <DropdownMenu onOpenChange={(open) => !open && setChecked({})}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="xs"
            className={btnClass}
            disabled={disabled || mergeCandidates.length === 0}
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            <ScrambleText text="Merge" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-64">
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            Combine into “{selected ? sessionLabel(selected) : ''}”
          </DropdownMenuLabel>
          {mergeCandidates.map((s) => (
            <DropdownMenuCheckboxItem
              key={s.id}
              className="text-[12px]"
              checked={!!checked[s.id]}
              onCheckedChange={(v) => setChecked((c) => ({ ...c, [s.id]: v === true }))}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="truncate">{sessionLabel(s)}</span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-[12px]"
            disabled={checkedIds.length === 0}
            onSelect={() => void doMerge()}
          >
            Merge {checkedIds.length || ''} session{checkedIds.length === 1 ? '' : 's'}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className="text-[12px]"
              disabled={checkedIds.length === 0}
            >
              Merge & tag as…
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-56">
              {projects
                .filter((p) => p.blendPath)
                .map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    className="text-[12px]"
                    onSelect={() => void doMerge(p.blendPath)}
                  >
                    <span className="truncate">{p.name}</span>
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-[12px]"
                onSelect={() => void mergeToPickedBlend()}
              >
                Choose .blend…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="xs"
            className={btnClass}
            disabled={disabled}
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            <ScrambleText text="Link" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-56">
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            Move session to project
          </DropdownMenuLabel>
          {linkTargets.map((p) => (
            <DropdownMenuItem
              key={p.id}
              className="text-[12px]"
              onSelect={() => void doLink(p.blendPath)}
            >
              <span className="truncate">{p.name}</span>
            </DropdownMenuItem>
          ))}
          {linkTargets.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            className="text-[12px]"
            onSelect={() => void linkToPickedBlend()}
          >
            Choose .blend…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="secondary"
        size="xs"
        className={btnClass}
        disabled={disabled}
        onClick={() => void doExport()}
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <ScrambleText text="Export" />
      </Button>
    </footer>
  )
}
