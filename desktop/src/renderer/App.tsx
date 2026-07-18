import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../preload/index';
import { Timeline } from './components/Timeline';
import { MarkdownView } from './components/MarkdownView';
import { Toast } from './components/Toast';

type ProjectInfo = {
  id: string;
  name: string;
  blendPath: string;
  sessionCount: number;
  blendExists: boolean;
  dir: string;
};

type Tab = 'timeline' | 'state' | 'note' | 'artifacts' | 'raw' | 'log';

export default function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [project, setProject] = useState('_unsaved');
  const projectRef = useRef(project);
  projectRef.current = project;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const selectedRef = useRef<SessionSummary | null>(null);
  selectedRef.current = selected;
  const [tab, setTab] = useState<Tab>('timeline');
  const [note, setNote] = useState('');
  const [digest, setDigest] = useState<unknown[]>([]);
  const [raw, setRaw] = useState<unknown[]>([]);
  const [log, setLog] = useState('');
  const [artifacts, setArtifacts] = useState<Array<{ name: string; path: string; url: string }>>(
    []
  );
  const [projectState, setProjectState] = useState('');
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, error = false, holdMs = 4000) => {
    setToast({ msg, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (holdMs > 0) {
      toastTimer.current = setTimeout(() => setToast(null), holdMs);
    }
  }, []);

  const currentProject = projects.find((p) => p.id === project);

  const loadSession = useCallback(async (s: SessionSummary) => {
    setSelected(s);
    selectedRef.current = s;
    const [n, d, r, l, a] = await Promise.all([
      window.flightrec.getNote(s.dir),
      window.flightrec.getDigest(s.dir),
      window.flightrec.getRaw(s.dir, 400),
      window.flightrec.getDistillLog(s.dir),
      window.flightrec.getArtifacts(s.dir),
    ]);
    setNote(n);
    setDigest(d);
    setRaw(r);
    setLog(l);
    setArtifacts(a);
  }, []);

  const refreshSessions = useCallback(
    async (proj: string, preferId?: string | null) => {
      const list = await window.flightrec.listSessions(proj);
      setSessions(list);
      const keepId = preferId ?? selectedRef.current?.id;
      const next = (keepId && list.find((s) => s.id === keepId)) || list[0] || null;
      if (next) await loadSession(next);
      else {
        setSelected(null);
        selectedRef.current = null;
        setNote('');
        setDigest([]);
        setRaw([]);
        setLog('');
        setArtifacts([]);
      }
      return list;
    },
    [loadSession]
  );

  const loadProject = useCallback(
    async (proj: string, preferSessionId?: string | null) => {
      await refreshSessions(proj, preferSessionId);
      const st = await window.flightrec.getProjectState(proj);
      setProjectState(st.state);
    },
    [refreshSessions]
  );

  const bootstrap = useCallback(async () => {
    try {
      await window.flightrec.ensureHome();
      const h = await window.flightrec.getHome();
      const cfg = await window.flightrec.getConfig();
      const projs = await window.flightrec.listProjects();
      setProjects(projs);
      const ids = projs.map((p) => p.id);
      const proj =
        typeof cfg.lastProject === 'string' && ids.includes(cfg.lastProject)
          ? cfg.lastProject
          : (projs.find((p) => p.id !== '_unsaved')?.id ?? projs[0]?.id ?? '_unsaved');
      setProject(proj);
      projectRef.current = proj;
      await loadProject(proj);
      await window.flightrec.watchStart(h.home);
    } catch (err) {
      showToast(String(err), true);
    }
  }, [loadProject, showToast]);

  useEffect(() => {
    void bootstrap();
    const unsub = window.flightrec.onWatchChanged(() => {
      void (async () => {
        const projs = await window.flightrec.listProjects();
        setProjects(projs);
        await loadProject(projectRef.current, selectedRef.current?.id);
      })();
    });
    return () => {
      unsub();
      void window.flightrec.watchStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectProject(name: string) {
    setProject(name);
    projectRef.current = name;
    await window.flightrec.setConfig({ lastProject: name });
    setSelected(null);
    selectedRef.current = null;
    await loadProject(name);
  }

  async function selectSession(id: string) {
    const s = sessions.find((x) => x.id === id);
    if (s) await loadSession(s);
  }

  async function handleUpdateMemory() {
    if (!selected) return;
    showToast('Updating project memory…', false, 0);
    try {
      const result = await window.flightrec.distillSave(selected.id, project);
      if (result.ok) {
        showToast('Project memory updated');
      } else {
        const detail = (result.output || '').trim().slice(0, 180);
        showToast(detail ? `Update failed: ${detail}` : 'Update failed', true, 8000);
      }
      await loadProject(project, selected.id);
    } catch (err) {
      showToast(String(err), true, 8000);
    }
  }

  async function handleExportMemory(saveAs: boolean) {
    if (!selected) {
      showToast('No session selected', true);
      return;
    }
    showToast(saveAs ? 'Exporting agent memory…' : 'Generating agent memory…');
    const result = await window.flightrec.exportAgentMemory(selected.dir, project, {
      saveAs,
    });
    if (result.canceled) {
      showToast('Export canceled');
      return;
    }
    if (!result.ok) {
      showToast(result.error ?? 'Export failed', true);
      return;
    }
    if (result.outPath) {
      showToast(`Saved → ${result.outPath}`);
      await window.flightrec.reveal(result.outPath);
    } else if (result.projectPath) {
      showToast(`Wrote ${result.projectPath}`);
    } else if (result.sessionPath) {
      showToast(`Wrote ${result.sessionPath}`);
    }
    await loadSession(selected);
  }

  return (
    <div className="app">
      <main className="main">
        <div className="toolbar">
          <div className="toolbar-pickers">
            <label className="picker">
              <span className="picker-label">File</span>
              <select
                value={project}
                onChange={(e) => void selectProject(e.target.value)}
                title={currentProject?.blendPath || currentProject?.name || project}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.blendPath ? '' : ' (unlinked)'}
                    {p.sessionCount ? ` · ${p.sessionCount}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="picker">
              <span className="picker-label">Session</span>
              <select
                value={selected?.id ?? ''}
                onChange={(e) => void selectSession(e.target.value)}
                disabled={sessions.length === 0}
              >
                {sessions.length === 0 ? (
                  <option value="">No sessions</option>
                ) : (
                  sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                      {s.hasNote ? ' · note' : ''}
                      {s.artifactCount ? ` · ${s.artifactCount} shots` : ''}
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>
          <button
            className="primary"
            disabled={!selected}
            onClick={() => void handleUpdateMemory()}
          >
            Update project memory
          </button>
          <button disabled={!selected} onClick={() => void handleExportMemory(true)}>
            Export agent memory…
          </button>
        </div>

        {!selected ? (
          <div className="content">
            <div className="empty">
              <h3>No sessions yet</h3>
              <p>
                Wrap blender under Preferences (⌘,), then run a Blender MCP session. Sessions will
                appear in the Session menu above.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="tabs">
              {(
                [
                  ['timeline', 'Timeline'],
                  ['state', 'State'],
                  ['note', 'Note'],
                  ['artifacts', 'Artifacts'],
                  ['raw', 'Raw'],
                  ['log', 'Distill log'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={tab === id ? 'active' : ''}
                  onClick={() => {
                    setTab(id);
                    if (id === 'state') {
                      void window.flightrec.getProjectState(project).then((st) => {
                        setProjectState(st.state);
                      });
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="content">
              {tab === 'timeline' && <Timeline records={digest} />}
              {tab === 'note' &&
                (note ? (
                  <MarkdownView text={note} />
                ) : (
                  <div className="empty">
                    <h3>No note.md yet</h3>
                    <p>
                      Click Update project memory to run Tier 2 and write this session&apos;s note +
                      shared project state.
                    </p>
                  </div>
                ))}
              {tab === 'state' &&
                (projectState.trim() ? (
                  <MarkdownView text={projectState} />
                ) : (
                  <div className="empty">
                    <h3>No project state yet</h3>
                    <p>
                      Shared across sessions for this Blender file. Update project memory after a
                      session (or use log_decision) to fill it in.
                    </p>
                  </div>
                ))}
              {tab === 'artifacts' &&
                (artifacts.length === 0 ? (
                  <div className="empty">
                    <h3>No screenshots</h3>
                    <p>Viewport screenshots from get_viewport_screenshot land here.</p>
                  </div>
                ) : (
                  <div className="gallery">
                    {artifacts.map((a) => (
                      <figure key={a.path}>
                        <img src={a.url} alt={a.name} />
                        <figcaption>{a.name}</figcaption>
                      </figure>
                    ))}
                  </div>
                ))}
              {tab === 'raw' &&
                (raw.length === 0 ? (
                  <div className="empty">
                    <h3>No raw records</h3>
                  </div>
                ) : (
                  <div className="raw-list">
                    {raw.map((row, i) => {
                      const r = row as {
                        seq?: number;
                        dir?: string;
                        tool?: string;
                        status?: string;
                        ts?: string;
                        payload?: unknown;
                      };
                      return (
                        <details key={i} className="raw-row">
                          <summary>
                            #{r.seq} {r.dir} {r.tool ?? ''} {r.status ?? ''}{' '}
                            <span style={{ color: 'var(--text-muted)' }}>{r.ts}</span>
                          </summary>
                          <pre className="raw-payload">{JSON.stringify(r.payload, null, 2)}</pre>
                        </details>
                      );
                    })}
                  </div>
                ))}
              {tab === 'log' &&
                (log ? (
                  <pre className="log-view">{log}</pre>
                ) : (
                  <div className="empty">
                    <h3>No distill.log</h3>
                  </div>
                ))}
            </div>
          </>
        )}
      </main>
      {toast && <Toast message={toast.msg} error={toast.error} />}
    </div>
  );
}
