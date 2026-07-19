import { useState, type ReactNode } from 'react'
import { Copy, FolderOpen, Link2, RefreshCw, Wrench } from 'lucide-react'
import type { InstallStatus } from '../../preload/index'
import { HMark } from '@/components/brand/HMark'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'

type Props = {
  home: string
  runtime?: string
  packaged?: boolean
  status: InstallStatus | null
  apiKeySet: boolean
  envPath: string
  migrateSources: Array<{ kind: string; path: string; label: string }>
  onWrap: (server: string) => void | Promise<void>
  onUninstall: () => void | Promise<void>
  onLinkBlend?: () => void | Promise<void>
  onRepairStore: () => void | Promise<void>
  onSetKey: (key: string) => void | Promise<void>
  onClearKey: () => void | Promise<void>
  onReveal: (path: string) => void | Promise<void>
  onCopy: (path: string) => void | Promise<void>
  onImport: (sourcePath: string) => void | Promise<void>
  onRefresh: () => void
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '')
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="font-display text-xl tracking-[0.02em] text-foreground">{title}</h3>
      {children}
    </section>
  )
}

export function ControlPlane({
  home,
  runtime,
  packaged,
  status,
  apiKeySet,
  envPath,
  migrateSources,
  onWrap,
  onUninstall,
  onLinkBlend,
  onRepairStore,
  onSetKey,
  onClearKey,
  onReveal,
  onCopy,
  onImport,
  onRefresh,
}: Props) {
  const [keyInput, setKeyInput] = useState('')
  const [wrapName, setWrapName] = useState('blender')

  const wrongHomes: Array<{ client: string; server: string; storeHome: string }> = []
  if (status) {
    const expected = normalizePath(home || status.storeHome)
    for (const c of status.clients) {
      for (const s of c.servers) {
        if ((s.wrapped || s.isMemory) && s.storeHome) {
          if (normalizePath(s.storeHome) !== expected) {
            wrongHomes.push({ client: c.label, server: s.name, storeHome: s.storeHome })
          }
        }
      }
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <HMark variant="dark" size={22} />
        <h2 className="font-display text-2xl tracking-[0.02em]">Preferences</h2>
        <Button variant="outline" size="sm" className="ml-auto" onClick={onRefresh}>
          <RefreshCw />
          Refresh
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-xl flex-col gap-8 px-5 py-6">
          <Section title="Get started">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              1. Save your NVIDIA API key below · 2. Wrap your Blender MCP server · 3. Restart Cursor
              / Claude · 4. Work in Blender — sessions appear in the Session menu.
            </p>
            {packaged && (
              <p className="text-[12px] text-muted-foreground">
                Running packaged app — tap + memory runtime is bundled. No repo clone needed.
              </p>
            )}
          </Section>

          <Separator />

          <Section title="Data folder">
            <p className="break-all font-mono text-xs text-foreground">{home}</p>
            {runtime && (
              <p className="break-all font-mono text-[11px] text-muted-foreground" title={runtime}>
                Runtime: {runtime}
              </p>
            )}
            <p className="text-[13px] text-muted-foreground">
              All sessions, notes, and project state live here. MCP clients are wired to this path on
              wrap.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void onReveal(home)}>
                <FolderOpen />
                Reveal in Finder
              </Button>
              <Button variant="outline" size="sm" onClick={() => void onCopy(home)}>
                <Copy />
                Copy path
              </Button>
            </div>
          </Section>

          {onLinkBlend && (
            <>
              <Separator />
              <Section title="Blender file">
                <p className="text-[13px] text-muted-foreground">
                  Sessions usually attach to a .blend automatically from MCP traffic. Link manually
                  when you need to point an existing bucket at a file.
                </p>
                <Button size="sm" onClick={() => void onLinkBlend()}>
                  <Link2 />
                  Link .blend…
                </Button>
              </Section>
            </>
          )}

          <Separator />

          <Section title="NVIDIA API key">
            <p className="text-[13px]">
              Status:{' '}
              <Badge
                variant="outline"
                className={
                  apiKeySet
                    ? 'rounded-sm border-ok/50 text-ok'
                    : 'rounded-sm border-destructive/50 text-destructive'
                }
              >
                {apiKeySet ? 'set' : 'missing'}
              </Badge>
            </p>
            <p className="break-all font-mono text-[11px] text-muted-foreground">{envPath}</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="api-key" className="sr-only">
                API key
              </Label>
              <Input
                id="api-key"
                type="password"
                placeholder="nvapi-…"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                className="font-mono text-xs"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!keyInput.trim()}
                  onClick={() => {
                    void onSetKey(keyInput)
                    setKeyInput('')
                  }}
                >
                  Save key
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void onClearKey()}>
                  Clear
                </Button>
              </div>
            </div>
          </Section>

          <Separator />

          <Section title="MCP clients">
            <p className="text-[13px] text-muted-foreground">
              Wrap a Blender MCP server so traffic is recorded. Restart the client after wrapping.
            </p>

            {wrongHomes.length > 0 && (
              <Alert variant="destructive" className="rounded-sm">
                <Wrench />
                <AlertTitle>Wrong store path detected</AlertTitle>
                <AlertDescription>
                  <p className="mb-2">
                    Some MCP servers still write outside the app data folder. Sessions won&apos;t show
                    up here until this is fixed.
                  </p>
                  <ul className="mb-3 list-disc pl-4 font-mono text-[11px]">
                    {wrongHomes.map((w) => (
                      <li key={`${w.client}-${w.server}`}>
                        {w.client} / {w.server}: {w.storeHome}
                      </li>
                    ))}
                  </ul>
                  <Button size="sm" onClick={() => void onRepairStore()}>
                    Point all to app data folder
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {!status || status.clients.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No MCP clients detected.</p>
            ) : (
              status.clients.map((c) => (
                <div
                  key={c.id}
                  className="space-y-1.5 border border-border bg-card/60 px-3 py-2.5"
                >
                  <div className="flex items-baseline gap-2">
                    <h4 className="text-[14px] text-foreground">{c.label}</h4>
                  </div>
                  <p className="break-all font-mono text-[11px] text-muted-foreground">
                    {c.configPath}
                  </p>
                  {c.error && <p className="text-[13px] text-destructive">{c.error}</p>}
                  <ul className="list-disc pl-4 font-mono text-[11px] text-muted-foreground">
                    {c.servers.length === 0 && <li>(no servers)</li>}
                    {c.servers.map((s) => (
                      <li key={s.name}>
                        {s.name} ({s.kind})
                        {s.wrapped ? ' · wrapped' : ''}
                        {s.isMemory ? ' · memory' : ''}
                        {s.storeHome ? ` · ${s.storeHome}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="text"
                value={wrapName}
                onChange={(e) => setWrapName(e.target.value)}
                className="max-w-[10rem] font-mono text-xs"
              />
              <Button size="sm" onClick={() => void onWrap(wrapName.trim() || 'blender')}>
                Wrap
              </Button>
              <Button size="sm" variant="outline" onClick={() => void onRepairStore()}>
                Fix store paths
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void onUninstall()}>
                Uninstall all
              </Button>
            </div>
          </Section>

          {migrateSources.length > 0 && (
            <>
              <Separator />
              <Section title="Import existing data">
                <p className="text-[13px] text-muted-foreground">
                  Found older stores. Import copies sessions into the current project without deleting
                  the source.
                </p>
                {migrateSources.map((s) => (
                  <div
                    key={s.path}
                    className="space-y-2 border border-border bg-card/60 px-3 py-2.5"
                  >
                    <h4 className="text-[14px]">{s.label}</h4>
                    <p className="break-all font-mono text-[11px] text-muted-foreground">{s.path}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void onImport(s.path)}>
                        Import into current project
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void onReveal(s.path)}>
                        Reveal
                      </Button>
                    </div>
                  </div>
                ))}
              </Section>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
