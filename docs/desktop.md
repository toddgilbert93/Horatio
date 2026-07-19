# Desktop app

The Electron app ([../desktop/](../desktop/)) is Horatio’s **viewer + control plane**: browse sessions (timeline, notes, file memory, artifacts, raw, distill log), run “Update memory” and agent-memory export, manage the NVIDIA key, and wrap/unwrap MCP servers. It's built with [electron-vite](https://electron-vite.org/) (esbuild under the hood — no `tsc` typecheck gate) and packaged with electron-builder.

For the capture/distill pipeline see [architecture.md](architecture.md).

> **Naming note:** Product-facing strings and store paths use **Horatio**. Some packaged-runtime folder names, IPC bridge names (`window.flightrec`), and the custom protocol (`flightrec-file://`) still carry the older `flightrec` prefix in code — treat those as legacy identifiers until a follow-up rename, not as a second product.

## Structure

```
desktop/
  electron.vite.config.ts      # three build targets: main, preload, renderer
  src/
    main/
      index.ts                 # app bootstrap, windows, menu, custom file protocol
      ipc.ts                   # all ipcMain.handle handlers (the whole backend surface)
      paths.ts                 # runtime resolution (dev dist vs packaged runtime)
    preload/
      index.ts                 # contextBridge → window.flightrec (typed IPC wrappers)
      index.d.ts               # global Window typing
    renderer/
      App.tsx                  # main viewer (blend select + tabbed panes)
      PreferencesApp.tsx       # preferences window (?view=preferences)
      components/              # Timeline, ControlPlane, MarkdownView, Toast
  resources/flightrec-runtime/ # staged runtime for packaging (gitignored, built by pack-runtime)
  release/                     # electron-builder output (.dmg)
```

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`. It has **no Node access** — everything goes through the preload bridge to `ipcMain` handlers in the main process. The main process is where all filesystem and child-process work happens.

## Runtime resolution — the key idea

The app doesn't reimplement capture/distill; it **calls the compiled `dist/`** (the same code the CLI runs). Where that code lives differs between dev and packaged, and [main/paths.ts](../desktop/src/main/paths.ts) is the single source of truth:

| | `runtimeRoot()` | Node binary | why |
|---|---|---|---|
| **Dev** | `<repo>/dist` | `process.execPath` / `which node` | picks up `npm run build` immediately |
| **Packaged** | `<App>.app/Contents/Resources/flightrec-runtime` | bundled `…/bin/node` | self-contained; no repo, no system Node needed |

`loadDist<T>(rel)` dynamically `import()`s a module from the runtime root (e.g. `lib/store.js`, `install.js`, `lib/blend-link.js`). `applyRuntimeEnv()` then exports env vars so any code that *spawns* — the installer writing MCP configs, the distiller subprocess — resolves the **same** runtime (tap path, memory-server path, Node binary).

That's why an MCP config written by the packaged app points at the bundled `bin/node` and the bundled `tap.js`, not the user's PATH.

### `ELECTRON_RUN_AS_NODE`

Every spawn of the distiller (and the `dev`/`start`/`preview` npm scripts) uses `env -u ELECTRON_RUN_AS_NODE`. If that variable is set, Electron launches as a bare Node interpreter and the app never boots. IPC handlers that spawn also delete that env var before spawning the child. If the app mysteriously runs headless, this is the first thing to check.

## IPC surface

All handlers live in [main/ipc.ts](../desktop/src/main/ipc.ts); all wrappers in [preload/index.ts](../desktop/src/preload/index.ts). Grouped:

- **Store/config** — `home:get`, `home:ensure`, `config:get`, `config:set`
- **Blends** — list/refresh (re-scans + links sessions), link `.blend` (native file dialog), reveal/open
- **Sessions** — list, timeline, notes, artifacts, note/digest/raw/distill-log per session, file memory
- **Distill/export** — update memory, rebuild, export agent memory (spawn `dist/distill/cli.js` via the resolved Node)
- **Install/control** — status, wrap, uninstall, repair-store
- **API key** — status/set/clear (writes `<home>/.env`, mode `0600`)
- **Migration** — scan/import (copy legacy/project-local stores in, non-destructively) + v1→v2 migrate
- **Files/watch** — reveal, open-path, copy-path, watch start/stop + `watch:changed` push event

Sidebar `lastBlendId` is UI selection memory only — it must never feed `recall()`.

## Artifacts: custom file protocol

Screenshots live outside the app bundle (in Application Support), which the renderer can't load via `file://` — and Chromium mangles `file://` for paths containing segments like `Users`. So [main/index.ts](../desktop/src/main/index.ts) registers a privileged custom scheme and serves the absolute path from a query param. Artifact URLs in IPC responses use this form.

## Live refresh

`watch:start` sets a recursive `fs.watch` on the store home and pushes `watch:changed` to the renderer, which re-lists blends and reloads the current file’s data. This is how a session recorded in the background (tap + distiller running under an MCP client) shows up in the app without a manual reload. Watchers are torn down on renderer destroy and on `watch:stop`.

## Windows & menu

- **Main window** — `App.tsx`. Blend picker, tabs, **Update memory** / **Export agent memory…**.
- **Preferences window** — opened from the app menu (`Cmd/Ctrl+,`); loads the renderer with `?view=preferences` → `PreferencesApp.tsx` → `ControlPlane`. Manages the data folder, `.blend` linking, the NVIDIA key, MCP client wrapping, store-path repair, and legacy import. It surfaces a **"wrong store path detected"** banner when a wrapped server’s `HORATIO_HOME` (or legacy `FLIGHTREC_HOME`) doesn’t match the app’s — a common footgun when an old wrap points at a repo `.flightrec`.

## Packaging

`npm run desktop:dist` runs [scripts/pack-runtime.mjs](../scripts/pack-runtime.mjs) → `electron-vite build` → `electron-builder --mac`.

**pack-runtime.mjs** stages `desktop/resources/flightrec-runtime`:
1. `npm run build` (repo `dist/`), then copy `dist/` → the runtime folder.
2. Write a minimal `package.json` (root `dependencies` only) and `npm install --omit=dev` there, so the runtime carries its own `node_modules`.
3. Copy a **real Node binary** into `bin/node` (never Electron — falls back to `which node` if run under Electron).
4. Write `RUNTIME.json` (version/platform/arch marker).

**electron-builder** (`build` block in [desktop/package.json](../desktop/package.json)) bundles `out/**` with `asar: true` and ships the runtime via `extraResources`. The mac target is an **unsigned** `.dmg` (`identity: null`, `hardenedRuntime: false`) — first launch needs right-click → Open to get past Gatekeeper.

## Building & running

```bash
npm run desktop:install   # once — npm install in desktop/
npm run desktop           # build repo dist/ + electron-vite dev (hot reload)
cd desktop && npm start    # production UI build, no Vite, against repo dist/
npm run desktop:dist      # → desktop/release/*.dmg
```

Note: `tsc -p desktop/tsconfig.json` reports implicit-`any` on the `dist/*.js` imports because the root build emits no `.d.ts` (`declaration: false`). That's expected — electron-vite/esbuild is the build, and it strips types without a full typecheck. The authoritative build gate is `npm run build --prefix desktop`.
