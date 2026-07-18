/**
 * Tier 1 — incremental digestion. One code path for live tail (--follow) and
 * re-derivation (--replay): both consume the same record stream; the only
 * differences are whether we wait for new bytes and whether wall-clock
 * inactivity can trigger a flush.
 *
 * Determinism rule: batch boundaries are decided by record-ts gaps wherever a
 * next record exists, so a replay reproduces the same batches a live run made.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import { chat, modelId } from '../lib/nvidia.js';
import type { BatchMeta, DigestEvent, DigestRecord, RawRecord } from '../lib/schema.js';
import { appendJsonl, digestPath, rawPath, readJsonl } from '../lib/store.js';
import { buildTier1User, TIER1_SYSTEM } from './prompts.js';

const PAIRS_PER_BATCH = 10;
const INACTIVITY_MS = 90_000;
const POLL_MS = 500;
const DEAD_TAP_IDLE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// record stream
// ---------------------------------------------------------------------------

export interface IdleTick {
  idleMs: number;
}
export type StreamItem = { record: RawRecord } | { idle: IdleTick };

/**
 * Yields records from raw.jsonl in order, starting at fromSeq.
 * In follow mode, polls for growth and yields idle ticks while waiting so the
 * consumer can implement wall-clock triggers; ends when shouldStop() says so.
 * In replay mode, reads to EOF and ends.
 */
export async function* recordStream(
  file: string,
  opts: { follow: boolean; fromSeq: number; shouldStop?: (idleMs: number) => boolean }
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
            console.error('[flightrec distill] skipping unparseable raw.jsonl line');
            continue;
          }
          if (typeof rec.seq !== 'number' || rec.seq < opts.fromSeq) continue;
          idleSince = Date.now();
          yield { record: rec };
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
): Promise<void> {
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
      console.error(`[flightrec distill] ${batchId}: output truncated, retrying with larger cap`);
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
        `[flightrec distill] ${batchId}: model returned no events array: ${raw.slice(0, 300)}`
      );
    }
    const events: DigestEvent[] = [];
    for (const candidate of parsed.events ?? []) {
      const v = DigestEventZ.safeParse(normalizeCandidate(candidate, srcRange));
      if (!v.success) {
        console.error(
          `[flightrec distill] ${batchId}: dropping malformed event: ${v.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')} — ${JSON.stringify(candidate).slice(0, 300)}`
        );
        continue;
      }
      // Traceability guard: sources must exist within this batch.
      const src = v.data.src.filter((s) => s >= srcRange[0] && s <= srcRange[1]);
      if (src.length === 0) {
        console.error(`[flightrec distill] ${batchId}: dropping event with out-of-range src`);
        continue;
      }
      events.push({ kind: 'event', batch: batchId, ts, ...v.data, src });
    }
    appendJsonl(digestFile, meta);
    for (const e of events) appendJsonl(digestFile, e);
    console.error(
      `[flightrec distill] ${batchId} ok: ${events.length} events from seq ${srcRange[0]}-${srcRange[1]} (${trigger})`
    );
  } catch (err) {
    // Never fabricate: record the failure and move on; --replay retries it.
    appendJsonl(digestFile, { ...meta, status: 'failed' } satisfies BatchMeta);
    console.error(`[flightrec distill] ${batchId} FAILED: ${String(err)}`);
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
// the distiller run loop (shared by --follow and --replay)
// ---------------------------------------------------------------------------

export interface Tier1Result {
  sawSessionEnd: boolean;
  batchesRun: number;
}

export async function runTier1(
  sessionDir: string,
  opts: { follow: boolean }
): Promise<Tier1Result> {
  const raw = rawPath(sessionDir);
  const digestFile = digestPath(sessionDir);

  // Resume support: continue after the last completed batch.
  let batchCounter = 0;
  let fromSeq = 0;
  const existing = readJsonl<DigestRecord>(digestFile);
  const metas = existing.filter((r): r is BatchMeta => r.kind === 'batch');
  if (metas.length > 0) {
    batchCounter = metas.length;
    fromSeq = Math.max(...metas.map((m) => m.srcRange[1])) + 1;
  }

  let buffer: RawRecord[] = [];
  let pairsDone = 0;
  let tapPid: number | undefined;
  let sawSessionEnd = false;
  let batchesRun = 0;

  const flush = async (trigger: BatchMeta['trigger']) => {
    if (buffer.length === 0) return;
    const id = `b${String(++batchCounter).padStart(4, '0')}`;
    const records = buffer;
    buffer = [];
    pairsDone = 0;
    await runTier1Batch(records, id, trigger, digestFile);
    batchesRun++;
  };

  const shouldStop = (idleMs: number): boolean => {
    if (idleMs < DEAD_TAP_IDLE_MS) return false;
    if (tapPid === undefined) return true; // never saw session_start; nothing to wait for
    try {
      process.kill(tapPid, 0);
      return false; // tap alive — keep waiting
    } catch {
      return true; // tap gone and log quiet for 5 min → treat as ended
    }
  };

  for await (const item of recordStream(raw, { follow: opts.follow, fromSeq, shouldStop })) {
    if ('idle' in item) {
      if (item.idle.idleMs >= INACTIVITY_MS && buffer.length > 0) {
        await flush('inactivity');
      }
      continue;
    }
    const rec = item.record;

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
  return { sawSessionEnd, batchesRun };
}
