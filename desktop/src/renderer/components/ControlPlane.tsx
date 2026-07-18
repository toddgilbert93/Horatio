import { useState } from 'react';
import type { InstallStatus } from '../../../preload/index';

type Props = {
  home: string;
  runtime?: string;
  packaged?: boolean;
  status: InstallStatus | null;
  apiKeySet: boolean;
  envPath: string;
  migrateSources: Array<{ kind: string; path: string; label: string }>;
  onWrap: (server: string) => void | Promise<void>;
  onUninstall: () => void | Promise<void>;
  onLinkBlend?: () => void | Promise<void>;
  onRepairStore: () => void | Promise<void>;
  onSetKey: (key: string) => void | Promise<void>;
  onClearKey: () => void | Promise<void>;
  onReveal: (path: string) => void | Promise<void>;
  onCopy: (path: string) => void | Promise<void>;
  onImport: (sourcePath: string) => void | Promise<void>;
  onRefresh: () => void;
};

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
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
  const [keyInput, setKeyInput] = useState('');
  const [wrapName, setWrapName] = useState('blender');

  const wrongHomes: Array<{ client: string; server: string; storeHome: string }> = [];
  if (status) {
    const expected = normalizePath(home || status.storeHome);
    for (const c of status.clients) {
      for (const s of c.servers) {
        if ((s.wrapped || s.isMemory) && s.storeHome) {
          if (normalizePath(s.storeHome) !== expected) {
            wrongHomes.push({ client: c.label, server: s.name, storeHome: s.storeHome });
          }
        }
      }
    }
  }

  return (
    <>
      <div className="toolbar">
        <h2>Preferences</h2>
        <button onClick={onRefresh}>Refresh</button>
      </div>
      <div className="content">
        <div className="control">
          <section>
            <h3>Get started</h3>
            <p className="hint">
              1. Save your NVIDIA API key below · 2. Wrap your Blender MCP server · 3. Restart Cursor
              / Claude · 4. Work in Blender — sessions appear in the Session menu.
            </p>
            {packaged && (
              <p className="hint">
                Running packaged app — tap + memory runtime is bundled. No repo clone needed.
              </p>
            )}
          </section>

          <section>
            <h3>Data folder</h3>
            <p className="mono">{home}</p>
            {runtime && (
              <p className="hint mono" title={runtime}>
                Runtime: {runtime}
              </p>
            )}
            <p className="hint">
              All sessions, notes, and project state live here. MCP clients are wired to this path on
              wrap.
            </p>
            <div className="actions">
              <button onClick={() => void onReveal(home)}>Reveal in Finder</button>
              <button onClick={() => void onCopy(home)}>Copy path</button>
            </div>
          </section>

          {onLinkBlend && (
            <section>
              <h3>Blender file</h3>
              <p className="hint">
                Sessions usually attach to a .blend automatically from MCP traffic. Link manually
                when you need to point an existing bucket at a file.
              </p>
              <div className="actions">
                <button className="primary" onClick={() => void onLinkBlend()}>
                  Link .blend…
                </button>
              </div>
            </section>
          )}

          <section>
            <h3>NVIDIA API key</h3>
            <p>
              Status:{' '}
              <strong style={{ color: apiKeySet ? 'var(--ok)' : 'var(--danger)' }}>
                {apiKeySet ? 'set' : 'missing'}
              </strong>
            </p>
            <p className="hint mono">{envPath}</p>
            <div className="actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <input
                type="password"
                placeholder="nvapi-…"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <div className="actions">
                <button
                  className="primary"
                  disabled={!keyInput.trim()}
                  onClick={() => {
                    void onSetKey(keyInput);
                    setKeyInput('');
                  }}
                >
                  Save key
                </button>
                <button className="danger" onClick={() => void onClearKey()}>
                  Clear
                </button>
              </div>
            </div>
          </section>

          <section>
            <h3>MCP clients</h3>
            <p className="hint">
              Wrap a Blender MCP server so traffic is recorded. Restart the client after wrapping.
            </p>
            {wrongHomes.length > 0 && (
              <div className="client-block" style={{ borderColor: 'var(--danger)' }}>
                <h4 style={{ color: 'var(--danger)' }}>Wrong store path detected</h4>
                <p className="hint">
                  Some MCP servers still write outside the app data folder. Sessions won&apos;t show
                  up here until this is fixed.
                </p>
                <ul>
                  {wrongHomes.map((w) => (
                    <li key={`${w.client}-${w.server}`}>
                      {w.client} / {w.server}: {w.storeHome}
                    </li>
                  ))}
                </ul>
                <div className="actions">
                  <button className="primary" onClick={() => void onRepairStore()}>
                    Point all to app data folder
                  </button>
                </div>
              </div>
            )}
            {!status || status.clients.length === 0 ? (
              <p>No MCP clients detected.</p>
            ) : (
              status.clients.map((c) => (
                <div key={c.id} className="client-block">
                  <h4>{c.label}</h4>
                  <p className="hint mono">{c.configPath}</p>
                  {c.error && <p style={{ color: 'var(--danger)' }}>{c.error}</p>}
                  <ul>
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
            <div className="actions">
              <input
                type="text"
                value={wrapName}
                onChange={(e) => setWrapName(e.target.value)}
                style={{ maxWidth: 160 }}
              />
              <button className="primary" onClick={() => void onWrap(wrapName.trim() || 'blender')}>
                Wrap
              </button>
              <button onClick={() => void onRepairStore()}>Fix store paths</button>
              <button className="danger" onClick={() => void onUninstall()}>
                Uninstall all
              </button>
            </div>
          </section>

          {migrateSources.length > 0 && (
            <section>
              <h3>Import existing data</h3>
              <p className="hint">
                Found older stores. Import copies sessions into the current project without deleting
                the source.
              </p>
              {migrateSources.map((s) => (
                <div key={s.path} className="client-block">
                  <h4>{s.label}</h4>
                  <p className="hint mono">{s.path}</p>
                  <div className="actions">
                    <button onClick={() => void onImport(s.path)}>Import into current project</button>
                    <button onClick={() => void onReveal(s.path)}>Reveal</button>
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
