# Horatio

A flight recorder for MCP-driven Blender work. Horatio sits transparently between your MCP client (Claude Desktop / Claude Code / Cursor) and [blender-mcp](https://github.com/ahujasid/blender-mcp), records every message, distills the traffic with **NVIDIA Nemotron** into persistent per-file memory, and serves that memory back to agents over MCP — so every future session warm-starts instead of cold-starts.

```
Claude ──stdio──> tap ──stdio──> uvx blender-mcp ──tcp──> Blender
                   │
                   └──append──> raw.jsonl ──tail── distiller (Nemotron)
                                                      ├── digest.jsonl   (activity, live)
                                                      └── note.md + blends/<id>/memory.md
Claude ──stdio──> memory-server ──reads──> file memory + notes
                                           (recall / search_sessions / log_decision)
```

**Core invariant:** `raw.jsonl` is the source of truth. Everything downstream is re-derivable (`horatio rebuild`). The only other source of truth is `decisions.jsonl` (agent-authored via `log_decision`).

**Deeper docs:** [architecture & data flow](docs/architecture.md) · [desktop app internals](docs/desktop.md) · [why Nemotron](docs/why-nemotron.md) · [contributor guide (CLAUDE.md)](CLAUDE.md).

## Why Nemotron

- **Continuous ambient distillation** (summarizing every session, all session long) is only economical on a fast, cheap, open model — trivial on `nvidia/nemotron-3-super-120b-a12b`, absurd on frontier API pricing.
- Its **1M context** enables one-pass full-transcript synthesis experiments.
- **Open weights** mean the same system can run fully local (Nemotron Nano via Ollama) — always-on, private, zero token cost.

## Setup

### Desktop app (recommended)

The Electron app is the viewer + control plane: browse sessions (notes, digests, raw, artifacts), manage the NVIDIA API key, wrap/unwrap MCP servers, and fix store paths if a client is writing to the wrong home.

Build a downloadable macOS app (unsigned `.dmg` — right-click → Open the first time):

```bash
npm install && npm run desktop:install
npm run desktop:dist          # → desktop/release/*.dmg
```

Or run from the repo (use a normal terminal, not an environment that sets `ELECTRON_RUN_AS_NODE`):

```bash
npm run desktop:install       # once
npm run desktop               # build + Electron hot reload
# or, after desktop:install:
cd desktop && npm start       # production build of the UI, no Vite
```

**Projects are Blender files**, not arbitrary names. Sessions live in a flat `sessions/` tree and are **linked** (never moved) to a `blends/<id>/` bucket when a `.blend` path shows up in MCP traffic or you click **Link .blend…**. Memory hangs off that file; **Reveal** / **Open** jump to it on disk.

### CLI

```bash
npm install && npm run build
cp .env.example .env   # or create .env with: NVIDIA_API_KEY=nvapi-...
node dist/distill/cli.js install
node dist/distill/cli.js install --wrap blender
node dist/distill/cli.js uninstall
```

`install --wrap` sets `HORATIO_HOME` to the platform app-data folder (`~/Library/Application Support/Horatio` on macOS). Optional `--project-dir <path>` overrides to `<path>/.horatio`. **Restart the MCP client** after install so wraps pick up the new home.

Legacy `FLIGHTREC_*` env vars still resolve (with a deprecation warning). Older flightrec stores need a one-time `horatio migrate`.

`install` finds Claude Code, Claude Desktop, and Cursor configs automatically, wraps the named server with the tap, and registers the memory server alongside. Claude Code uses the official `claude mcp` CLI; Desktop and Cursor get surgical JSON edits with a timestamped backup and atomic writes. Wrapped entries are self-describing, so `uninstall` restores the originals without a state file. Use `--client <claude-code|claude-desktop|cursor>` to target one client, or `--config <path>` for any config with the standard `mcpServers` shape.

<details>
<summary>Manual config (what install writes)</summary>

```json
{
  "mcpServers": {
    "blender": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/Horatio/dist/tap.js", "--", "uvx", "blender-mcp"],
      "env": {
        "HORATIO_HOME": "/Users/you/Library/Application Support/Horatio"
      }
    },
    "horatio-memory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/Horatio/dist/memory-server.js"],
      "env": {
        "HORATIO_HOME": "/Users/you/Library/Application Support/Horatio"
      }
    }
  }
}
```
</details>

The tap auto-spawns the activity follower per session (opt out with `HORATIO_NO_ACTIVITY=1` / legacy `FLIGHTREC_NO_AUTODISTILL=1` and run `node dist/distill/cli.js watch latest` in a terminal instead — nicer for demos).

## Commands

```bash
node dist/distill/cli.js watch [session]              # live activity → digests; auto-update memory at session end
node dist/distill/cli.js update [session]             # session note.md + fold into blends/<id>/memory.md
node dist/distill/cli.js rebuild [session]            # wipe digests, re-derive activity, then update memory
node dist/distill/cli.js export-memory [session] [--out path] [--assemble]
node dist/distill/cli.js migrate [--dry-run]          # one-time flightrec (v1) → Horatio (v2) store
npm run desktop                                       # viewer + control plane
```

Legacy aliases: `distill --follow` → `watch`, `--save` → `update`, `--replay` → `rebuild`.

`update` / “Update memory” in the app folds digests into durable file memory. Live capture mainly writes activity (Tier 1); synthesis runs at session end, on idle, or when you update manually. `recall()` returns existing notes/memory — it does not synthesize on demand.

`export-memory` writes `agent-memory.md` into the session folder (and optionally `--out` to your coding-agent project). It uses Nemotron to produce an agent-oriented brief from the session note + file memory; pass `--assemble` to skip the LLM and concatenate mechanically.

`session` = `latest` (default), a session id, or a path.

## Store layout

Canonical app-owned store (default, v2):

```
~/Library/Application Support/Horatio/   # macOS
~/.config/horatio/                       # Linux
%APPDATA%/Horatio/                       # Windows
  config.json                            # storeVersion: 2
  .env                                   # NVIDIA_API_KEY (optional; also loads repo .env)
  live/<session-id>.json                 # per-tap live pointers
  sessions/<ISO-id>/                     # flat — sessions never move
    raw.jsonl  digest.jsonl  note.md  distill.log  artifacts/
    session.json  link.json  memory.json
    agent-memory.md                      # optional export
  blends/<basename>-<hash8>/             # one folder per Blender file
    meta.json                            # { blendPath, name, … }
    memory.md                            # durable cross-session file memory
    decisions.jsonl
    memory-history/                      # recent memory.md archives
```

Project-local override (`--project-dir` or `HORATIO_HOME=<workspace>/.horatio`):

```
<workspace>/.horatio/
  (same shape as above)
```

If an older wrap still points at a repo `.flightrec` / flightrec app-data path, use **Preferences → Fix store paths** (or `install --repair-store` / `horatio migrate`), then restart the client.

## Memory tools (MCP)

- **`recall`** — judgment-first warm start for the active `.blend` (decisions / constraints / failures / threads first; scene inventory last and marked historical). Warns if the `.blend` file is newer than last memory update. Agents must re-check the live scene with Blender MCP. Resolves from optional `file` arg → live session link → most recently linked file.
- **`search_sessions(query)`** — substring search across notes, digest events, and file memory, with session/batch citations. No embeddings; at 1M context, brute force is the architecture.
- **`log_decision(text)`** — record a durable decision from the driving agent; memory is bidirectional.

## Guarantees

- The tap is transparent: byte-for-byte forwarding, verified byte-identical against un-tapped runs; logging failures can never affect forwarding; base64 screenshots never reach the log.
- No speculation in distilled memory: every digest event cites the raw-record seq numbers supporting it; error strings are verbatim; hallucinated causality is prompt-forbidden and schema-policed — bad memory poisons future sessions, so incomplete beats invented.
- Batch boundaries are deterministic (record-timestamp gaps, not wall clock): `rebuild` reproduces the same batches a live run made.
