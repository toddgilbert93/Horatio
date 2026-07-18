# flightrec

A flight recorder for MCP-driven Blender work. flightrec sits transparently between your MCP client (Claude Desktop / Claude Code / Cursor) and [blender-mcp](https://github.com/ahujasid/blender-mcp), records every message, distills the traffic with **NVIDIA Nemotron** into persistent project memory, and serves that memory back to agents over MCP — so every future session warm-starts instead of cold-starts.

```
Claude ──stdio──> tap ──stdio──> uvx blender-mcp ──tcp──> Blender
                   │
                   └──append──> raw.jsonl ──tail── distiller (Nemotron)
                                                      ├── digest.jsonl   (Tier 1: incremental)
                                                      └── note.md + project-state.md (Tier 2)
Claude ──stdio──> memory-server ──reads──> project-state.md + notes
```

**Core invariant:** `raw.jsonl` is the source of truth. Everything downstream is re-derivable (`flightrec distill --replay`).

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
npm run desktop:dist          # → desktop/release/flightrec-*.dmg
```

Or run from the repo (use a normal terminal, not an environment that sets `ELECTRON_RUN_AS_NODE`):

```bash
npm run desktop:install       # once
npm run desktop               # build + Electron hot reload
# or, after desktop:install:
cd desktop && npm start       # production build of the UI, no Vite
```

**Projects are Blender files**, not arbitrary names. New sessions land under **Unsaved** until a `.blend` path shows up in MCP traffic (e.g. `bpy.data.filepath`) or you click **Link .blend…**. Memory then hangs off that file; **Reveal** / **Open** jump to it on disk.

### CLI

```bash
npm install && npm run build
cp .env.example .env   # or create .env with: NVIDIA_API_KEY=nvapi-...
node dist/distill/cli.js install
node dist/distill/cli.js install --wrap blender
node dist/distill/cli.js uninstall
```

`install --wrap` sets `FLIGHTREC_HOME` to the platform app-data folder (`~/Library/Application Support/flightrec` on macOS). Optional `--project-dir <path>` overrides to `<path>/.flightrec`. **Restart the MCP client** after install so wraps pick up the new home.

`install` finds Claude Code, Claude Desktop, and Cursor configs automatically, wraps the named server with the tap, and registers the memory server alongside. Claude Code uses the official `claude mcp` CLI; Desktop and Cursor get surgical JSON edits with a timestamped backup and atomic writes. Wrapped entries are self-describing, so `uninstall` restores the originals without a state file. Use `--client <claude-code|claude-desktop|cursor>` to target one client, or `--config <path>` for any config with the standard `mcpServers` shape.

<details>
<summary>Manual config (what install writes)</summary>

```json
{
  "mcpServers": {
    "blender": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/flightrec/dist/tap.js", "--", "uvx", "blender-mcp"],
      "env": {
        "FLIGHTREC_HOME": "/Users/you/Library/Application Support/flightrec"
      }
    },
    "flightrec-memory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/flightrec/dist/memory-server.js"],
      "env": {
        "FLIGHTREC_HOME": "/Users/you/Library/Application Support/flightrec"
      }
    }
  }
}
```
</details>

The tap auto-spawns the distiller per session (opt out with `FLIGHTREC_NO_AUTODISTILL=1` and run `node dist/distill/cli.js distill --follow latest` in a terminal instead — nicer for demos).

## Commands

```bash
node dist/distill/cli.js distill --follow [session]   # Tier 1 only — live digests
node dist/distill/cli.js distill --save [session]     # Tier 2 — note.md + project-state.md
node dist/distill/cli.js distill --replay [session]   # wipe digests, re-run Tier 1 + Tier 2
node dist/distill/cli.js export-memory [session] [--out path]   # portable agent .md
npm run desktop                                       # viewer + control plane
```

Tier 2 is **manual**: click **Save state** in the desktop app (or `distill --save`). Live capture only runs Tier 1. `recall()` returns existing notes/state; it does not synthesize on demand.

`export-memory` writes `agent-memory.md` into the session folder (and optionally `--out` to your coding-agent project). It uses Nemotron to produce an agent-oriented brief from the session note + project state; pass `--assemble` to skip the LLM and concatenate mechanically. Requires a prior Save state (or `--assemble` without a note).

`session` = `latest` (default), a session id, or a path.

## Store layout

Canonical app-owned store (default):

```
~/Library/Application Support/flightrec/   # macOS
~/.config/flightrec/                       # Linux
%APPDATA%/flightrec/                       # Windows
  config.json
  .env                                     # NVIDIA_API_KEY (optional; also loads repo .env)
  projects/_unsaved/                       # sessions before a .blend is known
  projects/<basename>-<hash8>/             # one folder per Blender file
    meta.json                              # { blendPath, name, … }
    project-state.md
    decisions.jsonl
    sessions/<ISO-timestamp>/
      raw.jsonl  digest.jsonl  note.md  distill.log  artifacts/
      session.json                         # { blendPath, projectId } once attached
      agent-memory.md                      # optional export
```

Project-local override (`--project-dir` or `FLIGHTREC_HOME=<workspace>/.flightrec`):

```
<workspace>/.flightrec/
  project-state.md  decisions.jsonl  sessions/...
```

If an older wrap still points at a repo `.flightrec`, use **Setup → Fix store paths** in the desktop app (or re-run `install --wrap`), then restart the client.

## Memory tools (MCP)

- **`recall`** — project state + latest session note (lazily synthesized if missing). Agents are told to call this first.
- **`search_sessions(query)`** — substring search across notes, digest events, and project state, with session/batch citations. No embeddings; at 1M context, brute force is the architecture.
- **`log_decision(text)`** — record a durable decision from the driving agent; memory is bidirectional.

## Guarantees

- The tap is transparent: byte-for-byte forwarding, verified byte-identical against un-tapped runs; logging failures can never affect forwarding; base64 screenshots never reach the log.
- No speculation in distilled memory: every digest event cites the raw-record seq numbers supporting it; error strings are verbatim; hallucinated causality is prompt-forbidden and schema-policed — bad memory poisons future sessions, so incomplete beats invented.
- Batch boundaries are deterministic (record-timestamp gaps, not wall clock): `--replay` reproduces the same batches a live run made.
