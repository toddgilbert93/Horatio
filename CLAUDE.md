# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repo. Assumes the reader is editing the code, not just using the app.

## What Horatio is

A **flight recorder for MCP-driven Blender work**. It sits transparently between an MCP client (Claude Desktop / Claude Code / Cursor) and [blender-mcp](https://github.com/ahujasid/blender-mcp), records every JSON-RPC message, distills the traffic with **NVIDIA Nemotron** into persistent memory, and serves that memory back to agents over MCP — so future sessions warm-start.

```
Claude ──stdio──> tap ──stdio──> uvx blender-mcp ──tcp──> Blender
                   │
                   └─append─> raw.jsonl ─tail─> distiller (Nemotron)
                                                  ├── digest.jsonl              (activity: live, incremental)
                                                  └── note.md + blends/<id>/memory.md
Claude ──stdio──> memory-server ──reads──> memory.md + notes   (recall / search_sessions / log_decision)
```

## Two things that define the current design

1. **Memory is per Blender file; sessions are flat.** A “blend” = one `.blend` on disk, bucketed at `blends/<basename>-<hash8>/` (hash of the absolute path). Sessions live under `sessions/<ISO-id>/` and are **never moved** — linking writes `link.json` and ensures the blend bucket exists. Everything resolves sessions by **id**. See [src/lib/blend-link.ts](src/lib/blend-link.ts).

2. **The Electron app is the viewer + control plane**, not just a demo. It browses sessions, runs “Update memory” and agent-memory export, manages the NVIDIA key, and wraps/unwraps MCP servers. See [desktop/](desktop/).

## Core invariants — do not break these

- **`raw.jsonl` is the source of truth.** Everything else (`digest.jsonl`, `note.md`, `memory.md`) is re-derivable with `horatio rebuild`. The only artifact that is *not* re-derivable is `decisions.jsonl` (agent-authored via `log_decision`).
- **The tap is byte-transparent.** `process.stdin.pipe(child.stdin)` / `child.stdout.pipe(process.stdout)` is the whole forwarding path; logging is a *separate* read of the same streams and must never be able to block, delay, or crash forwarding. If you touch [src/tap.ts](src/tap.ts), preserve this: logging errors are swallowed, never thrown.
- **base64 never hits the log.** Image payloads are extracted to `artifacts/shot-*.png` and replaced with an `image_ref` before the record is written.
- **No speculation in distilled memory.** Digest events cite the raw-record `seq` numbers that support them; error strings are verbatim; invented causality is prompt-forbidden and schema-policed. Bad memory poisons future sessions — incomplete beats invented.
- **`node:*` builtins only** in [src/tap.ts](src/tap.ts), [src/lib/store.ts](src/lib/store.ts), and [src/lib/blend-link.ts](src/lib/blend-link.ts). These run in the tap's process on the forwarding-critical path; keep them dependency-free.
- **Nemotron calls are strictly serial.** All `chat()` calls funnel through one promise chain with ≥1600ms spacing (40 req/min free tier). No parallel fan-out. See [src/lib/nvidia.ts](src/lib/nvidia.ts).
- **Readers refuse v1 stores.** Call sites that serve memory must go through `ensureV2Home()` / `storeState()`. The tap is the exception: recording must never be blocked (`ensureRecordingHome`).

## Layout

```
src/
  tap.ts                 # transparent stdio wrapper; auto-spawns activity follower by session id
  memory-server.ts       # MCP server: recall / search_sessions / log_decision
  install.ts             # wire tap + memory into client configs (claude mcp CLI / JSON edits)
  lib/
    store.ts             # v2 store layout, session/blend I/O  (node builtins only)
    blend-link.ts        # .blend → blend bucket, detect + link (sessions never move)
    migrate.ts           # one-time flightrec v1 → Horatio v2
    locks.ts             # synth.lock / memory.lock / distill.lock
    nvidia.ts            # Nemotron/OpenAI client, .env loading, serial rate limiter
    schema.ts            # RawRecord / DigestRecord / DecisionEntry / LinkInfo types
  distill/
    cli.ts               # CLI: install | watch | update | rebuild | export-memory | migrate
    tier1.ts             # incremental digests (activity)
    tier2.ts             # synthesis → note.md + blends/<id>/memory.md
    agent-memory.ts      # portable agent-memory.md export
    prompts.ts           # Nemotron system/user prompts + section contracts
desktop/                 # Electron app (electron-vite). Loads compiled dist/ (dev) or bundled runtime (packaged)
  src/main/{index,ipc,paths}.ts
  src/preload/index.ts
  src/renderer/{App,PreferencesApp}.tsx + components/
  resources/flightrec-runtime/   # staged dist + node_modules + bin/node for packaging (gitignored; legacy folder name)
scripts/pack-runtime.mjs # stages the runtime into desktop/resources for electron-builder
docs/
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
node dist/distill/cli.js watch   [session]             # activity (live digests)
node dist/distill/cli.js update  [session]             # note.md + fold into file memory
node dist/distill/cli.js rebuild [session]             # wipe digests, re-derive activity + memory
node dist/distill/cli.js migrate [--dry-run]
node dist/distill/cli.js export-memory [session] [--out <path>] [--assemble]
```

`session` = `latest` (default) · a session id · a path.

Legacy aliases still work: `distill --follow|--save|--replay` → `watch|update|rebuild`.

## Store

Default is the **platform app-data home**, not the repo:

```
~/Library/Application Support/Horatio/   (macOS)   ·   ~/.config/horatio/ (Linux)   ·   %APPDATA%/Horatio/ (Windows)
  config.json   .env
  live/<session-id>.json
  sessions/<ISO-id>/
    raw.jsonl  digest.jsonl  note.md  distill.log  session.json  link.json  memory.json  artifacts/  agent-memory.md
  blends/<basename>-<hash8>/
    meta.json  memory.md  decisions.jsonl  memory-history/
```

Resolution order: `HORATIO_HOME` → deprecated `FLIGHTREC_HOME` → app-data home. Setting `HORATIO_HOME=<workspace>/.horatio` (or `install --project-dir`) switches to a project-local store with the same shape.

## Gotchas when editing

- **Dev vs packaged runtime.** In dev the Electron main loads the repo's `dist/` directly ([desktop/src/main/paths.ts](desktop/src/main/paths.ts)) — so `npm run build` must have run. Packaged builds use a bundled runtime (`resources/flightrec-runtime`, legacy name) with its own `bin/node`. `applyRuntimeEnv()` exports tap/memory/node paths so install and distill spawns hit the same runtime.
- **`ELECTRON_RUN_AS_NODE`** is deliberately unset (`env -u`) when spawning distill/electron — leaving it set turns Electron into a bare Node and breaks the app.
- **Recall never consults `lastBlendId`.** Desktop selection is UI-only. Memory tools resolve from `session` arg → `file` (blend tag) → live tap → newest session.
- **`recall()` does not synthesize.** It only reads what’s on disk. Missing note/memory is fine — activity digests are the baseline.
- **Batch boundaries are deterministic** (record-timestamp gaps, not wall clock), so `rebuild` reproduces the batches a live run made.

## MCP memory tools

- `recall` — session-first warm start (live → latest → optional `session` / `file` filter). Returns recent digest activity, optional note threads, and thin durable decisions for the session’s blend tag. No scene inventory — agents must verify with Blender MCP. Tier-2 note/memory enrich when present; digests alone are enough.
- `search_sessions(query)` — case-insensitive substring across notes, digest events, and blend-tag memory, with session citations. No embeddings — brute force is the architecture at 1M context.
- `log_decision(text)` — append a durable decision on the live/latest session’s blend tag (or queue on the session until linked). Optional `session` / `file`.
