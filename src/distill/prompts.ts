/**
 * The extraction contract. Load-bearing: this file and schema.ts are the
 * system's two interfaces. Non-negotiable rule for both tiers: no speculation.
 * Every claim traceable to an event; errors quoted verbatim; no invented
 * causality. This output is injected into future agents' context —
 * hallucinated memory poisons downstream sessions.
 */
import type { DecisionEntry, DigestEvent, RawRecord } from '../lib/schema.js';

// ---------------------------------------------------------------------------
// Tier 1 — batch extraction
// ---------------------------------------------------------------------------

export const TIER1_SYSTEM = `You convert a batch of raw MCP traffic from a Blender automation session into structured digest events. You are a recorder, not an interpreter.

Hard rules — these are absolute:
1. Every event MUST cite the seq numbers of the records that support it in "src". No event without sources.
2. Error strings are copied character-for-character from the records into error.message. Never paraphrase, never summarize an error message.
3. Never state causality unless the records state it explicitly. A retry succeeding after an error is only "resolved" if a later record visibly addresses that error.
4. If something is unclear, omit it. An incomplete digest is correct; a speculative one is poison.
5. Capture exact parameter values and names verbatim in "params": budgets, counts, object names, dimensions (e.g. {"tri_budget": 15000, "object": "Tree.001"}).

Event types:
- "action": something done. For each execute_blender_code request, one action event whose summary states what the bpy code was FOR (its intent), derived only from the code itself.
- "error": an error observed. message verbatim. Set resolved=true only with explicit evidence, citing resolutionSrc.
- "decision": a commitment made by the driving agent — budgets, naming conventions, approach choices.
- "scene_delta": net scene change across this batch. EXACTLY ONE scene_delta event per batch, listing objects added/removed/modified per the records. If nothing changed, summary is "no scene change".
- "observation": a notable fact from the records that fits none of the above (scene inventory returned by a query, capability info, etc.).

Output: a JSON object {"events": [...]} and nothing else. Each event: {"type": "...", "src": [seq numbers], "summary": "...", "tool": "optional tool name", "error": {optional, see above}, "params": {optional exact values}}.

Every event requires "summary" and non-empty "src". Error details are NESTED under "error", e.g.:
{"type": "error", "src": [12, 15], "summary": "execute failed with KeyError", "tool": "trigger_error", "error": {"message": "KeyError: 'Tree.001'", "resolved": false}}
For the scene_delta event, "src" cites the records you inspected to conclude the delta — when nothing changed, cite the batch's records anyway.`;

export function buildTier1User(batchId: string, records: RawRecord[]): string {
  const first = records[0]?.seq ?? 0;
  const last = records[records.length - 1]?.seq ?? 0;
  const lines = records.map(renderRecord).filter((l) => l !== '');
  return `Batch ${batchId}, records seq ${first}-${last}:\n\n${lines.join('\n')}`;
}

/** Payloads stay complete up to this size; beyond it, head+tail with a marker. */
const PAYLOAD_CAP = 8000;
const HEAD = 4000;
const TAIL = 2000;

function clip(s: string, seq: number): string {
  if (s.length <= PAYLOAD_CAP) return s;
  return (
    s.slice(0, HEAD) +
    `\n[... ${s.length - HEAD - TAIL} chars elided at seq ${seq} — full text in raw.jsonl ...]\n` +
    s.slice(s.length - TAIL)
  );
}

function renderRecord(r: RawRecord): string {
  switch (r.dir) {
    case 'meta':
      return `[${r.seq} meta] ${r.meta?.event ?? ''}`;
    case 'err': {
      const line = (r.payload as { stderr?: string } | undefined)?.stderr ?? '';
      return `[${r.seq} stderr] ${clip(line, r.seq)}`;
    }
    case 'raw':
      return `[${r.seq} unparsed] ${clip(String(typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload)), r.seq)}`;
    case 'req': {
      const label = r.id === null ? 'notification' : 'req';
      const p = r.payload as { arguments?: unknown } | undefined;
      const body = p?.arguments !== undefined ? p.arguments : r.payload;
      const rendered = body === undefined ? '' : ` ${clip(stringify(body), r.seq)}`;
      return `[${r.seq} ${label} ${r.tool ?? r.method ?? ''}]${rendered}`;
    }
    case 'res': {
      const status = r.status ?? 'success';
      return `[${r.seq} res ${r.tool ?? ''} ${status}] ${clip(renderResult(r.payload), r.seq)}`;
    }
  }
}

function renderResult(payload: unknown): string {
  const p = payload as { content?: unknown } | undefined;
  if (p && Array.isArray(p.content)) {
    return p.content
      .map((item: unknown) => {
        const it = item as Record<string, unknown>;
        if (it?.type === 'text') return String(it.text ?? '');
        if (it?.type === 'image_ref') return `(image saved: ${String(it.image_ref)})`;
        return stringify(item);
      })
      .join(' | ');
  }
  return stringify(payload);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — session synthesis (input: digests + project state, never raw)
// ---------------------------------------------------------------------------

export const TIER2_SYSTEM = `You are the session historian for a Blender automation project. Your input is (a) structured digest events from one work session — each already grounded in recorded evidence and tagged with a batch id — and (b) the project's current durable state file. You produce the session note and the updated project state.

Hard rules — these are absolute:
1. Every claim in the note must be supported by the digest events. Cite batch ids in parentheses, e.g. (b0007). Multiple: (b0003, b0007).
2. Error strings pass through verbatim from the events. Never paraphrase an error message.
3. No invented causality, no speculation, no inferred plans. "Open threads" lists only things the events show were attempted but not resolved.
4. The project state is durable memory shared across sessions. Never drop an existing fact unless this session's events directly supersede it — then update it, don't silently delete. Add new durable facts only: object inventory, budgets and constraints, naming conventions, recurring/known failure modes.
5. Reproduce every entry under "## Decision log" exactly as given, then append this session's decision events to it.
6. "## Scene changes" must consolidate EVERY scene_delta event from the digests — one per batch is provided; omit none. The same completeness applies to error events in "## Failures & fixes".
7. Do not derive new numbers. Only restate counts and totals that appear verbatim in an event; never sum or recompute them yourself.

Output: a JSON object with BOTH keys, each non-empty: {"note_md": "...", "project_state_md": "..."} and nothing else.

note_md is the note for THIS session. It must contain ONLY these five section headers, in this order, and nothing else — no project state, no title:
## Summary
## Scene changes
## Decisions
## Failures & fixes
## Open threads

project_state_md is the durable cross-session state file, returned separately and in full. It must use exactly these section headers, in this order (keep a section even when empty):
# Project state
## Object inventory
## Budgets & constraints
## Naming conventions
## Known failure modes
## Decision log`;

export function buildTier2User(args: {
  sessionId: string;
  events: DigestEvent[];
  projectState: string;
  decisions: DecisionEntry[];
}): string {
  const eventLines = args.events.map((e) => {
    const bits = [`(${e.batch}) [${e.type}]`, e.summary];
    if (e.tool) bits.push(`tool=${e.tool}`);
    if (e.error) {
      bits.push(`error="${e.error.message}" resolved=${e.error.resolved}`);
      if (e.error.resolution) bits.push(`resolution: ${e.error.resolution}`);
    }
    if (e.params && Object.keys(e.params).length > 0) bits.push(`params=${JSON.stringify(e.params)}`);
    return `- ${bits.join(' — ')}`;
  });
  const decisionLines =
    args.decisions.length > 0
      ? args.decisions.map((d) => `- ${d.ts} — ${d.text}`).join('\n')
      : '(none)';
  return `Session: ${args.sessionId}

## Digest events (${args.events.length})
${eventLines.join('\n')}

## Current project-state.md
${args.projectState.trim() === '' ? '(empty — first session)' : args.projectState}

## Agent-logged decisions (decisions.jsonl — must all appear in the Decision log)
${decisionLines}`;
}
