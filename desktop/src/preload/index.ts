import electron from 'electron';

const e = (electron as unknown as { default?: typeof electron }).default ?? electron;
const { contextBridge, ipcRenderer } = e;

export type SessionSummary = {
  id: string;
  dir: string;
  hasNote: boolean;
  hasDigest: boolean;
  hasRaw: boolean;
  hasDistillLog: boolean;
  artifactCount: number;
};

export type InstallStatus = {
  storeHome: string;
  clients: Array<{
    id: string;
    label: string;
    configPath: string;
    servers: Array<{
      name: string;
      kind: string;
      wrapped: boolean;
      isMemory: boolean;
      storeHome?: string;
    }>;
    error?: string;
  }>;
};

export type WrapResult = {
  ok: boolean;
  storeHome: string;
  lines: string[];
  restartHint: boolean;
};

const api = {
  getHome: () =>
    ipcRenderer.invoke('home:get') as Promise<{
      home: string;
      defaultHome: string;
      project: string;
      runtime?: string;
      packaged?: boolean;
    }>,
  ensureHome: () => ipcRenderer.invoke('home:ensure') as Promise<string>,
  getConfig: () => ipcRenderer.invoke('config:get') as Promise<Record<string, unknown>>,
  setConfig: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('config:set', patch) as Promise<Record<string, unknown>>,
  listProjects: () =>
    ipcRenderer.invoke('projects:list') as Promise<
      Array<{
        id: string;
        name: string;
        blendPath: string;
        sessionCount: number;
        blendExists: boolean;
        dir: string;
      }>
    >,
  linkBlend: (projectId: string | null) =>
    ipcRenderer.invoke('projects:link-blend', projectId) as Promise<{
      ok: boolean;
      canceled?: boolean;
      project?: { id: string; name: string; blendPath: string };
      projects?: Array<{
        id: string;
        name: string;
        blendPath: string;
        sessionCount: number;
        blendExists: boolean;
        dir: string;
      }>;
    }>,
  revealBlend: (blendPath: string) => ipcRenderer.invoke('blend:reveal', blendPath) as Promise<boolean>,
  openBlend: (blendPath: string) => ipcRenderer.invoke('blend:open', blendPath) as Promise<boolean>,
  listSessions: (project: string) =>
    ipcRenderer.invoke('sessions:list', project) as Promise<SessionSummary[]>,
  getProjectTimeline: (project: string) =>
    ipcRenderer.invoke('project:timeline', project) as Promise<
      Array<SessionSummary & { records: unknown[] }>
    >,
  getProjectNotes: (project: string) =>
    ipcRenderer.invoke('project:notes', project) as Promise<
      Array<{ sessionId: string; note: string }>
    >,
  getProjectArtifacts: (project: string) =>
    ipcRenderer.invoke('project:artifacts', project) as Promise<
      Array<{ sessionId: string; name: string; path: string; url: string }>
    >,
  getNote: (sessionDir: string) => ipcRenderer.invoke('session:note', sessionDir) as Promise<string>,
  getDigest: (sessionDir: string) =>
    ipcRenderer.invoke('session:digest', sessionDir) as Promise<unknown[]>,
  getRaw: (sessionDir: string, limit?: number) =>
    ipcRenderer.invoke('session:raw', sessionDir, limit) as Promise<unknown[]>,
  getDistillLog: (sessionDir: string) =>
    ipcRenderer.invoke('session:distillLog', sessionDir) as Promise<string>,
  getArtifacts: (sessionDir: string) =>
    ipcRenderer.invoke('session:artifacts', sessionDir) as Promise<
      Array<{ name: string; path: string; url: string }>
    >,
  getProjectState: (project: string) =>
    ipcRenderer.invoke('project:state', project) as Promise<{
      state: string;
      decisions: unknown[];
      dir: string;
    }>,
  reveal: (targetPath: string) => ipcRenderer.invoke('reveal', targetPath) as Promise<boolean>,
  openPath: (targetPath: string) => ipcRenderer.invoke('open-path', targetPath) as Promise<void>,
  copyPath: (text: string) => ipcRenderer.invoke('copy-path', text) as Promise<boolean>,
  installStatus: () => ipcRenderer.invoke('install:status') as Promise<InstallStatus>,
  wrap: (serverName: string) => ipcRenderer.invoke('install:wrap', serverName) as Promise<WrapResult>,
  uninstall: () => ipcRenderer.invoke('install:uninstall') as Promise<WrapResult>,
  repairStore: () => ipcRenderer.invoke('install:repair-store') as Promise<WrapResult>,
  apiKeyStatus: () =>
    ipcRenderer.invoke('apikey:status') as Promise<{
      set: boolean;
      fromFile: boolean;
      fromEnv: boolean;
      envPath: string;
    }>,
  setApiKey: (key: string) =>
    ipcRenderer.invoke('apikey:set', key) as Promise<{ set: boolean; envPath: string }>,
  clearApiKey: () =>
    ipcRenderer.invoke('apikey:clear') as Promise<{ set: boolean; envPath: string }>,
  distillSave: (sessionRef: string, project: string) =>
    ipcRenderer.invoke('distill:save', sessionRef, project) as Promise<{
      ok: boolean;
      output: string;
    }>,
  distillReplay: (sessionRef: string, project: string) =>
    ipcRenderer.invoke('distill:replay', sessionRef, project) as Promise<{
      ok: boolean;
      output: string;
    }>,
  exportAgentMemory: (
    sessionDir: string,
    project: string,
    opts?: { assemble?: boolean; saveAs?: boolean }
  ) =>
    ipcRenderer.invoke('export:agent-memory', sessionDir, project, opts) as Promise<{
      ok: boolean;
      canceled?: boolean;
      sessionPath?: string;
      projectPath?: string;
      outPath?: string;
      markdown?: string;
      error?: string;
    }>,
  migrateScan: () =>
    ipcRenderer.invoke('migrate:scan') as Promise<{
      hasData: boolean;
      home: string;
      sources: Array<{ kind: string; path: string; label: string }>;
    }>,
  migrateImport: (sourcePath: string, destProject: string) =>
    ipcRenderer.invoke('migrate:import', sourcePath, destProject) as Promise<{
      importedSessions: number;
      dest: string;
    }>,
  watchStart: (watchPath: string) => ipcRenderer.invoke('watch:start', watchPath) as Promise<boolean>,
  watchStop: () => ipcRenderer.invoke('watch:stop') as Promise<boolean>,
  onWatchChanged: (cb: (path: string) => void) => {
    const handler = (_: unknown, p: string) => cb(p);
    ipcRenderer.on('watch:changed', handler);
    return () => ipcRenderer.removeListener('watch:changed', handler);
  },
};

contextBridge.exposeInMainWorld('flightrec', api);

export type FlightrecApi = typeof api;
