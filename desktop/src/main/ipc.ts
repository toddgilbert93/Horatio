/**
 * IPC handlers — store reads, install/control, watchers, migration.
 * Talks to the compiled dist/ (v2 Horatio store: flat sessions + blends/).
 */
import type { IpcMain, Shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT, loadDist, applyRuntimeEnv, runtimeRoot, isPackaged } from './paths';

type StoreMod = typeof import('../../../dist/lib/store.js');
type BlendLinkMod = typeof import('../../../dist/lib/blend-link.js');
type InstallMod = typeof import('../../../dist/install.js');

const UNLINKED_ID = '_unlinked';

let store: StoreMod;
let blendLink: BlendLinkMod;
let install: InstallMod;
let watchers: fs.FSWatcher[] = [];

async function ensureMods(): Promise<void> {
  applyRuntimeEnv();
  if (!store) store = await loadDist<StoreMod>('lib/store.js');
  if (!blendLink) blendLink = await loadDist<BlendLinkMod>('lib/blend-link.js');
  if (!install) install = await loadDist<InstallMod>('install.js');
}

function bindHomeEnv(): void {
  const home = store.horatioHome();
  process.env.HORATIO_HOME = home;
  // Legacy key still read by older wraps / envWithFallback.
  process.env.FLIGHTREC_HOME = home;
}

function sessionSummary(s: { id: string; dir: string }) {
  return {
    id: s.id,
    dir: s.dir,
    hasNote: store.noteExists(s.dir),
    hasDigest: fs.existsSync(store.digestPath(s.dir)),
    hasRaw: fs.existsSync(store.rawPath(s.dir)),
    hasDistillLog: fs.existsSync(store.distillLogPath(s.dir)),
    artifactCount: 0,
  };
}

function sessionsForBlend(blendId: string): Array<{ id: string; dir: string; blendId?: string }> {
  const all = blendLink.listSessionsWithLinks();
  if (blendId === UNLINKED_ID) return all.filter((s) => !s.blendId);
  return all.filter((s) => s.blendId === blendId);
}

// ---------------------------------------------------------------------------
// Session merge markers — sources keep their folders (raw.jsonl untouched);
// merge.json points at the target and the UI folds their feeds together.
// ---------------------------------------------------------------------------

const MERGE_FILE = 'merge.json';

type MergeInfo = { mergedInto: string; at: string };

function readMergeInfo(sessionDir: string): MergeInfo | undefined {
  try {
    const raw = fs.readFileSync(path.join(sessionDir, MERGE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as MergeInfo;
    return parsed?.mergedInto ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mergeSourcesFor(targetId: string): Array<{ id: string; dir: string }> {
  return store
    .listSessions()
    .filter((s) => readMergeInfo(s.dir)?.mergedInto === targetId);
}

type DigestRow = {
  kind?: string;
  ts?: string;
  artifacts?: string[];
  [k: string]: unknown;
};

/** Target digest + digests of sessions merged into it, events sorted by ts.
 *  Source artifact paths are rewritten absolute so thumbnails resolve. */
/** One feed line for a hand edit recorded by the Blender addon. */
function userEventSummary(ev: {
  kind?: string;
  op?: string;
  name?: string;
  objects?: Array<{ name: string; transform?: boolean; geometry?: boolean; loc?: number[] }>;
  dropped?: number;
}): string | null {
  if (ev.kind === 'op' && ev.op) {
    return `By hand: ${ev.name || ev.op} (${ev.op})`;
  }
  if (ev.kind === 'delta' && ev.objects?.length) {
    const parts = ev.objects.map((o) => {
      const what = [o.transform && 'moved', o.geometry && 'edited'].filter(Boolean).join('+') || 'changed';
      const loc = o.loc ? ` → (${o.loc.join(', ')})` : '';
      return `${o.name} ${what}${loc}`;
    });
    const more = ev.dropped ? ` (+${ev.dropped} more)` : '';
    return `By hand: ${parts.join(', ')}${more}`;
  }
  return null; // meta records don't belong in the feed
}

function combinedDigest(sessionDir: string, sessionId: string): DigestRow[] {
  const own = store.readJsonl(store.digestPath(sessionDir)) as DigestRow[];
  const sources = mergeSourcesFor(sessionId);

  const rows: DigestRow[] = [...own];

  // Hand edits from the linked blend's user.jsonl (Blender addon writer).
  try {
    const link = store.readLink(sessionDir);
    if (link?.blendId && typeof store.readUserEvents === 'function') {
      for (const ev of store.readUserEvents(link.blendId, 300)) {
        const summary = userEventSummary(ev);
        if (summary) {
          rows.push({ kind: 'event', ts: ev.ts, type: 'user_action', summary } as DigestRow);
        }
      }
    }
  } catch {
    /* user events are additive — never break the feed */
  }

  if (sources.length === 0) {
    return rows.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  }
  for (const src of sources) {
    for (const row of store.readJsonl(store.digestPath(src.dir)) as DigestRow[]) {
      if (row.kind === 'event' && Array.isArray(row.artifacts)) {
        rows.push({
          ...row,
          artifacts: row.artifacts.map((rel) =>
            rel.startsWith('/') ? rel : path.join(src.dir, rel)
          ),
        });
      } else {
        rows.push(row);
      }
    }
  }
  return rows.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
}

function listProjectInfos(): Array<{
  id: string;
  name: string;
  blendPath: string;
  sessionCount: number;
  blendExists: boolean;
  dir: string;
}> {
  const blends = blendLink.listBlendInfos().map((b) => ({
    id: b.id,
    name: b.name,
    blendPath: b.blendPath,
    sessionCount: b.sessionCount,
    blendExists: b.blendExists,
    dir: b.dir,
  }));
  const unlinked = blendLink.listSessionsWithLinks().filter((s) => !s.blendId);
  if (unlinked.length > 0) {
    blends.unshift({
      id: UNLINKED_ID,
      name: 'Unlinked sessions',
      blendPath: '',
      sessionCount: unlinked.length,
      blendExists: false,
      dir: store.sessionsRoot(),
    });
  }
  return blends;
}

/** Best-effort: detect + link any still-unlinked sessions from raw traffic. */
function relinkSessions(): void {
  for (const s of store.listSessions()) {
    try {
      const existing = store.readLink(s.dir);
      if (existing && (existing.via === 'manual' || existing.confidence === 'explicit')) continue;
      const hit = blendLink.detectBlendPathFromRaw(s.dir);
      if (hit) blendLink.linkSession(s, hit.blendPath, 'detected', hit.confidence);
    } catch {
      /* ignore */
    }
  }
}

export async function registerIpc(ipcMain: IpcMain, shell: Shell): Promise<void> {
  await ensureMods();
  try {
    store.ensureV2Home();
  } catch (err) {
    // v1 store: still register handlers so Preferences can run migrate.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[horatio] store not ready:', msg);
  }
  bindHomeEnv();
  applyRuntimeEnv();

  // OpenAI SDK's default fetch hangs in Electron main — bind Chromium net.fetch.
  try {
    const { net } = await import('electron');
    const eNet = (net as unknown as { default?: typeof net }).default ?? net;
    if (eNet?.fetch) {
      const { setElectronFetch } = await loadDist<{
        setElectronFetch: (f: typeof fetch) => void;
      }>('lib/nvidia.js');
      setElectronFetch(eNet.fetch.bind(eNet) as typeof fetch);
    }
  } catch (err) {
    console.error('[horatio] could not bind electron net.fetch', err);
  }

  ipcMain.handle('home:get', async () => {
    await ensureMods();
    return {
      home: store.horatioHome(),
      defaultHome: store.defaultAppDataHome(),
      project: store.readAppConfig().lastBlendId ?? '',
      packaged: isPackaged(),
      runtime: runtimeRoot(),
    };
  });

  ipcMain.handle('home:ensure', async () => {
    await ensureMods();
    const home = store.ensureV2Home();
    bindHomeEnv();
    return home;
  });

  ipcMain.handle('config:get', async () => {
    await ensureMods();
    return store.readAppConfig();
  });

  ipcMain.handle('config:set', async (_e, patch: Record<string, unknown>) => {
    await ensureMods();
    // Accept lastProject from older UI builds as lastBlendId.
    const normalized = { ...patch };
    if (typeof normalized.lastProject === 'string' && normalized.lastBlendId === undefined) {
      normalized.lastBlendId = normalized.lastProject;
      delete normalized.lastProject;
    }
    const cfg = { ...store.readAppConfig(), ...normalized };
    store.writeAppConfig(cfg);
    return cfg;
  });

  ipcMain.handle('projects:list', async () => {
    await ensureMods();
    store.ensureV2Home();
    relinkSessions();
    return listProjectInfos();
  });

  ipcMain.handle('projects:link-blend', async (_e, projectId: string | null) => {
    await ensureMods();
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Link Blender file',
      properties: ['openFile'],
      filters: [{ name: 'Blender', extensions: ['blend'] }],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    const blendPath = result.filePaths[0];
    const meta = blendLink.ensureBlendForPath(blendPath);
    // Link sessions currently in the selected group onto this .blend.
    if (projectId) {
      for (const s of sessionsForBlend(projectId)) {
        try {
          blendLink.linkSessionManually(s, blendPath);
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: true, canceled: false, project: meta, projects: listProjectInfos() };
  });

  ipcMain.handle('blend:reveal', async (_e, blendPath: string) => {
    if (!blendPath || !fs.existsSync(blendPath)) return false;
    shell.showItemInFolder(blendPath);
    return true;
  });

  ipcMain.handle('blend:open', async (_e, blendPath: string) => {
    if (!blendPath) return false;
    await shell.openPath(blendPath);
    return true;
  });

  ipcMain.handle('sessions:list', async (_e, project: string) => {
    await ensureMods();
    return sessionsForBlend(project).map(sessionSummary);
  });

  /** Flat session list across all blends — primary desktop navigation. */
  ipcMain.handle('sessions:list-all', async () => {
    await ensureMods();
    store.ensureV2Home();
    relinkSessions();
    const out: Array<{
      id: string;
      dir: string;
      title?: string;
      startedAt?: string;
      endedAt?: string;
      blendId?: string;
      blendName?: string;
      hasDigest: boolean;
      digestMtimeMs?: number;
    }> = [];
    for (const s of store.listSessions()) {
      if (readMergeInfo(s.dir)) continue; // folded into another session
      const info = store.readSessionInfo(s.dir);
      const link = store.readLink(s.dir);
      let blendName: string | undefined;
      if (link?.blendId) {
        const meta = store.readBlendMeta(link.blendId);
        blendName = meta?.name || path.basename(link.blendPath || '');
      }
      let digestMtimeMs: number | undefined;
      try {
        digestMtimeMs = fs.statSync(store.digestPath(s.dir)).mtimeMs;
      } catch {
        /* no digest yet */
      }
      out.push({
        id: s.id,
        dir: s.dir,
        title: info?.title,
        startedAt: info?.startedAt,
        endedAt: info?.endedAt,
        blendId: link?.blendId,
        blendName: blendName || undefined,
        hasDigest: digestMtimeMs !== undefined,
        digestMtimeMs,
      });
    }
    return out; // listSessions() is already newest-first
  });

  ipcMain.handle('session:digest', async (_e, sessionDir: string) => {
    await ensureMods();
    return combinedDigest(sessionDir, path.basename(sessionDir));
  });

  /** Fold source sessions into a target; optionally retag target to a .blend. */
  ipcMain.handle(
    'sessions:merge',
    async (_e, sourceIds: string[], targetId: string, blendPath?: string) => {
      await ensureMods();
      const targetDir = store.sessionDirById(targetId);
      if (!fs.existsSync(targetDir)) return { ok: false, error: `target session not found: ${targetId}` };
      const at = new Date().toISOString();
      let merged = 0;
      for (const id of sourceIds) {
        if (id === targetId) continue;
        const dir = store.sessionDirById(id);
        if (!fs.existsSync(dir)) continue;
        store.atomicWrite(
          path.join(dir, MERGE_FILE),
          JSON.stringify({ mergedInto: targetId, at } satisfies MergeInfo, null, 2) + '\n'
        );
        merged++;
      }
      if (blendPath) {
        try {
          blendLink.linkSessionManually({ id: targetId, dir: targetDir }, blendPath);
        } catch (err) {
          return { ok: true, merged, error: `merged, but retag failed: ${String(err)}` };
        }
      }
      return { ok: true, merged };
    }
  );

  /** Retag one session onto a .blend (manual link always wins). */
  ipcMain.handle('session:link', async (_e, sessionId: string, blendPath: string) => {
    await ensureMods();
    const dir = store.sessionDirById(sessionId);
    if (!fs.existsSync(dir)) return { ok: false, error: `session not found: ${sessionId}` };
    try {
      blendLink.linkSessionManually({ id: sessionId, dir }, blendPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  /** Finder picker for a .blend, used by Merge (destination) and Link. */
  ipcMain.handle('dialog:pick-blend', async () => {
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      title: 'Choose Blender file',
      properties: ['openFile' as const],
      filters: [{ name: 'Blender', extensions: ['blend'] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    return { canceled: false as const, blendPath: result.filePaths[0] };
  });

  /** Deterministic markdown export of a session's feed (+ note when present). */
  ipcMain.handle('session:export', async (_e, sessionId: string) => {
    await ensureMods();
    const dir = store.sessionDirById(sessionId);
    if (!fs.existsSync(dir)) return { ok: false, error: `session not found: ${sessionId}` };

    const info = store.readSessionInfo(dir);
    const link = store.readLink(dir);
    const blendName = link?.blendId
      ? store.readBlendMeta(link.blendId)?.name || path.basename(link.blendPath || '')
      : undefined;
    const title = info?.title?.trim() || sessionId;

    const events = combinedDigest(dir, sessionId).filter(
      (r) => r.kind === 'event' && typeof r.summary === 'string'
    ) as Array<
      DigestRow & {
        summary: string;
        type?: string;
        tool?: string;
        error?: { message: string; resolved?: boolean };
      }
    >;

    const lines: string[] = [`# ${title}`, ''];
    lines.push(`- Session: \`${sessionId}\``);
    if (blendName) lines.push(`- Project: ${blendName}`);
    if (info?.startedAt) lines.push(`- Started: ${info.startedAt}`);
    if (info?.endedAt) lines.push(`- Ended: ${info.endedAt}`);
    lines.push('', '## Activity', '');
    if (events.length === 0) {
      lines.push('_no recorded activity_');
    }
    for (const ev of events) {
      const t = typeof ev.ts === 'string' ? ev.ts : '';
      lines.push(`- ${t ? `\`${t}\` ` : ''}${ev.summary}${ev.type === 'error' ? ' **(error)**' : ''}`);
      if (ev.error?.message) {
        lines.push(`  - error: \`${ev.error.message}\`${ev.error.resolved ? ' (resolved)' : ''}`);
      }
      for (const a of ev.artifacts ?? []) {
        lines.push(`  - artifact: ${a}`);
      }
    }
    const note = store.notePath(dir);
    if (fs.existsSync(note)) {
      const text = fs.readFileSync(note, 'utf8').trim();
      if (text) lines.push('', '## Session note', '', text);
    }
    const markdown = lines.join('\n') + '\n';

    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getFocusedWindow();
    const safe = title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || sessionId;
    const opts = {
      title: 'Export session',
      defaultPath: `${safe}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, markdown, 'utf8');
    return { ok: true, outPath: result.filePath };
  });

  ipcMain.handle('reveal', async (_e, targetPath: string) => {
    if (!targetPath || !fs.existsSync(targetPath)) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });

  ipcMain.handle('open-path', async (_e, targetPath: string) => {
    if (!targetPath) return;
    await shell.openPath(targetPath);
  });

  ipcMain.handle('copy-path', async (_e, text: string) => {
    const { clipboard } = await import('electron');
    const clip = (clipboard as unknown as { default?: typeof clipboard }).default ?? clipboard;
    clip.writeText(text);
    return true;
  });

  ipcMain.handle('install:wrap', async (_e, serverName: string) => {
    await ensureMods();
    bindHomeEnv();
    applyRuntimeEnv();
    return install.wrapServers([serverName]);
  });

  ipcMain.handle('install:uninstall', async () => {
    await ensureMods();
    applyRuntimeEnv();
    return install.uninstallAll();
  });

  ipcMain.handle('install:repair-store', async () => {
    await ensureMods();
    bindHomeEnv();
    applyRuntimeEnv();
    return install.repairStoreHomes();
  });

  ipcMain.handle('install:status', async () => {
    await ensureMods();
    applyRuntimeEnv();
    return install.getInstallStatus();
  });

  ipcMain.handle('apikey:status', async () => {
    await ensureMods();
    applyRuntimeEnv();
    const { loadEnv } = await loadDist<{ loadEnv: () => void }>('lib/nvidia.js');
    loadEnv();
    const home = store.horatioHome();
    const envFile = path.join(home, '.env');
    let fromFile = false;
    if (fs.existsSync(envFile)) {
      const text = fs.readFileSync(envFile, 'utf8');
      fromFile = /^NVIDIA_API_KEY=.+/m.test(text);
    }
    const fromEnv = Boolean(process.env.NVIDIA_API_KEY);
    return { set: fromFile || fromEnv, fromFile, fromEnv, envPath: envFile };
  });

  ipcMain.handle('apikey:set', async (_e, key: string) => {
    await ensureMods();
    const home = store.ensureV2Home();
    const envFile = path.join(home, '.env');
    let existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const line = `NVIDIA_API_KEY=${key.trim()}`;
    if (/^NVIDIA_API_KEY=.*$/m.test(existing)) {
      existing = existing.replace(/^NVIDIA_API_KEY=.*$/m, line);
    } else {
      existing = existing.replace(/\n*$/, '\n') + line + '\n';
    }
    fs.writeFileSync(envFile, existing, { mode: 0o600 });
    process.env.NVIDIA_API_KEY = key.trim();
    try {
      const { resetClient } = await loadDist<{ resetClient: () => void }>('lib/nvidia.js');
      resetClient();
    } catch {
      /* ignore */
    }
    return { set: true, envPath: envFile };
  });

  ipcMain.handle('apikey:clear', async () => {
    await ensureMods();
    const home = store.horatioHome();
    const envFile = path.join(home, '.env');
    if (fs.existsSync(envFile)) {
      let existing = fs.readFileSync(envFile, 'utf8');
      existing = existing.replace(/^NVIDIA_API_KEY=.*$/m, 'NVIDIA_API_KEY=');
      fs.writeFileSync(envFile, existing, { mode: 0o600 });
    }
    delete process.env.NVIDIA_API_KEY;
    try {
      const { resetClient } = await loadDist<{ resetClient: () => void }>('lib/nvidia.js');
      resetClient();
    } catch {
      /* ignore */
    }
    return { set: false, envPath: envFile };
  });

  ipcMain.handle('migrate:scan', async () => {
    await ensureMods();
    const home = store.horatioHome();
    const state = store.storeState(home);
    const legacy = store.legacyAppDataHome();
    const sources: Array<{ kind: string; path: string; label: string }> = [];

    if (state === 'v1') {
      sources.push({ kind: 'v1-home', path: home, label: `v1 store at ${home}` });
    }
    if (
      path.resolve(legacy) !== path.resolve(home) &&
      fs.existsSync(legacy) &&
      !fs.existsSync(path.join(legacy, 'MOVED-TO-HORATIO.txt'))
    ) {
      sources.push({
        kind: 'legacy',
        path: legacy,
        label: `Legacy flightrec store (${legacy})`,
      });
    }
    if (!isPackaged()) {
      for (const name of ['.horatio', '.flightrec']) {
        const repoLocal = path.join(REPO_ROOT, name);
        if (
          fs.existsSync(path.join(repoLocal, 'sessions')) ||
          fs.existsSync(path.join(repoLocal, 'projects')) ||
          fs.existsSync(path.join(repoLocal, 'project-state.md'))
        ) {
          sources.push({
            kind: 'project-local',
            path: repoLocal,
            label: `Repo ${name}`,
          });
        }
      }
    }
    const hasData = sources.length > 0;
    return { hasData, home, sources };
  });

  ipcMain.handle('migrate:import', async (_e, _sourcePath: string, _destProject: string) => {
    await ensureMods();
    bindHomeEnv();
    const { migrateStore } = await loadDist<{
      migrateStore: (opts?: { dryRun?: boolean }) => {
        sessionsMigrated: number;
        target: string;
        actions: string[];
      };
    }>('lib/migrate.js');
    const report = migrateStore();
    return { importedSessions: report.sessionsMigrated, dest: report.target };
  });

  ipcMain.handle('watch:start', async (event, watchPath: string) => {
    for (const w of watchers) w.close();
    watchers = [];
    if (!watchPath || !fs.existsSync(watchPath)) return false;
    try {
      const sender = event.sender;
      const stop = () => {
        for (const w of watchers) w.close();
        watchers = [];
      };
      sender.once('destroyed', stop);
      const w = fs.watch(watchPath, { recursive: true }, () => {
        if (sender.isDestroyed()) {
          stop();
          return;
        }
        try {
          sender.send('watch:changed', watchPath);
        } catch {
          stop();
        }
      });
      watchers.push(w);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('watch:stop', async () => {
    for (const w of watchers) w.close();
    watchers = [];
    return true;
  });
}
