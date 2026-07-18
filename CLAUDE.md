# flightrec — Project Brief

A flight recorder for MCP-driven Blender work. Ambient memory layer: capture all BlenderMCP traffic, distill it with NVIDIA Nemotron into persistent project memory, and serve that memory back to agents via a small MCP server so every future session warm-starts instead of cold-starts.

Built for the NVIDIA hackathon **"Best Use of NVIDIA Nemotron" bounty**. The owner is a designer-engineer (React/TypeScript) learning Blender, driving it with Claude via the `ahujasid/blender-mcp` MCP server. Everything here runs on Node/TypeScript.

---

## The bounty (why this project is shaped the way it is)

Criteria: use any Nemotron model; **demonstrate Nemotron's centrality to the project's value**; quality AI output, impact & usefulness, creativity & differentiation; submit a short explanation of what Nemotron is doing, why it matters, and how we're maximizing its capabilities.

Our centrality argument:
1. **Continuous ambient distillation is only economical on a fast, cheap, open model.** Summarizing every session, all session long, is absurd on frontier API pricing and trivial here.
2. **1M context** (Mamba-2 hybrid architecture) enables a one-pass full-transcript synthesis experiment (see Benchmarks).
3. **Open weights** mean the same system can run fully local (Nemotron Nano via Ollama) — always-on, private, zero token cost. Stretch goal.

The submission's spine is the **warm-start benchmark** (below). We prove the value with measurements, not claims.

---

## Core invariant — do not violate

**`raw.jsonl` is the source of truth. Everything downstream is re-derivable from it.**

Digests, session notes, project state — all regenerable by re-running the distiller over raw. Consequences:
- The tap can be dumb. It must never do anything clever.
- Prompt changes are free: re-distill from raw.
- Deferring any downstream work is always safe.

## Architecture

```
Claude Desktop/Code ──stdio──> tap.ts ──stdio──> uvx blender-mcp ──tcp──> Blender addon
                                 │
                                 └──append──> raw.jsonl ──tail── distiller (Tier 1 → digest.jsonl)
                                                                      └── (Tier 2 → note.md + project-state.md)
Claude Desktop/Code ──stdio──> memory-server.ts ──reads──> project-state.md + notes
```

Three processes, three responsibilities:
1. **tap.ts** — transparent stdio wrapper, writes the log. Reliability-critical, dependency-free.
2. **distiller** — separate process tailing the log; Nemotron calls live here.
3. **memory-server.ts** — MCP server exposing recall/search/log_decision.

We never modify blender-mcp. We wrap it.

---

## Component spec

### 1. tap.ts (stdio wrapper)

Registered in Claude Desktop config in place of the raw server:

```json
"blender": {
  "command": "node",
  "args": ["/ABSOLUTE/PATH/flightrec/dist/tap.js", "--", "uvx", "blender-mcp"]
}
```

Same trick in Claude Code's `.mcp.json`.

Rules (all mandatory, all v1):
- Spawn everything after `--`. Pipe stdin→child.stdin and child.stdout→stdout **byte-for-byte**. Forwarding never waits on logging.
- Separately, split streams on newlines and parse each line as JSON-RPC for logging. **A parse failure logs a raw-bytes record and changes nothing else.** Correctness never depends on parsing.
- Capture child stderr too — Python tracebacks land there.
- Pair requests to responses via JSON-RPC `id`. Notifications have no `id`; log them anyway.
- **Screenshots**: `get_viewport_screenshot` results contain base64 images. Write the image to `artifacts/shot-<id>.png`, replace the payload with `{"image_ref": "artifacts/shot-<id>.png", "bytes": N}`. Never let base64 hit the log. v1-mandatory.
- **Session boundary** = lifetime of the child process. New process → new session directory. On child exit / SIGTERM: flush and close the JSONL. Beware EPIPE on stray writes after teardown — guard all writes.
- No MCP SDK dependency in the tap. It is pipes and line splitting.

### 2. Capture format

One `raw.jsonl` per session, one record per message:

```json
{"ts":"2026-07-18T19:41:03Z","dir":"req","id":42,"tool":"execute_blender_code","payload":{"code":"..."},"bytes":1834}
{"ts":"2026-07-18T19:41:05Z","dir":"res","id":42,"status":"success","payload":{"...":"..."},"bytes":912}
```

`dir` ∈ `req | res | err | raw` (raw = unparseable line, stored verbatim). Keep code payloads and scene dumps **complete** — compaction is the distiller's job, not the recorder's. Shared types live in `lib/schema.ts`; tap writes them, distiller reads them.

### 3. Distiller (separate process, one code path for live + replay)

CLI: `flightrec distill --follow <session>` (tail live) and `--replay <session>` (re-derive from offset 0). Same code path — replay is the re-derivability invariant as a command.

**Tier 1 — incremental digests.** Batch trigger: every **10 completed req/res pairs** or **90s of inactivity**, whichever first. One Nemotron call per batch. Output: structured events appended to `digest.jsonl`.

The extraction contract — digests must be **synthesis-sufficient**, because Tier 2 sees only digests (decision, see below):
- actions taken; the *intent* of each code payload (what the bpy code was for)
- **error strings verbatim**, plus their resolutions if seen
- decisions and exact parameter values ("tri budget: 15k", names, counts)
- a scene-delta line per batch
- batch ID + source record IDs on every event, so every downstream claim is traceable to raw

**Tier 2 — session synthesis. Input = `digest.jsonl` + current `project-state.md`. NOT raw.** (Decision: keeps the call at ~10–20k tokens so it runs in seconds — the exit-time attempt can win its race, and the lazy path doesn't stall `recall()`.) Outputs:
- `note.md` with fixed sections: Summary / Scene changes / Decisions / Failures & fixes / Open threads
- a merged update to `project-state.md` (durable facts only: object inventory, budgets, naming conventions, known failure modes)

Trigger: attempt on session end (SIGTERM handler). **Fallback: lazy — if `recall()` finds the latest session has no `note.md`, synthesize right then.** Both paths must exist.

**Prompt rule for both tiers (non-negotiable): no speculation.** Every claim traceable to an event. Errors quoted verbatim. No invented causality. This output is injected into future agents' context — hallucinated memory poisons downstream sessions.

### 4. Store layout

```
$FLIGHTREC_HOME (default ~/.flightrec)/
  projects/<project>/
    project-state.md
    sessions/<ISO-timestamp>/
      raw.jsonl  digest.jsonl  note.md  artifacts/
```

- `FLIGHTREC_HOME` override supported from day one (clean-slate demo runs).
- Everything human-readable markdown on purpose: hand-editable, diffable, renderable later.
- Session data is **never committed** — it contains screenshots and code from real work. One **sanitized** session is checked into `examples/sample-session/` so judges can understand the system without running Blender.

### 5. memory-server.ts (MCP server, official TypeScript SDK)

Three tools:
- `recall()` → returns `project-state.md` + latest `note.md` (lazy-synthesizing it if missing). Tool description must open with **"Call this first when starting work on this project"** — that phrasing is what gets agents to warm-start unprompted.
- `search_sessions(query)` → v1: substring/grep over notes + digests. v1.5 (stretch): stuff matching notes into one Nemotron call, answer with session citations. **No embeddings, no vector store — deliberate.** At 1M context, brute force is the architecture.
- `log_decision(text)` → append a durable fact to project-state from the driving agent. Ten minutes of work, makes memory bidirectional.

---

## Repo structure

```
flightrec/
  src/
    tap.ts
    distill/
      cli.ts  tier1.ts  tier2.ts  prompts.ts
    memory-server.ts
    lib/
      schema.ts  nvidia.ts  store.ts
  bench/
    tasks.md  results/
  examples/
    sample-session/
  README.md
```

`prompts.ts` and `schema.ts` are load-bearing: the extraction contract and the record shape are the system's two interfaces. Keep them as named single files.

---

## Nemotron access

- Endpoint: `https://integrate.api.nvidia.com/v1` (OpenAI-compatible; standard OpenAI SDK with `baseURL` override).
- Auth: `NVIDIA_API_KEY` env var. Never in the repo. `.env` is gitignored.
- Default model: Nemotron 3 Super 120B for both tiers. **Verify the exact model ID string against the build.nvidia.com catalog before hardcoding** — catalog IDs are namespaced and formats vary.
- Smoke test before building anything on top:

```bash
curl https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer $NVIDIA_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"<VERIFIED_MODEL_ID>","messages":[{"role":"user","content":"reply with just: ok"}],"max_tokens":20}'
```

- Rate limits: free tier is **40 requests/minute** and a ~1,000-request credit pool (bump to 5,000 requested). Tier 1 batching (~1 call/min worst case) fits comfortably. Do not add fan-out parallel calls.
- Stretch: Tier 1 on **local Nemotron Nano via Ollama** (always-on / private / zero-cost story), Tier 2 stays on Super via API — routing by stakes.

---

## Benchmarks (the submission's spine — treat as first-class)

1. **Warm-start benchmark.** One real Blender task, run twice from fresh agent sessions: cold (no memory server) vs. warm (`recall()` available). Metrics per run: tool calls to completion, errors hit, redundant scene queries, wall time, violations of established constraints (budgets, naming conventions). Results table goes in `bench/results/` and in the writeup.
2. **Architecture experiment (one-off).** On the biggest recorded session, run Tier 2 the "big" way — full `raw.jsonl` in one pass — and diff its note against the digest-fed note. Validates the digest contract (or exposes its gaps) and produces the 1M-context evidence for the writeup. **Check first that the hosted endpoint accepts very large inputs** — hosted endpoints often cap input below the model's theoretical context.

---

## Build order

1. `tap.ts` + recorder — validated end-to-end against a **real** Blender session (screenshot extraction working) before anything else.
2. Tier 1 distiller (batcher, extraction call, `digest.jsonl`).
3. Tier 2 + `project-state.md` merge, exit-attempt + lazy fallback.
4. `memory-server.ts` (recall + log_decision; grep search).
5. Benchmark runs; capture results.
6. Stretch, in order: local Nano for Tier 1 → search v1.5 → session-timeline UI (reads `digest.jsonl` + `artifacts/`).

## Decisions already made — do not relitigate

- Tier 2 consumes **digests**, not raw (latency + teardown reasoning above). Full-raw is a one-off experiment only.
- **No** rolling/incremental note maintenance inside Tier 1 (bakes in early interpretations, churns tokens, makes Tier 1 stateful).
- **No** mid-session chapter checkpoints unless a session's digest file outgrows a comfortable single call.
- **No** embeddings/vector store.
- **No** modifications to blender-mcp; no NemoClaw/OpenShell.
- Standalone repo; code and data directories separate.

## Known failure modes to design against

- A tap that isn't transparent (blocks, reorders, or dies on parse) — kills the whole project's credibility. Boring is the spec.
- Base64 screenshots reaching the log — bloats everything immediately.
- Distiller inventing causality — poisons future sessions' context. The no-speculation prompt rule exists for this.
- Tier 2 scheduled only at exit — the host process is being torn down; the lazy fallback is not optional.
