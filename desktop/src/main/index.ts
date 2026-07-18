/**
 * Electron main — FS + install/distill via parent repo dist/.
 */
import electron from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { registerIpc } from './ipc';

// CJS interop: some Electron builds expose APIs on default export.
const e = (electron as unknown as { default?: typeof electron }).default ?? electron;
const { app, BrowserWindow, ipcMain, shell, protocol, net, Menu } = e;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'flightrec-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

function resolvePreload(): string {
  const cjs = join(__dirname, '../preload/index.cjs');
  const js = join(__dirname, '../preload/index.js');
  const mjs = join(__dirname, '../preload/index.mjs');
  if (existsSync(cjs)) return cjs;
  if (existsSync(js)) return js;
  if (existsSync(mjs)) return mjs;
  return cjs;
}

let prefsWindow: InstanceType<typeof BrowserWindow> | null = null;

function loadRenderer(
  win: InstanceType<typeof BrowserWindow>,
  query?: Record<string, string>
): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query });
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'flightrec',
    backgroundColor: '#1a1b1e',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  loadRenderer(win);
}

function openPreferences(): void {
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.focus();
    return;
  }

  prefsWindow = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    title: 'Preferences',
    backgroundColor: '#1a1b1e',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  prefsWindow.on('closed', () => {
    prefsWindow = null;
  });

  loadRenderer(prefsWindow, { view: 'preferences' });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Preferences…',
                accelerator: 'CmdOrCtrl+,',
                click: () => openPreferences(),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        ...(!isMac
          ? [
              {
                label: 'Preferences…',
                accelerator: 'CmdOrCtrl+,',
                click: () => openPreferences(),
              },
              { type: 'separator' as const },
            ]
          : []),
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
            ]
          : [{ role: 'close' as const }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Query-param form avoids Chromium treating path segments (e.g. "Users")
  // as a host — which breaks file:// conversion for Application Support paths.
  protocol.handle('flightrec-file', (request) => {
    try {
      const u = new URL(request.url);
      const abs = u.searchParams.get('p');
      if (abs) return net.fetch(pathToFileURL(abs).href);
      const fallback = request.url.replace(/^flightrec-file:/, 'file:');
      return net.fetch(fallback);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  await registerIpc(ipcMain, shell);
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
