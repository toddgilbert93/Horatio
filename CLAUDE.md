# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repo. Assumes the reader is editing the code, not just using the app.

## What flightrec is

A **flight recorder for MCP-driven Blender work**. It sits transparently between an MCP client (Claude Desktop / Claude Code / Cursor) and [blender-mcp](https://github.com/ahujasid/blender-mcp), records every JSON-RPC message, distills the traffic with **NVIDIA Nemotron** into persistent memory, and serves that memory back to agents over MCP — so future sessions warm-start.

```
Claude ──stdio──> tap ──stdio──> uvx blender-mcp ──tcp──> Blender
                   │
                   └─append─> raw.jsonl ─tail─> distiller (Nemotron)
                                                  ├── digest.jsonl              (Tier 1: live, incremental)
                                                  └── note.md + project-state.md (Tier 2: manual "Save state")
Claude ──stdio──> memory-server ──reads──> project-state.md + notes   (recall / search_sessions / log_decision)
```

## Two things that define the current design

1. **Projects are Blender files, not sessions.** A "project" = one `.blend` on disk, bucketed at `projects/<basename>-<hash8>/` (hash of the absolute path). A session is born under `projects/_unsaved/` and is physically **relocated** into its blend bucket the first time a `.blend` path is detected in the traffic (or linked manually). Everything downstream references a session by **id**, never a cached path, because the folder moves. See `attachSessionToBlend` in [src/lib/blend-project.ts](src/lib/blend-project.ts).

2. **The Electron app is the viewer + control plane**, not just a demo. It browses sessions, runs "Save state" (Tier 2) and agent-memory export, manages the NVIDIA key, and wraps/unwraps MCP servers. See [desktop/](desktop/).

## Core invariants — do not break these

- **`raw.jsonl` is the source of truth.** Everything else (`digest.jsonl`, `note.md`, `project-state.md`) is re-derivable with `distill --replay`. The only artifact that is *not* re-derivable is `decisions.jsonl` (agent-authored via `log_decision`).
- **The tap is byte-transparent.** `process.stdin.pipe(child.stdin)` / `child.stdout.pipe(process.stdout)` is the whole forwarding path; logging is a *separate* read of the same streams and must never be able to block, delay, or crash forwarding. If you touch [src/tap.ts](src/tap.ts), preserve this: logging errors are swallowed, never thrown.
- **base64 never hits the log.** Image payloads are extracted to `artifacts/shot-*.png` and replaced with an `image_ref` before the record is written.
- **No speculation in distilled memory.** Digest events cite the raw-record `seq` numbers that support them; error strings are verbatim; invented causality is prompt-forbidden and schema-policed. Bad memory poisons future sessions — incomplete beats invented.
- **`node:*` builtins only** in [src/tap.ts](src/tap.ts), [src/lib/store.ts](src/lib/store.ts), and [src/lib/blend-project.ts](src/lib/blend-project.ts). These run in the tap's process on the forwarding-critical path; keep them dependency-free.
- **Nemotron calls are strictly serial.** All `chat()` calls funnel through one promise chain with ≥1600ms spacing (40 req/min free tier). No parallel fan-out. See [src/lib/nvidia.ts](src/lib/nvidia.ts).

## Layout

```
src/
  tap.ts                 # transparent stdio wrapper; auto-spawns Tier-1 distiller by session id
  memory-server.ts       # MCP server: recall / search_sessions / log_decision
  install.ts             # wire tap + memory into client configs (claude mcp CLI / JSON edits)
  lib/
    store.ts             # store layout, session resolution, JSONL I/O  (node builtins only)
    blend-project.ts     # .blend → project bucket, detect + attach + relocate  (node builtins only)
    nvidia.ts            # Nemotron/OpenAI client, .env loading, serial rate limiter
    schema.ts            # RawRecord / DigestRecord / DecisionEntry types
  distill/
    cli.ts               # CLI entry: install | distill --follow/--save/--replay | export-memory
    tier1.ts             # incremental digests (live)
    tier2.ts             # synthesis → note.md + project-state.md (manual)
    agent-memory.ts      # portable agent-memory.md export
    prompts.ts           # Nemotron system/user prompts + section contracts
desktop/                 # Electron app (electron-vite). Loads compiled dist/ (dev) or bundled runtime (packaged)
  src/main/{index,ipc,paths}.ts
  src/preload/index.ts
  src/renderer/{App,PreferencesApp}.tsx + components/
  resources/flightrec-runtime/   # staged dist + node_modules + bin/node for packaging (gitignored)
scripts/pack-runtime.mjs # stages the runtime into desktop/resources for electron-builder
docs/why-nemotron.md
```

## Build & run

```bash
npm run build            # tsc → dist/   (run before desktop dev; desktop scripts chain it)
npm run watch            # tsc -w

# Desktop
npm run desktop:install  # once: npm install in desktop/
npm run desktop          # build + electron-vite dev (hot reload)
npm run desktop:dist     # pack runtime + build + electron-builder --mac → desktop/release/*.dmg

# CLI (after build)
node dist/distill/cli.js install [--wrap blender] [--project-dir <path>] [--client <id>|all]
node dist/distill/cli.js install --repair-store        # force all wraps onto app-data home
node dist/distill/cli.js uninstall
node dist/distill/cli.js distill --follow [session]    # Tier 1 (live digests)
node dist/distill/cli.js distill --save   [session]    # Tier 2 (note.md + project-state.md)
node dist/distill/cli.js distill --replay [session]    # wipe digests, re-derive Tier 1 + Tier 2
node dist/distill/cli.js export-memory [session] [--out <path>] [--assemble]
```

`session` = `latest` (default) · a session id · a path.

## Store

Default is the **platform app-data home**, not the repo:

```
~/Library/Application Support/flightrec/   (macOS)   ·   ~/.config/flightrec/ (Linux)   ·   %APPDATA%/flightrec/ (Windows)
  config.json   .env
  projects/_unsaved/                        # sessions before a .blend is known
  projects/<basename>-<hash8>/
    meta.json  project-state.md  decisions.jsonl
    sessions/<ISO-id>/
      raw.jsonl  digest.jsonl  note.md  distill.log  session.json  artifacts/  agent-memory.md
```

Resolution order: `FLIGHTREC_HOME` → app-data home. Setting `FLIGHTREC_HOME=<workspace>/.flightrec` (or `install --project-dir`) switches to a single project-local store where `projectDir()` ignores the project id.

## Gotchas when editing

- **Dev vs packaged runtime.** In dev the Electron main loads the repo's `dist/` directly ([desktop/src/main/paths.ts](desktop/src/main/paths.ts)) — so `npm run build` must have run. Packaged builds use a bundled `flightrec-runtime` with its own `bin/node`. `applyRuntimeEnv()` exports `FLIGHTREC_TAP_PATH` / `FLIGHTREC_MEMORY_PATH` / `FLIGHTREC_NODE` so install and distill spawns hit the same runtime.
- **`ELECTRON_RUN_AS_NODE`** is deliberately unset (`env -u`) when spawning distill/electron — leaving it set turns Electron into a bare Node and breaks the app.
- **Session env in IPC.** Desktop IPC handlers call `setProjectEnv(project)` before store reads so `FLIGHTREC_PROJECT` scopes them. CLI paths that don't set it must derive the project from the session dir (`projectIdFromSessionDir`) rather than trusting `projectName()`.
- **Tier 2 is manual.** `--follow` (and the tap's auto-distiller) run Tier 1 only. `recall()` returns existing notes/state; it does not synthesize on demand.
- **Batch boundaries are deterministic** (record-timestamp gaps, not wall clock), so `--replay` reproduces the batches a live run made.

## MCP memory tools

- `recall` — durable project state + latest session note for the active blend. Agents are told to call this first. Best-effort links the latest session to its `.blend` as a side effect.
- `search_sessions(query)` — case-insensitive substring across notes, digest events, and project state, with session/batch citations. No embeddings — brute force is the architecture at 1M context.
- `log_decision(text)` — append a durable decision (the one non-re-derivable artifact). Memory is bidirectional.
