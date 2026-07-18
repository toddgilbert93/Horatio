/**
 * Shared record shapes — the system's two interfaces.
 * raw.jsonl records are written by the tap and read by the distiller.
 * digest.jsonl records are written by Tier 1 and read by Tier 2 + search.
 *
 * This module must stay type-only / dependency-free: tap.ts imports from it
 * and the tap must run with an empty node_modules.
 */

export type Dir = 'req' | 'res' | 'err' | 'raw' | 'meta';

export interface SessionMeta {
  event: 'session_start' | 'session_end';
  exitCode?: number | null;
  cmd?: string[];
  tapPid?: number;
}

export interface RawRecord {
  ts: string;
  /** Monotonic per-session index. The traceability key for digest `src` —
   *  JSON-RPC ids don't cover err/raw/notification records. */
  seq: number;
  dir: Dir;
  /** JSON-RPC id. null = notification (method with no id). Absent for err/raw/meta. */
  id?: number | string | null;
  method?: string;
  /** tools/call → params.name; other requests → method. Attributed to responses
   *  via the tap's pending-id map. */
  tool?: string;
  status?: 'success' | 'error';
  /** req: params • res: result|error (base64 images swapped for image_ref) •
   *  err: {stderr} • raw: verbatim unparseable line • meta: absent */
  payload?: unknown;
  /** Original wire-line byte length, before image extraction. */
  bytes: number;
  meta?: SessionMeta;
}

/** Replaces a base64 image content item in the *logged* copy of a response. */
export interface ImageRef {
  type: 'image_ref';
  image_ref: string; // path relative to session dir, e.g. "artifacts/shot-42.png"
  bytes: number;     // decoded image size
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// digest.jsonl
// ---------------------------------------------------------------------------

export type DigestEventType =
  | 'action'      // something done (intent of a code payload, a tool invocation)
  | 'error'       // an error observed — message verbatim
  | 'decision'    // a commitment: budgets, naming, approach choices
  | 'scene_delta' // net scene change for the batch (exactly one per batch)
  | 'observation';// notable fact that fits none of the above

export interface BatchMeta {
  kind: 'batch';
  batch: string;                 // "b0001" — ordinal, reproducible on replay
  srcRange: [number, number];    // inclusive seq range covered
  trigger: 'pairs' | 'inactivity' | 'session_end';
  model: string;
  status: 'ok' | 'failed';       // failed batches are retried by --replay
  ts: string;                    // ts of last source record (replay-deterministic)
}

export interface DigestEvent {
  kind: 'event';
  batch: string;
  type: DigestEventType;
  /** seq numbers of the raw records supporting this claim. Required, non-empty. */
  src: number[];
  ts: string;
  tool?: string;
  summary: string;
  error?: {
    message: string;          // VERBATIM from the wire — never paraphrased
    resolved: boolean;
    resolution?: string;
    resolutionSrc?: number[];
  };
  /** Exact values worth remembering: {"tri_budget": 15000, "object": "Tree.001"} */
  params?: Record<string, string | number>;
}

export type DigestRecord = BatchMeta | DigestEvent;

// ---------------------------------------------------------------------------
// decisions.jsonl (per-blend journal written by log_decision; per-session
// while a session is unlinked — merged into the blend's file on link)
// ---------------------------------------------------------------------------

export interface DecisionEntry {
  ts: string;
  text: string;
  source: 'agent';
}

// ---------------------------------------------------------------------------
// Per-session metadata — three files, one writer class each (design §3).
// Atomic tmp+rename writes; readers merge the three.
// ---------------------------------------------------------------------------

/** sessions/<id>/session.json — written by the TAP only (lifecycle). The one
 *  cross-writer exception: the follower stamps endReason:'inactivity' on the
 *  dead-tap path, when the tap can no longer write anything. */
export interface SessionInfo {
  id: string;
  startedAt: string;
  endedAt?: string;
  endReason?: 'session_end' | 'inactivity';
  tapPid?: number;
  cmd?: string[];
}

/** sessions/<id>/link.json — the session's Blender-file binding.
 *  Manual links always win; auto-detection never overwrites via:'manual' and
 *  may only upgrade its own earlier loose link to an explicit one. */
export interface LinkInfo {
  blendId: string;
  blendPath: string;
  via: 'detected' | 'manual';
  confidence: 'explicit' | 'loose';
  at: string;
}

/** sessions/<id>/memory.json — written only by the memory-update pass.
 *  coveredSeq is a CONTIGUOUS high-water mark: every raw seq 0..coveredSeq is
 *  reflected in note.md/memory.md. No holes behind it, ever. */
export interface MemoryInfo {
  coveredSeq: number;
  updatedAt: string;
  trigger: 'session_end' | 'idle' | 'manual' | 'catchup';
}

/** blends/<blendId>/meta.json. blendPath '' = named legacy group (unlinked). */
export interface BlendMeta {
  id: string;
  blendPath: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** live/<session-id>.json — one per live tap; the tap deletes only its own. */
export interface LivePointer {
  sessionId: string;
  pid: number;
  startedAt: string;
}
