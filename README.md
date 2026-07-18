# flightrec

A flight recorder for MCP-driven Blender work. flightrec sits transparently between your MCP client (Claude Desktop / Claude Code) and [blender-mcp](https://github.com/ahujasid/blender-mcp), records every message, distills the traffic with **NVIDIA Nemotron** into persistent project memory, and serves that memory back to agents over MCP — so every future session warm-starts instead of cold-starts.

```
Claude ──stdio──> tap ──stdio──> uvx blender-mcp ──tcp──> Blender
                   │
                   └──append──> raw.jsonl ──tail── distiller (Nemotron)
                                                      ├── digest.jsonl   (Tier 1: incremental)
                                                      └── note.md + project-state.md (Tier 2)
Claude ──stdio──> memory-server ──reads──> project-state.md + notes
```

**Core invariant:** `raw.jsonl` is the source of truth. Everything downstream is re-derivable (`flightrec distill --replay`).

## Why Nemotron

- **Continuous ambient distillation** (summarizing every session, all session long) is only economical on a fast, cheap, open model — trivial on `nvidia/nemotron-3-super-120b-a12b`, absurd on frontier API pricing.
- Its **1M context** enables one-pass full-transcript synthesis experiments.
- **Open weights** mean the same system can run fully local (Nemotron Nano via Ollama) — always-on, private, zero token cost.

## Setup

```bash
npm install && npm run build
cp .env.example .env   # or create .env with: NVIDIA_API_KEY=nvapi-...
```

Register the tap **in place of** the raw blender server, plus the memory server, in Claude Desktop config (`claude_desktop_config.json`) or Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "blender": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/flightrec/dist/tap.js", "--", "uvx", "blender-mcp"]
    },
    "flightrec-memory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/flightrec/dist/memory-server.js"]
    }
  }
}
```

That's it. The tap auto-spawns the distiller per session (opt out with `FLIGHTREC_NO_AUTODISTILL=1` and run `node dist/distill/cli.js distill --follow latest` in a terminal instead — nicer for demos).

## Commands

```bash
node dist/distill/cli.js distill --follow [session]   # tail a live session
node dist/distill/cli.js distill --replay [session]   # re-derive digest + note from raw
```

`session` = `latest` (default), a session id, or a path.

## Store layout

```
$FLIGHTREC_HOME (default ~/.flightrec)/
  projects/<$FLIGHTREC_PROJECT, default "default">/
    project-state.md        # durable cross-session memory (inventory, budgets, conventions)
    decisions.jsonl         # agent-logged decisions (source of truth for the Decision log)
    sessions/<ISO-timestamp>/
      raw.jsonl             # every MCP message, complete (screenshots → artifacts/)
      digest.jsonl          # Tier 1 structured events, every claim traceable to raw seq ids
      note.md               # Tier 2 session note (Summary / Scene changes / Decisions / Failures & fixes / Open threads)
      distill.log           # distiller diagnostics
      artifacts/            # extracted screenshots
```

## Memory tools (MCP)

- **`recall`** — project state + latest session note (lazily synthesized if missing). Agents are told to call this first.
- **`search_sessions(query)`** — substring search across notes, digest events, and project state, with session/batch citations. No embeddings; at 1M context, brute force is the architecture.
- **`log_decision(text)`** — record a durable decision from the driving agent; memory is bidirectional.

## Guarantees

- The tap is transparent: byte-for-byte forwarding, verified byte-identical against un-tapped runs; logging failures can never affect forwarding; base64 screenshots never reach the log.
- No speculation in distilled memory: every digest event cites the raw-record seq numbers supporting it; error strings are verbatim; hallucinated causality is prompt-forbidden and schema-policed — bad memory poisons future sessions, so incomplete beats invented.
- Batch boundaries are deterministic (record-timestamp gaps, not wall clock): `--replay` reproduces the same batches a live run made.
