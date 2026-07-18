# Architecture

How flightrec captures, distills, organizes, and serves Blender MCP memory. For a working-in-the-repo orientation see [../CLAUDE.md](../CLAUDE.md); for the desktop app internals see [desktop.md](desktop.md); for the model rationale see [why-nemotron.md](why-nemotron.md).

## The pipeline

```
Claude ──stdio──> tap ──stdio──> uvx blender-mcp ──tcp──> Blender
                   │ (byte-for-byte forward; logging is a side read)
                   └─append─> raw.jsonl ──tail──> distiller (Nemotron)
                                                    ├── Tier 1 → digest.jsonl        (live, incremental)
                                                    └── Tier 2 → note.md             (manual, "Save state")
                                                              + project-state.md
Claude ──stdio──> memory-server ──reads──> project-state.md + latest note
                                           (recall / search_sessions / log_decision)
```

Four processes, one store:

- **tap** ([../src/tap.ts](../src/tap.ts)) — a transparent stdio shim around the real MCP server. Forwards bytes untouched; records a parsed copy on the side.
- **distiller** ([../src/distill/](../src/distill/)) — tails `raw.jsonl`, calls Nemotron, writes digests/notes/state. Auto-spawned per session by the tap; also runnable from the CLI.
- **memory-server** ([../src/memory-server.ts](../src/memory-server.ts)) — a second MCP server the client connects to, exposing the accumulated memory as tools.
- **desktop app** ([../desktop/](../desktop/)) — viewer + control plane over the same store.

## The transparency contract

The tap must be invisible to the protocol. Two independent paths share the child's streams:

- **Forwarding** is pure piping: `process.stdin.pipe(child.stdin)` and `child.stdout.pipe(process.stdout)`. Nothing in the logging path can delay or block it.
- **Logging** is a separate `data` listener that newline-splits, JSON-parses per line, classifies as request/response/notification, and appends a `RawRecord`. Every failure here is swallowed — a parse error logs a `raw` record, a write error is dropped, and the child keeps talking to the client either way.

Guarantees that follow:

- **Byte-identical forwarding**, verified against un-tapped runs.
- **base64 never hits the log.** Image results are decoded to `artifacts/shot-<id>.png` and the payload is replaced with an `image_ref` before the record is written ([tap.ts `extractImages`](../src/tap.ts)). Artifact writes are async and off the hot path.
- **Request→response attribution.** A `pending` map keyed by `{source}:{id}` remembers each request's tool name so responses (which carry no method) can be labeled. Client and server id-spaces are kept separate; the map is FIFO-evicted with a TTL so it can't grow unbounded.

### raw.jsonl is the source of truth

Every record is one JSON line: `{ ts, seq, dir, ... }` where `dir ∈ req | res | notif | err | raw | meta`. `seq` is a per-session monotonic counter. **Everything downstream is a pure function of `raw.jsonl`** and can be regenerated with `distill --replay`. The single exception is `decisions.jsonl` (authored by agents via `log_decision`), which is itself a source of truth.

## Projects are Blender files

A **project = one `.blend` on disk**. The bucket is `projects/<basename>-<sha256(abspath)[0:8]>/`, so the same file always maps to the same folder and two files with the same basename don't collide. See [../src/lib/blend-project.ts](../src/lib/blend-project.ts).

```
projects/
  _unsaved/                         # holding pen: sessions whose .blend isn't known yet
    meta.json                       # { id:"_unsaved", blendPath:"", name:"Unsaved" }
    sessions/<id>/…
  bedroom-3f9a1c2b/                 # one bucket per .blend
    meta.json                       # { id, blendPath:"/abs/bedroom.blend", name:"bedroom.blend" }
    project-state.md                # durable, cross-session memory for this file
    decisions.jsonl                 # agent-logged decisions (source of truth)
    sessions/<ISO-id>/
      raw.jsonl digest.jsonl note.md distill.log session.json artifacts/ agent-memory.md
```

### Session lifecycle: record first, attribute later, relocate once

A session can't know its `.blend` until the traffic reveals it, and recording can't wait. So:

```
tap starts
  └─ newSessionDir() → projects/_unsaved/sessions/<id>/   (raw.jsonl starts appending)
       │
       ▼   traffic flows; bpy.data.filepath / a *.blend path appears
  detectBlendPathFromRaw(sessionDir)  ──found──►  attachSessionToBlend()
       │                                             ├─ ensureProjectForBlend()  → projects/<blend-id>/
       │                                             ├─ write session.json { blendPath, projectId }
       │                                             └─ fs.renameSync(sessionDir → projects/<blend-id>/sessions/<id>)   ◄── the one move
       ▼
  everyone re-resolves by id (findSessionDirById), so the move strands nobody
```

- **Detection** ([`detectBlendPathFromRaw`](../src/lib/blend-project.ts)) scans `raw.jsonl` for an explicit `"filepath": "…/x.blend"` first, then any loose absolute/`~` `.blend` path.
- **Attach + relocate** ([`attachSessionToBlend`](../src/lib/blend-project.ts)) is idempotent and moves the folder **exactly once** — only when the session isn't already in the right bucket. Returns `{ moved }`.
- **Surviving the move.** The tap caches its session dir but re-locates by **id** via `findSessionDirById` whenever the cached path vanishes ([tap.ts `liveSessionDir`](../src/tap.ts)). The distiller follows by id for the same reason (`distill --follow <id>`). Nothing holds a stale path across the rename.
- **Who triggers attach:** the distiller (on follow-exit, and after `--save`/`--replay`), `recall()` (best-effort, so an agent that calls recall first also links things), the desktop `projects:list` refresh (re-scans every session), and **Link .blend…** (manual, passes an explicit path for unsaved files or paths that never appear in traffic).

## Distillation

Two tiers, deliberately split by cost and trigger.

### Tier 1 — live, incremental ([tier1.ts](../src/distill/tier1.ts))

Tails `raw.jsonl`, groups records into **batches**, and emits one `digest.jsonl` line per record-group: `batch` metadata (the `srcRange` of seq numbers it covers) and `event` records (tool calls, scene changes, errors). Runs continuously while a session is live (auto-spawned by the tap) and never calls Nemotron for synthesis — it's cheap, ambient summarization.

**Batch boundaries are deterministic** — cut on gaps in *record timestamps*, not wall-clock — so a `--replay` reproduces exactly the batches a live run made. `ensureDistilled()` (used before Tier 2) closes any gap between the last digest `srcRange` and the last raw `seq` by replaying Tier 1 with no waiting.

### Tier 2 — synthesis, manual ([tier2.ts](../src/distill/tier2.ts))

One Nemotron call takes `digest.jsonl` events + current `project-state.md` + `decisions.jsonl` (**never raw** — keeps the call small) and returns `{ note_md, project_state_md }`:

- `note.md` — this session's summary/scene-changes/decisions/failures/open-threads (five fixed sections, enforced in code).
- `project-state.md` — the merged, durable memory (object inventory, budgets, naming, known failure modes, decision log).

Triggered only by **Save state** in the app or `distill --save` / `--replay`. `recall()` never synthesizes on demand. Tier 2 derives its target project from the raw traffic (`detectBlendPathFromRaw` → `ensureProjectForBlend`) and re-reads the project id from the attach result before writing, so it always writes to the right bucket even when invoked without `FLIGHTREC_PROJECT`.

**No speculation** is a hard rule enforced in the prompts *and* in code: every digest event cites the `seq` numbers supporting it; error strings are verbatim; journaled decisions that the model drops from the Decision log are mechanically re-appended (`enforceDecisionLog`) because the journal, not the model, is authoritative.

## Serving memory ([memory-server.ts](../src/memory-server.ts))

A stdio MCP server the client connects to alongside the wrapped Blender server. The active project is `FLIGHTREC_PROJECT` if set, else the project owning the newest session across all blends.

- **`recall()`** — "call this first." Returns the blend's `project-state.md` + the latest session's `note.md` (or a note-not-yet-saved hint), plus the linked `.blend` path. Side effect: best-effort `attachSessionToBlend` on the latest session.
- **`search_sessions(query)`** — case-insensitive substring across every project's state, notes, and digest events, with `【session batch src=…】` citations. No embeddings — at a 1M-token context, brute force *is* the retrieval architecture. Capped at `MAX_HITS`.
- **`log_decision(text)`** — appends to `decisions.jsonl` and rewrites the Decision log section of `project-state.md`. Bidirectional memory: the driving agent writes, not just reads.

## Portable export ([agent-memory.ts](../src/distill/agent-memory.ts))

`export-memory` produces `agent-memory.md` — a warm-start brief for a *coding* agent (drop next to `CLAUDE.md` / `AGENTS.md`), independent of MCP. It rewrites the session note + project state into fixed agent-oriented sections with Nemotron (or `--assemble` for a deterministic, no-LLM concat). It derives the owning project from the session's on-disk location, so the CLI and desktop paths agree.

## Invariants (recap)

1. `raw.jsonl` is the source of truth; digests/notes/state are re-derivable (`--replay`). `decisions.jsonl` is the only other source of truth.
2. The tap forwards byte-for-byte; logging can never affect forwarding; base64 never reaches the log.
3. `node:*` builtins only in `tap.ts`, `store.ts`, `blend-project.ts` (they run on the tap's critical path).
4. Sessions are referenced by **id**, never a cached path — they relocate on blend-attach.
5. No speculation in memory: cite seq numbers, verbatim errors, mechanically-preserved decisions.
6. Nemotron calls are strictly serial (≥1600ms spacing; 40 req/min free tier), no fan-out.
