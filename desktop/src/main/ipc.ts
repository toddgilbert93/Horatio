/**
 * IPC handlers — store reads, install/control, watchers, migration.
 */
import type { IpcMain, Shell } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REPO_ROOT, loadDist, applyRuntimeEnv, resolveNodeExecutable, runtimeRoot, isPackaged } from './paths';

type StoreMod = typeof import('../../../dist/lib/store.js');
type InstallMod = typeof import('../../../dist/install.js');

let store: StoreMod;
let install: InstallMod;
let watchers: fs.FSWatcher[] = [];

async function ensureMods(): Promise<void> {
  applyRuntimeEnv();
  if (!store) store = await loadDist<StoreMod>('lib/store.js');
  if (!install) install = await loadDist<InstallMod>('install.js');
}

function setProjectEnv(project: string): void {
  process.env.FLIGHTREC_PROJECT = project;
}

function artifactCount(sessionDir: string): number {
  const artifacts = store.artifactsDir(sessionDir);
  if (!fs.existsSync(artifacts)) return 0;
  return fs.readdirSync(artifacts).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)).length;
}

function sessionSummary(s: { id: string; dir: string }) {
  return {
    id: s.id,
    dir: s.dir,
    hasNote: store.noteExists(s.dir),
    hasDigest: fs.existsSync(store.digestPath(s.dir)),
    hasRaw: fs.existsSync(store.rawPath(s.dir)),
    hasDistillLog: fs.existsSync(store.distillLogPath(s.dir)),
    artifactCount: artifactCount(s.dir),
  };
}

function artifactUrl(abs: string): string {
  return `flightrec-file://local/?p=${encodeURIComponent(abs)}`;
}

export async function registerIpc(ipcMain: IpcMain, shell: Shell): Promise<void> {
  await ensureMods();
  store.ensureFlightrecHome();
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
    console.error('[flightrec] could not bind electron net.fetch', err);
  }

  ipcMain.handle('home:get', async () => {
    await ensureMods();
    return {
      home: store.flightrecHome(),
      defaultHome: store.defaultAppDataHome(),
      project: store.projectName(),
      packaged: isPackaged(),
      runtime: runtimeRoot(),
    };
  });

  ipcMain.handle('home:ensure', async () => {
    await ensureMods();
    return store.ensureFlightrecHome();
  });

  ipcMain.handle('config:get', async () => {
    await ensureMods();
    return store.readAppConfig();
  });

  ipcMain.handle('config:set', async (_e, patch: Record<string, unknown>) => {
    await ensureMods();
    const cfg = { ...store.readAppConfig(), ...patch };
    store.writeAppConfig(cfg);
    return cfg;
  });

  ipcMain.handle('projects:list', async () => {
    await ensureMods();
    const { listProjectInfos, ensureUnsavedProject, attachSessionToBlend } =
      await loadDist<typeof import('../../../dist/lib/blend-project.js')>('lib/blend-project.js');
    ensureUnsavedProject();
    // Re-scan sessions for blend paths so the UI stays current
    for (const p of listProjectInfos()) {
      for (const s of store.listSessions(p.id)) {
        try {
          attachSessionToBlend(s);
        } catch {
          /* ignore */
        }
      }
    }
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
    const { ensureProjectForBlend, attachSessionToBlend, listProjectInfos } =
      await loadDist<typeof import('../../../dist/lib/blend-project.js')>('lib/blend-project.js');
    const meta = ensureProjectForBlend(blendPath);
    // If linking from a specific legacy/unsaved project, move its sessions over
    if (projectId && projectId !== meta.id) {
      for (const s of store.listSessions(projectId)) {
        try {
          attachSessionToBlend(s, blendPath);
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
    setProjectEnv(project);
    return store.listSessions(project).map(sessionSummary);
  });

  ipcMain.handle('project:timeline', async (_e, project: string) => {
    await ensureMods();
    setProjectEnv(project);
    return store.listSessions(project).map((s) => ({
      ...sessionSummary(s),
      records: store.readJsonl(store.digestPath(s.dir)),
    }));
  });

  ipcMain.handle('project:notes', async (_e, project: string) => {
    await ensureMods();
    setProjectEnv(project);
    const out: Array<{ sessionId: string; note: string }> = [];
    for (const s of store.listSessions(project)) {
      const f = path.join(s.dir, 'note.md');
      if (!fs.existsSync(f)) continue;
      const note = fs.readFileSync(f, 'utf8');
      if (note.trim()) out.push({ sessionId: s.id, note });
    }
    return out;
  });

  ipcMain.handle('project:artifacts', async (_e, project: string) => {
    await ensureMods();
    setProjectEnv(project);
    const out: Array<{ sessionId: string; name: string; path: string; url: string }> = [];
    for (const s of store.listSessions(project)) {
      const dir = store.artifactsDir(s.dir);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs
        .readdirSync(dir)
        .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
        .sort()
        .reverse()) {
        const abs = path.join(dir, name);
        out.push({ sessionId: s.id, name, path: abs, url: artifactUrl(abs) });
      }
    }
    return out;
  });

  ipcMain.handle('session:note', async (_e, sessionDir: string) => {
    const f = path.join(sessionDir, 'note.md');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  });

  ipcMain.handle('session:digest', async (_e, sessionDir: string) => {
    await ensureMods();
    return store.readJsonl(store.digestPath(sessionDir));
  });

  ipcMain.handle('session:raw', async (_e, sessionDir: string, limit = 500) => {
    await ensureMods();
    const rows = store.readJsonl(store.rawPath(sessionDir));
    return rows.slice(-limit);
  });

  ipcMain.handle('session:distillLog', async (_e, sessionDir: string) => {
    await ensureMods();
    const f = store.distillLogPath(sessionDir);
    if (!fs.existsSync(f)) return '';
    const text = fs.readFileSync(f, 'utf8');
    return text.length > 100_000 ? text.slice(-100_000) : text;
  });

  ipcMain.handle('session:artifacts', async (_e, sessionDir: string) => {
    await ensureMods();
    const dir = store.artifactsDir(sessionDir);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
      .sort()
      .map((name) => {
        const abs = path.join(dir, name);
        return { name, path: abs, url: artifactUrl(abs) };
      });
  });

  ipcMain.handle('project:state', async (_e, project: string) => {
    await ensureMods();
    setProjectEnv(project);
    return {
      state: store.readProjectState(project),
      decisions: store.readDecisions(project),
      dir: store.projectDir(project),
    };
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
    const home = store.flightrecHome();
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
    const home = store.ensureFlightrecHome();
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
    const home = store.flightrecHome();
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

  ipcMain.handle('distill:save', async (_e, sessionRef: string, project: string) => {
    await ensureMods();
    setProjectEnv(project);
    process.env.FLIGHTREC_HOME = store.flightrecHome();
    applyRuntimeEnv();

    const session =
      !sessionRef || sessionRef === 'latest'
        ? store.latestSession(project)
        : store.resolveSession(sessionRef, project);
    if (!session) {
      return { ok: false, output: 'No sessions for this Blender file yet' };
    }

    try {
      // Same in-process path as export — avoids Electron spawn/PATH hangs.
      const { loadEnv, setElectronFetch, resetClient } = await loadDist<{
        loadEnv: () => void;
        setElectronFetch: (f: typeof fetch) => void;
        resetClient: () => void;
      }>('lib/nvidia.js');
      try {
        const { net } = await import('electron');
        const eNet = (net as unknown as { default?: typeof net }).default ?? net;
        if (eNet?.fetch) setElectronFetch(eNet.fetch.bind(eNet) as typeof fetch);
      } catch {
        /* ignore */
      }
      loadEnv();
      resetClient();
      const { ensureDistilled, synthesizeSession } = await loadDist<{
        ensureDistilled: (dir: string) => Promise<void>;
        synthesizeSession: (dir: string) => Promise<unknown>;
      }>('distill/tier2.js');

      await ensureDistilled(session.dir);
      await synthesizeSession(session.dir);
      return { ok: true, output: `Saved ${session.id}` };
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err);
      console.error('[flightrec distill:save]', output);
      return { ok: false, output };
    }
  });

  // Keep wipe+re-derive available for power users / debugging.
  ipcMain.handle('distill:replay', async (_e, sessionRef: string, project: string) => {
    await ensureMods();
    setProjectEnv(project);
    process.env.FLIGHTREC_HOME = store.flightrecHome();
    applyRuntimeEnv();
    const ref =
      !sessionRef || sessionRef === 'latest'
        ? store.latestSession(project)?.id
        : sessionRef;
    if (!ref) {
      return { ok: false, output: 'No sessions for this Blender file yet' };
    }
    const cli = path.join(runtimeRoot(), 'distill', 'cli.js');
    const nodeBin = resolveNodeExecutable();
    const env = {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise<{ ok: boolean; output: string }>((resolve) => {
      const child = spawn(nodeBin, [cli, 'distill', '--replay', ref], {
        cwd: runtimeRoot(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', (d) => {
        output += d.toString();
      });
      child.stderr?.on('data', (d) => {
        output += d.toString();
      });
      child.on('close', (code) => {
        resolve({ ok: code === 0, output });
      });
      child.on('error', (err) => {
        resolve({ ok: false, output: String(err) });
      });
    });
  });

  ipcMain.handle(
    'export:agent-memory',
    async (
      _e,
      sessionDir: string,
      project: string,
      opts: { assemble?: boolean; saveAs?: boolean } = {}
    ) => {
      await ensureMods();
      setProjectEnv(project);
      process.env.FLIGHTREC_HOME = store.flightrecHome();
      // Load app-data / repo .env so NVIDIA_API_KEY is available for Nemotron.
      const { loadEnv } = await loadDist<{ loadEnv: () => void }>('lib/nvidia.js');
      loadEnv();

      const { exportAgentMemory } = await loadDist<{
        exportAgentMemory: (
          dir: string,
          o?: { outPath?: string; assemble?: boolean }
        ) => Promise<{
          markdown: string;
          sessionPath: string;
          projectPath?: string;
          outPath?: string;
        }>;
      }>('distill/agent-memory.js');

      let outPath: string | undefined;
      if (opts.saveAs) {
        const { dialog, BrowserWindow } = await import('electron');
        const win = BrowserWindow.getFocusedWindow();
        const result = await dialog.showSaveDialog(win ?? undefined, {
          title: 'Save agent memory',
          defaultPath: 'flightrec-memory.md',
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (result.canceled || !result.filePath) {
          return { ok: false, canceled: true };
        }
        outPath = result.filePath;
      }

      try {
        const exported = await exportAgentMemory(sessionDir, {
          outPath,
          assemble: opts.assemble,
        });
        return {
          ok: true,
          canceled: false,
          sessionPath: exported.sessionPath,
          projectPath: exported.projectPath,
          outPath: exported.outPath,
          markdown: exported.markdown,
        };
      } catch (err) {
        return { ok: false, canceled: false, error: String(err) };
      }
    }
  );

  ipcMain.handle('migrate:scan', async () => {
    await ensureMods();
    const home = store.flightrecHome();
    const projectsDir = path.join(home, 'projects');
    const hasData =
      fs.existsSync(projectsDir) &&
      fs.readdirSync(projectsDir).some((n) => {
        const sessions = path.join(projectsDir, n, 'sessions');
        return fs.existsSync(sessions) && fs.readdirSync(sessions).length > 0;
      });

    const sources: Array<{ kind: string; path: string; label: string }> = [];
    if (!isPackaged()) {
      const repoLocal = path.join(REPO_ROOT, '.flightrec');
      if (
        fs.existsSync(path.join(repoLocal, 'sessions')) ||
        fs.existsSync(path.join(repoLocal, 'project-state.md'))
      ) {
        sources.push({ kind: 'project-local', path: repoLocal, label: 'Repo .flightrec' });
      }
    }
    const legacy = path.join(os.homedir(), '.flightrec', 'projects');
    if (fs.existsSync(legacy)) {
      for (const name of fs.readdirSync(legacy)) {
        const p = path.join(legacy, name);
        if (fs.statSync(p).isDirectory()) {
          sources.push({
            kind: 'legacy',
            path: p,
            label: `Legacy ~/.flightrec/projects/${name}`,
          });
        }
      }
    }
    return { hasData, home, sources };
  });

  ipcMain.handle('migrate:import', async (_e, sourcePath: string, destProject: string) => {
    await ensureMods();
    const dest = store.projectDir(destProject);
    fs.mkdirSync(path.join(dest, 'sessions'), { recursive: true });

    const srcSessions = path.join(sourcePath, 'sessions');
    const srcState = path.join(sourcePath, 'project-state.md');
    const srcDecisions = path.join(sourcePath, 'decisions.jsonl');

    let importedSessions = 0;
    if (fs.existsSync(srcSessions)) {
      for (const name of fs.readdirSync(srcSessions)) {
        const from = path.join(srcSessions, name);
        const to = path.join(dest, 'sessions', name);
        if (!fs.statSync(from).isDirectory()) continue;
        if (fs.existsSync(to)) continue;
        fs.cpSync(from, to, { recursive: true });
        importedSessions++;
      }
    }
    if (fs.existsSync(srcState) && !fs.existsSync(path.join(dest, 'project-state.md'))) {
      fs.copyFileSync(srcState, path.join(dest, 'project-state.md'));
    }
    if (fs.existsSync(srcDecisions) && !fs.existsSync(path.join(dest, 'decisions.jsonl'))) {
      fs.copyFileSync(srcDecisions, path.join(dest, 'decisions.jsonl'));
    }
    return { importedSessions, dest };
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
