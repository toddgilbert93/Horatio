# Desktop app

The Electron app ([../desktop/](../desktop/)) is flightrec's **viewer + control plane**: browse sessions (timeline, notes, project state, artifacts, raw, distill log), run Tier 2 ("Save state") and agent-memory export, manage the NVIDIA key, and wrap/unwrap MCP servers. It's built with [electron-vite](https://electron-vite.org/) (esbuild under the hood — no `tsc` typecheck gate) and packaged with electron-builder.

For the capture/distill pipeline see [architecture.md](architecture.md).

## Structure

```
desktop/
  electron.vite.config.ts      # three build targets: main, preload, renderer
  src/
    main/
      index.ts                 # app bootstrap, windows, menu, flightrec-file:// protocol
      ipc.ts                   # all ipcMain.handle handlers (the whole backend surface)
      paths.ts                 # runtime resolution (dev dist vs packaged runtime)
    preload/
      index.ts                 # contextBridge → window.flightrec (typed IPC wrappers)
      index.d.ts               # global Window typing, derived from FlightrecApi
    renderer/
      App.tsx                  # main viewer (project select + tabbed panes)
      PreferencesApp.tsx       # preferences window (?view=preferences)
      components/              # Timeline, ControlPlane, MarkdownView, Toast
  resources/flightrec-runtime/ # staged runtime for packaging (gitignored, built by pack-runtime)
  release/                     # electron-builder output (.dmg)
```

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`. It has **no Node access** — everything goes through `window.flightrec.*`, which the preload bridges to `ipcMain` handlers in the main process. The main process is where all filesystem and child-process work happens.

## Runtime resolution — the key idea

The app doesn't reimplement capture/distill; it **calls the compiled `dist/`** (the same code the CLI runs). Where that code lives differs between dev and packaged, and [main/paths.ts](../desktop/src/main/paths.ts) is the single source of truth:

| | `runtimeRoot()` | Node binary | why |
|---|---|---|---|
| **Dev** | `<repo>/dist` | `process.execPath` / `which node` | picks up `npm run build` immediately |
| **Packaged** | `<App>.app/Contents/Resources/flightrec-runtime` | bundled `flightrec-runtime/bin/node` | self-contained; no repo, no system Node needed |

`loadDist<T>(rel)` dynamically `import()`s a module from the runtime root (e.g. `lib/store.js`, `install.js`, `lib/blend-project.js`). `applyRuntimeEnv()` then exports env vars so any code that *spawns* — the installer writing MCP configs, the distiller subprocess — resolves the **same** runtime:

- `FLIGHTREC_RUNTIME`, `FLIGHTREC_NODE`
- `FLIGHTREC_TAP_PATH`, `FLIGHTREC_MEMORY_PATH`

That's why an MCP config written by the packaged app points at the bundled `bin/node` and the bundled `tap.js`, not the user's PATH.

### `ELECTRON_RUN_AS_NODE`

Every spawn of the distiller (and the `dev`/`start`/`preview` npm scripts) uses `env -u ELECTRON_RUN_AS_NODE`. If that variable is set, Electron launches as a bare Node interpreter and the app never boots. IPC handlers that spawn also `delete env.ELECTRON_RUN_AS_NODE` before spawning the child. If the app mysteriously runs headless, this is the first thing to check.

## IPC surface

All handlers live in [main/ipc.ts](../desktop/src/main/ipc.ts); all wrappers in [preload/index.ts](../desktop/src/preload/index.ts). Grouped:

- **Store/config** — `home:get`, `home:ensure`, `config:get`, `config:set`
- **Projects (blend buckets)** — `projects:list` (re-scans + attaches every session), `projects:link-blend` (native file dialog → `ensureProjectForBlend`), `blend:reveal`, `blend:open`
- **Sessions** — `sessions:list`, `project:timeline`, `project:notes`, `project:artifacts`, `session:note`, `session:digest`, `session:raw`, `session:distillLog`, `session:artifacts`, `project:state`
- **Distill/export** — `distill:save`, `distill:replay`, `export:agent-memory` (all spawn `dist/distill/cli.js` via the resolved Node)
- **Install/control** — `install:status`, `install:wrap`, `install:uninstall`, `install:repair-store`
- **API key** — `apikey:status`, `apikey:set`, `apikey:clear` (writes `<home>/.env`, mode `0600`)
- **Migration** — `migrate:scan`, `migrate:import` (copy legacy/project-local stores in, non-destructively)
- **Files/watch** — `reveal`, `open-path`, `copy-path`, `watch:start`, `watch:stop` + the `watch:changed` push event

Read handlers call `setProjectEnv(project)` first so `FLIGHTREC_PROJECT` scopes the underlying store reads. CLI-spawned paths that can't rely on env derive the project from the session dir instead (see `projectIdFromSessionDir`).

## Artifacts: the `flightrec-file://` protocol

Screenshots live outside the app bundle (in Application Support), which the renderer can't load via `file://` — and Chromium mangles `file://` for paths containing segments like `Users`. So [main/index.ts](../desktop/src/main/index.ts) registers a privileged `flightrec-file://` scheme and serves the absolute path from a query param: `flightrec-file://local/?p=<encoded-abs-path>` → `net.fetch(pathToFileURL(abs))`. Artifact URLs in IPC responses use this form.

## Live refresh

`watch:start` sets a recursive `fs.watch` on the store home and pushes `watch:changed` to the renderer, which re-lists projects and reloads the current project's data. This is how a session recorded in the background (tap + distiller running under an MCP client) shows up in the app without a manual reload. Watchers are torn down on renderer destroy and on `watch:stop`.

## Windows & menu

- **Main window** — `App.tsx`. Project `<select>` (blend buckets, `_unsaved` sorted last), tabs, **Save state** / **Export agent memory…**.
- **Preferences window** — opened from the app menu (`Cmd/Ctrl+,`); loads the renderer with `?view=preferences` → `PreferencesApp.tsx` → `ControlPlane`. Manages the data folder, `.blend` linking, the NVIDIA key, MCP client wrapping, store-path repair, and legacy import. It surfaces a **"wrong store path detected"** banner when a wrapped server's `FLIGHTREC_HOME` doesn't match the app's — a common footgun when an old wrap points at a repo `.flightrec`.

## Packaging

`npm run desktop:dist` runs [scripts/pack-runtime.mjs](../scripts/pack-runtime.mjs) → `electron-vite build` → `electron-builder --mac`.

**pack-runtime.mjs** stages `desktop/resources/flightrec-runtime`:
1. `npm run build` (repo `dist/`), then copy `dist/` → the runtime folder.
2. Write a minimal `package.json` (root `dependencies` only) and `npm install --omit=dev` there, so the runtime carries its own `node_modules`.
3. Copy a **real Node binary** into `bin/node` (never Electron — falls back to `which node` if run under Electron).
4. Write `RUNTIME.json` (version/platform/arch marker).

**electron-builder** (`build` block in [desktop/package.json](../desktop/package.json)) bundles `out/**` with `asar: true` and ships the runtime via `extraResources` (`resources/flightrec-runtime` → `Contents/Resources/flightrec-runtime`). The mac target is an **unsigned** `.dmg` (`identity: null`, `hardenedRuntime: false`) — first launch needs right-click → Open to get past Gatekeeper.

## Building & running

```bash
npm run desktop:install   # once — npm install in desktop/
npm run desktop           # build repo dist/ + electron-vite dev (hot reload)
cd desktop && npm start    # production UI build, no Vite, against repo dist/
npm run desktop:dist      # → desktop/release/flightrec-*.dmg
```

Note: `tsc -p desktop/tsconfig.json` reports implicit-`any` on the `dist/*.js` imports because the root build emits no `.d.ts` (`declaration: false`). That's expected — electron-vite/esbuild is the build, and it strips types without a full typecheck. The authoritative build gate is `npm run build --prefix desktop`.
