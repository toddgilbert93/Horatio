/**
 * Live activity ("tier 1") — incremental digestion. One code path for the live
 * tail (`watch`) and re-derivation (`rebuild`): both consume the same record
 * stream; the only differences are whether we wait for new bytes and whether
 * wall-clock inactivity can trigger a flush.
 *
 * v2 changes (design §5–6):
 *  - Every digest.jsonl writer acquires `distill.lock` for the session; a live
 *    holder makes a second writer refuse.
 *  - On acquire, digest.jsonl is rewritten to its maximal gap-free prefix of
 *    ok batches (contiguous coverage); failed/beyond-gap batches are dropped
 *    and re-digested, so coverage is a true high-water mark with no holes.
 *  - Blend detection runs incrementally over the records already tailed.
 *  - In follow mode, memory auto-updates at session end and after long idle.
 *
 * Determinism: batch boundaries are decided by record-ts gaps wherever a next
 * record exists, so a failure-free replay reproduces the batches a live run
 * made. Failure retries and mid-session manual catch-ups may legitimately
 * differ (documented carve-out).
 *
 * Session dirs never move in v2, so paths are stable — no relocation logic.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { chat, modelId } from '../lib/nvidia.js';
import type { BatchMeta, DigestEvent, DigestRecord, RawRecord } from '../lib/schema.js';
import {
  appendJsonl,
  atomicWrite,
  digestPath,
  pidAlive,
  rawPath,
  readJsonl,
  readMemoryInfo,
  readSessionInfo,
  sessionDirById,
  writeSessionInfo,
} from '../lib/store.js';
import { acquireLock, DISTILL_LOCK, LockHeldError, type LockHandle } from '../lib/locks.js';
import { BlendDetector } from '../lib/blend-link.js';
import { buildTier1User, TIER1_SYSTEM } from './prompts.js';

const PAIRS_PER_BATCH = 10;
const INACTIVITY_MS = 90_000;
const POLL_MS = 500;
const DEAD_TAP_IDLE_MS = 5 * 60_000;
const IDLE_MEMORY_MS = 10 * 60_000; // auto memory update after this much record silence

// ---------------------------------------------------------------------------
// record stream
// ---------------------------------------------------------------------------

export interface IdleTick {
  idleMs: number;
}
export type StreamItem = { record: RawRecord; line: string } | { idle: IdleTick };

/**
 * Yields records from raw.jsonl in order, starting at fromSeq. In follow mode,
 * polls for growth and yields idle ticks while waiting so the consumer can
 * implement wall-clock triggers; ends when shouldStop() says so. In replay mode,
 * reads to EOF and ends. Each record carries its verbatim JSON line for the
 * incremental blend detector.
 */
export async function* recordStream(
  file: string,
  opts: {
    follow: boolean;
    fromSeq: number;
    shouldStop?: (idleMs: number) => boolean;
  }
): AsyncGenerator<StreamItem> {
  let offset = 0;
  let partial = '';
  let idleSince = Date.now();

  while (true) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      if (!opts.follow) return; // no file, nothing to replay
    }
    if (size > offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        const text = partial + buf.toString('utf8');
        const lines = text.split('\n');
        partial = lines.pop() ?? ''; // last element is incomplete (or empty)
        for (const line of lines) {
          if (line.trim() === '') continue;
          let rec: RawRecord;
          try {
            rec = JSON.parse(line) as RawRecord;
          } catch {
            console.error('[horatio watch] skipping unparseable raw.jsonl line');
            continue;
          }
          if (typeof rec.seq !== 'number' || rec.seq < opts.fromSeq) continue;
          idleSince = Date.now();
          yield { record: rec, line };
        }
      } finally {
        fs.closeSync(fd);
      }
      continue; // check for more growth immediately
    }
    if (!opts.follow) return;
    const idleMs = Date.now() - idleSince;
    if (opts.shouldStop?.(idleMs)) return;
    yield { idle: { idleMs } };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---------------------------------------------------------------------------
// Contiguous coverage: rewrite digest.jsonl to its maximal gap-free prefix of
// ok batches (from seq 0). Returns { coveredSeq, keptBatches } so resume can
// continue batch numbering and pick up at coveredSeq + 1.
// ---------------------------------------------------------------------------

export function enforceContiguousDigest(digestFile: string): { coveredSeq: number; keptBatches: number } {
  const records = readJsonl<DigestRecord>(digestFile);
  if (records.length === 0) return { coveredSeq: -1, keptBatches: 0 };

  const metas = records.filter((r): r is BatchMeta => r.kind === 'batch');
  const okByStart = metas
    .filter((m) => m.status === 'ok')
    .sort((a, b) => a.srcRange[0] - b.srcRange[0]);

  // Walk contiguous-from-0, collecting the batch ids that form the prefix.
  const keep = new Set<string>();
  let covered = -1;
  for (const m of okByStart) {
    if (m.srcRange[0] > covered + 1) break; // gap — stop the prefix
    if (m.srcRange[1] > covered) {
      keep.add(m.batch);
      covered = m.srcRange[1];
    }
  }

  // Rewrite to exactly the kept batch metas + their events, in original order.
  const kept: DigestRecord[] = records.filter((r) => keep.has(r.batch));
  if (kept.length !== records.length) {
    const body = kept.map((r) => JSON.stringify(r)).join('\n');
    atomicWrite(digestFile, body === '' ? '' : body + '\n');
  }
  return { coveredSeq: covered, keptBatches: keep.size };
}

// ---------------------------------------------------------------------------
// Tier 1 model call + validation
// ---------------------------------------------------------------------------

// Lenient on the shapes a model plausibly varies (string seqs, missing
// resolved, boolean params) — strict on what matters (sources, verbatim text).
const DigestEventZ = z.object({
  type: z.enum(['action', 'error', 'decision', 'scene_delta', 'observation']),
  src: z.array(z.coerce.number()).min(1),
  summary: z.string().min(1),
  tool: z.string().optional(),
  error: z
    .object({
      message: z.string(),
      resolved: z.boolean().default(false),
      resolution: z.string().optional(),
      resolutionSrc: z.array(z.coerce.number()).optional(),
    })
    .optional(),
  params: z
    .record(
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.union([z.string(), z.number()])),
      ])
    )
    .transform((p) =>
      Object.fromEntries(
        Object.entries(p).map(([k, v]) => [
          k,
          typeof v === 'string' || typeof v === 'number' ? v : Array.isArray(v) ? v.join(', ') : String(v),
        ])
      )
    )
    .optional(),
});

export async function runTier1Batch(
  records: RawRecord[],
  batchId: string,
  trigger: BatchMeta['trigger'],
  digestFile: string
): Promise<boolean> {
  const srcRange: [number, number] = [records[0].seq, records[records.length - 1].seq];
  const ts = records[records.length - 1].ts; // last source ts → replay-deterministic
  const meta: BatchMeta = {
    kind: 'batch',
    batch: batchId,
    srcRange,
    trigger,
    model: modelId(),
    status: 'ok',
    ts,
  };

  try {
    // A dense batch can overflow the output cap (truncated JSON) — escalate once.
    let raw: string;
    try {
      raw = await chat({
        system: TIER1_SYSTEM,
        user: buildTier1User(batchId, records),
        json: true,
        maxTokens: 8192,
      });
    } catch (err) {
      if (!(err as { truncated?: boolean }).truncated) throw err;
      console.error(`[horatio watch] ${batchId}: output truncated, retrying with larger cap`);
      raw = await chat({
        system: TIER1_SYSTEM,
        user: buildTier1User(batchId, records),
        json: true,
        maxTokens: 16384,
      });
    }
    const parsed = JSON.parse(raw) as { events?: unknown[] };
    if (!Array.isArray(parsed.events)) {
      console.error(
        `[horatio watch] ${batchId}: model returned no events array: ${raw.slice(0, 300)}`
      );
    }
    const events: DigestEvent[] = [];
    for (const candidate of parsed.events ?? []) {
      const v = DigestEventZ.safeParse(normalizeCandidate(candidate, srcRange));
      if (!v.success) {
        console.error(
          `[horatio watch] ${batchId}: dropping malformed event: ${v.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')} — ${JSON.stringify(candidate).slice(0, 300)}`
        );
        continue;
      }
      // Traceability guard: sources must exist within this batch.
      const src = v.data.src.filter((s) => s >= srcRange[0] && s <= srcRange[1]);
      if (src.length === 0) {
        console.error(`[horatio watch] ${batchId}: dropping event with out-of-range src`);
        continue;
      }
      events.push({ kind: 'event', batch: batchId, ts, ...v.data, src });
    }
    appendJsonl(digestFile, meta);
    for (const e of events) appendJsonl(digestFile, e);
    console.error(
      `[horatio watch] ${batchId} ok: ${events.length} events from seq ${srcRange[0]}-${srcRange[1]} (${trigger})`
    );
    return true;
  } catch (err) {
    // Never fabricate: record the failure and move on; the range is re-digested
    // on the next pass (it does not advance contiguous coverage).
    appendJsonl(digestFile, { ...meta, status: 'failed' } satisfies BatchMeta);
    console.error(`[horatio watch] ${batchId} FAILED: ${String(err)}`);
    return false;
  }
}

/**
 * Repair the shapes the model predictably gets wrong rather than losing the
 * content: error fields emitted at top level instead of nested, a missing
 * summary on an error event, and an empty src on a "no scene change" delta
 * (an absence has nothing specific to cite — the batch range is the evidence).
 */
function normalizeCandidate(candidate: unknown, srcRange: [number, number]): unknown {
  if (typeof candidate !== 'object' || candidate === null) return candidate;
  const c = { ...(candidate as Record<string, unknown>) };
  if (c.type === 'error' && typeof c.message === 'string' && c.error === undefined) {
    c.error = {
      message: c.message,
      resolved: c.resolved ?? false,
      resolution: c.resolution,
      resolutionSrc: c.resolutionSrc,
    };
  }
  if (typeof c.summary !== 'string' || c.summary === '') {
    const msg = (c.error as { message?: string } | undefined)?.message ?? c.message;
    if (typeof msg === 'string') c.summary = msg;
  }
  if (c.type === 'scene_delta' && Array.isArray(c.src) && c.src.length === 0) {
    c.src = [srcRange[0], srcRange[1]];
  }
  return c;
}

// ---------------------------------------------------------------------------
// the run loop (shared by watch and rebuild)
// ---------------------------------------------------------------------------

export interface Tier1Result {
  sawSessionEnd: boolean;
  endedViaDeadTap: boolean;
  batchesRun: number;
  coveredSeq: number;
}

/**
 * Digest a session's raw.jsonl. Acquires distill.lock for its whole run; a
 * live holder throws LockHeldError (caller decides exit). In follow mode,
 * auto-updates memory at session end and after long idle unless
 * HORATIO_NO_AUTOMEMORY=1.
 */
export async function runTier1(
  sessionDir: string,
  opts: { follow: boolean }
): Promise<Tier1Result> {
  const sessionId = path.basename(sessionDir);
  const dir = fs.existsSync(sessionDir) ? sessionDir : sessionDirById(sessionId);
  const raw = rawPath(dir);
  const digestFile = digestPath(dir);

  let lock: LockHandle;
  try {
    lock = acquireLock(path.join(dir, DISTILL_LOCK));
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(`[horatio watch] ${sessionId}: another distiller holds the lock (pid ${err.holderPid ?? '?'}) — exiting`);
    }
    throw err;
  }

  try {
    return await runTier1Locked(dir, raw, digestFile, opts);
  } finally {
    lock.release();
  }
}

async function runTier1Locked(
  dir: string,
  raw: string,
  digestFile: string,
  opts: { follow: boolean }
): Promise<Tier1Result> {
  // Resume from a clean contiguous coverage baseline.
  const { coveredSeq: startCovered, keptBatches } = enforceContiguousDigest(digestFile);
  let batchCounter = keptBatches;
  const fromSeq = startCovered + 1;

  const detector = new BlendDetector({ id: path.basename(dir), dir });

  let buffer: RawRecord[] = [];
  let pairsDone = 0;
  let tapPid: number | undefined;
  let sawSessionEnd = false;
  let endedViaDeadTap = false;
  let batchesRun = 0;
  let coveredSeq = startCovered;
  let lastMemorySeq = readMemoryCoverage(dir);
  let idleMemoryArmed = true;

  const flush = async (trigger: BatchMeta['trigger']): Promise<void> => {
    if (buffer.length === 0) return;
    const id = `b${String(++batchCounter).padStart(4, '0')}`;
    const records = buffer;
    const lastSeq = records[records.length - 1].seq;
    buffer = [];
    pairsDone = 0;
    const ok = await runTier1Batch(records, id, trigger, digestFile);
    batchesRun++;
    if (ok) coveredSeq = lastSeq; // contiguous because we flush in order
  };

  const shouldStop = (idleMs: number): boolean => {
    if (idleMs < DEAD_TAP_IDLE_MS) return false;
    if (tapPid === undefined) {
      endedViaDeadTap = true;
      return true; // never saw session_start; nothing to wait for
    }
    if (pidAlive(tapPid)) return false; // tap alive — keep waiting
    endedViaDeadTap = true;
    return true; // tap gone and log quiet → treat as ended
  };

  for await (const item of recordStream(raw, { follow: opts.follow, fromSeq, shouldStop })) {
    if ('idle' in item) {
      if (item.idle.idleMs >= INACTIVITY_MS && buffer.length > 0) {
        await flush('inactivity');
      }
      // Idle memory update: after a long quiet stretch, fold what's been
      // digested into durable memory (fires once per quiet stretch).
      if (
        opts.follow &&
        idleMemoryArmed &&
        item.idle.idleMs >= IDLE_MEMORY_MS &&
        buffer.length === 0 &&
        coveredSeq > lastMemorySeq
      ) {
        idleMemoryArmed = false;
        await autoUpdateMemory(dir, 'idle');
        lastMemorySeq = readMemoryCoverage(dir);
      }
      continue;
    }
    const rec = item.record;
    idleMemoryArmed = true; // new traffic re-arms the idle trigger

    // Incremental blend detection over the record's verbatim line.
    try {
      const linked = detector.feed(item.line);
      if (linked) {
        console.error(
          `[horatio watch] ${linked.rebound ? 're-linked' : 'linked'} to ${path.basename(linked.link.blendPath)} (${linked.link.confidence})`
        );
      }
    } catch {
      /* detection must never break digestion */
    }

    if (rec.dir === 'meta') {
      if (rec.meta?.event === 'session_start') tapPid = rec.meta.tapPid;
      if (rec.meta?.event === 'session_end') {
        buffer.push(rec);
        await flush('session_end');
        sawSessionEnd = true;
        break;
      }
      buffer.push(rec);
      continue;
    }

    // Deterministic inactivity boundary: flush BEFORE admitting a record that
    // arrives ≥90s after the previous one (replay sees the same gap).
    const prev = buffer[buffer.length - 1];
    if (prev && Date.parse(rec.ts) - Date.parse(prev.ts) >= INACTIVITY_MS) {
      await flush('inactivity');
    }

    buffer.push(rec);
    if (rec.dir === 'res' && ++pairsDone >= PAIRS_PER_BATCH) {
      await flush('pairs');
    }
  }

  // EOF in replay mode (or follow ended via shouldStop) with records buffered.
  await flush(sawSessionEnd ? 'session_end' : 'inactivity');

  // Dead-tap exit: the tap could not stamp its own end — record it (the sole
  // allowed cross-writer touch of session.json, and only because the tap is
  // gone).
  if (endedViaDeadTap && opts.follow) {
    stampInactivityEnd(dir);
  }

  // Auto memory at session end / dead-tap end (follow only).
  if (opts.follow && (sawSessionEnd || endedViaDeadTap)) {
    await autoUpdateMemory(dir, 'session_end');
  }

  return { sawSessionEnd, endedViaDeadTap, batchesRun, coveredSeq };
}

function readMemoryCoverage(dir: string): number {
  return readMemoryInfo(dir)?.coveredSeq ?? -1;
}

function stampInactivityEnd(dir: string): void {
  try {
    const info = readSessionInfo(dir);
    if (info && !info.endedAt) {
      writeSessionInfo(dir, {
        ...info,
        endedAt: new Date().toISOString(),
        endReason: 'inactivity',
      });
    }
  } catch {
    /* best-effort */
  }
}

/** Run the memory update, isolating its failures from the digestion path. */
async function autoUpdateMemory(dir: string, trigger: 'session_end' | 'idle'): Promise<void> {
  if (process.env.HORATIO_NO_AUTOMEMORY === '1') return;
  try {
    const { updateMemory } = await import('./tier2.js');
    const res = await updateMemory(dir, { trigger });
    if (!res.skipped) {
      console.error(`[horatio watch] memory updated (${trigger})`);
    }
  } catch (err) {
    console.error(`[horatio watch] auto memory update failed (ignored): ${String(err)}`);
  }
}
