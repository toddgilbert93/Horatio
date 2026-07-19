# Architecture

How Horatio captures, distills, organizes, and serves Blender MCP memory. For a working-in-the-repo orientation see [../CLAUDE.md](../CLAUDE.md); for the desktop app internals see [desktop.md](desktop.md); for the model rationale see [why-nemotron.md](why-nemotron.md).

## The pipeline

```
Claude ──stdio──> tap ──stdio──> uvx blender-mcp ──tcp──> Blender
                   │ (byte-for-byte forward; logging is a side read)
                   └─append─> raw.jsonl ──tail──> distiller (Nemotron)
                                                    ├── activity → digest.jsonl     (live, incremental)
                                                    └── update   → note.md          (session end / idle / manual)
                                                                + blends/<id>/memory.md
Claude ──stdio──> memory-server ──reads──> memory.md + latest note
                                           (recall / search_sessions / log_decision)
```

Four processes, one store:

- **tap** ([../src/tap.ts](../src/tap.ts)) — a transparent stdio shim around the real MCP server. Forwards bytes untouched; records a parsed copy on the side.
- **distiller** ([../src/distill/](../src/distill/)) — tails `raw.jsonl`, calls Nemotron, writes digests/notes/memory. Auto-spawned per session by the tap; also runnable from the CLI (`watch` / `update` / `rebuild`).
- **memory-server** ([../src/memory-server.ts](../src/memory-server.ts)) — a second MCP server the client connects to, exposing the accumulated memory as tools (`horatio-memory`).
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

Every record is one JSON line: `{ ts, seq, dir, ... }` where `dir ∈ req | res | notif | err | raw | meta`. `seq` is a per-session monotonic counter. **Everything downstream is a pure function of `raw.jsonl`** and can be regenerated with `horatio rebuild`. The single exception is `decisions.jsonl` (authored by agents via `log_decision`), which is itself a source of truth.

## Memory is per Blender file; sessions stay put

A **blend = one `.blend` on disk**. The bucket is `blends/<basename>-<sha256(abspath)[0:8]>/`, so the same file always maps to the same folder and two files with the same basename don't collide. See [../src/lib/blend-link.ts](../src/lib/blend-link.ts).

**Sessions never move.** Linking is a pointer (`link.json`), not a relocate.

```
<home>/
  config.json                           # storeVersion: 2
  live/<session-id>.json                # which taps are currently recording
  sessions/<ISO-id>/                    # flat — never renamed or relocated
    raw.jsonl digest.jsonl note.md distill.log artifacts/
    session.json link.json memory.json
  blends/
    bedroom-3f9a1c2b/                   # one bucket per .blend
      meta.json                         # { id, blendPath:"/abs/bedroom.blend", name:"bedroom.blend" }
      memory.md                         # durable, cross-session file memory
      decisions.jsonl                   # agent-logged decisions (source of truth)
      memory-history/                   # recent memory.md archives
```

### Session lifecycle: record first, attribute later, link once

A session can't know its `.blend` until the traffic reveals it, and recording can't wait. So:

```
tap starts
  └─ new session under sessions/<id>/   (raw.jsonl starts appending)
       │
       ▼   traffic flows; bpy.data.filepath / a *.blend path appears
  detectBlendPathFromRaw(sessionDir)  ──found──►  linkSession()
       │                                             ├─ ensureBlendForPath() → blends/<blend-id>/
       │                                             └─ write link.json { blendId, blendPath, via }
       ▼
  everyone resolves by session id; the session folder never moves
```

- **Detection** ([`detectBlendPathFromRaw`](../src/lib/blend-link.ts)) scans `raw.jsonl` for an explicit `"filepath": "…/x.blend"` first, then any loose absolute/`~` `.blend` path (with boundary rules so Blender append-directories like `/lib.blend/Object/…` don't win).
- **Link** ([`linkSession`](../src/lib/blend-link.ts)) is idempotent. Manual links always win; auto-links don't silently rebind to a different file without explicit evidence.
- **Who triggers link:** the activity follower (on exit / idle update), `horatio update` / rebuild, `recall()` (best-effort so an agent that calls recall first also links things), the desktop projects refresh, and **Link .blend…** (manual).

## Distillation

Two tiers, deliberately split by cost and trigger.

### Activity (Tier 1) — live, incremental ([tier1.ts](../src/distill/tier1.ts))

Tails `raw.jsonl`, groups records into **batches**, and emits one `digest.jsonl` line per record-group: `batch` metadata (the `srcRange` of seq numbers it covers) and `event` records (tool calls, scene changes, errors). Runs continuously while a session is live (auto-spawned by the tap via `horatio watch`) and never calls Nemotron for full file-memory synthesis — it's cheap, ambient summarization.

**Batch boundaries are deterministic** — cut on gaps in *record timestamps*, not wall-clock — so a `rebuild` reproduces exactly the batches a live run made. Catch-up before synthesis closes any gap between the last digest `srcRange` and the last raw `seq` by replaying Tier 1 with no waiting.

### Update memory (Tier 2) — synthesis ([tier2.ts](../src/distill/tier2.ts))

One Nemotron call takes `digest.jsonl` events + current `blends/<id>/memory.md` + `decisions.jsonl` (**never raw** — keeps the call small) and returns `{ note_md, memory_md }`:

- `note.md` — this session's summary/scene-changes/decisions/failures/open-threads (five fixed sections, enforced in code).
- `memory.md` — the merged, durable file memory (object inventory, budgets, naming, known failure modes, decision log).

Triggered by **session end**, **idle**, **Update memory** in the app, or `horatio update` / `rebuild`. `recall()` never synthesizes on demand. Blend resolution is decided **once** from `link.json` before the model call, so the state read and the state written are the same file's. Writes hold `synth.lock` / `memory.lock`; `coveredSeq` is written last so a crash never claims un-merged range.

**No speculation** is a hard rule enforced in the prompts *and* in code: every digest event cites the `seq` numbers supporting it; error strings are verbatim; journaled decisions that the model drops from the Decision log are mechanically re-appended because the journal, not the model, is authoritative.

## Serving memory ([memory-server.ts](../src/memory-server.ts))

A stdio MCP server (`horatio-memory`) the client connects to alongside the wrapped Blender server. Resolution order for which `.blend` to serve:

1. explicit `file` argument (path or name substring)
2. live session’s `link.json`
3. most recently linked blend across sessions

Never an ambient `HORATIO_PROJECT` / config `lastBlendId` — those are UI/install concerns, not recall inputs.

- **`recall()`** — “call this first.” Judgment-first: epistemic banner, decisions / budgets / naming / failure modes / open threads, then session summary; object inventory last under a **historical / may be stale** header. Warns when the `.blend` mtime is newer than the last memory update. Does **not** probe the live Blender scene — agents must re-ground with Blender MCP.
- **`search_sessions(query)`** — case-insensitive substring across every blend’s memory, notes, and digest events, with session/`src=` citations. No embeddings — at a 1M-token context, brute force *is* the retrieval architecture. Capped at `MAX_HITS`.
- **`log_decision(text)`** — appends to the blend’s `decisions.jsonl` (or queues on the live unlinked session until a file is known). Bidirectional memory: the driving agent writes, not just reads.

Readers refuse unmigrated v1 (flightrec) stores with a migrate hint. The tap still records into a v2-shaped session layout even on a v1 home so capture isn’t blocked.

## Portable export ([agent-memory.ts](../src/distill/agent-memory.ts))

`export-memory` produces `agent-memory.md` — a warm-start brief for a *coding* agent (drop next to `CLAUDE.md` / `AGENTS.md`), independent of MCP. It rewrites the session note + file memory into fixed agent-oriented sections with Nemotron (or `--assemble` for a deterministic, no-LLM concat).

## Invariants (recap)

1. `raw.jsonl` is the source of truth; digests/notes/memory are re-derivable (`rebuild`). `decisions.jsonl` is the only other source of truth.
2. The tap forwards byte-for-byte; logging can never affect forwarding; base64 never reaches the log.
3. `node:*` builtins only in `tap.ts`, `store.ts`, `blend-link.ts` (they run on the tap's critical path).
4. Sessions are referenced by **id** and never relocated — linking is a pointer.
5. No speculation in memory: cite seq numbers, verbatim errors, mechanically-preserved decisions.
6. Nemotron calls are strictly serial (≥1600ms spacing; 40 req/min free tier), no fan-out.
7. Memory readers refuse v1 stores; recording never blocks on migration.
