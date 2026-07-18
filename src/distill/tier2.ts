/**
 * Update memory ("tier 2") — session synthesis. Input = activity events (the
 * contiguous ok prefix of digest.jsonl) + the linked Blender file's memory.md +
 * decisions. NEVER raw content (raw is only scanned to detect the .blend path).
 *
 * One code path (`updateMemory`) serves every trigger: session end and idle
 * (from the follower, design §6), manual (`horatio update` / desktop button),
 * and catch-up. Blend resolution is decided ONCE, before the model call, from
 * link.json only — the state read and the state written are the same file's.
 *
 * Concurrency (design §6/§7):
 *  - the whole pass holds the session's synth.lock
 *  - the memory.md read→archive→write holds the blend's memory.lock, with a
 *    staleness re-check that re-merges once if another writer moved it
 *  - coveredSeq is written LAST, so a cancel/crash never claims un-merged range
 */
import * as path from 'node:path';
import { chat } from '../lib/nvidia.js';
import type { DigestEvent, DigestRecord } from '../lib/schema.js';
import { detectBlendPathFromRaw, linkSession } from '../lib/blend-link.js';
import {
  atomicWrite,
  blendDir,
  contiguousOkCoverage,
  digestPath,
  notePath,
  rawPath,
  readBlendMemory,
  readDecisions,
  readJsonl,
  readLink,
  writeBlendMemory,
  writeMemoryInfo,
} from '../lib/store.js';
import {
  acquireLockWait,
  DISTILL_LOCK,
  lockHeldByLiveProcess,
  MEMORY_LOCK,
  SYNTH_LOCK,
} from '../lib/locks.js';
import { buildTier2User, TIER2_SYSTEM } from './prompts.js';
import { runTier1 } from './tier1.js';

const NOTE_SECTIONS = [
  '## Summary',
  '## Scene changes',
  '## Decisions',
  '## Failures & fixes',
  '## Open threads',
];

// Headers that belong ONLY to file memory — their first appearance marks where
// a merged model has spilled memory content into the note.
const MEMORY_ONLY_HEADERS = [
  '## Object inventory',
  '## Budgets & constraints',
  '## Naming conventions',
  '## Known failure modes',
];

export type UpdateTrigger = 'session_end' | 'idle' | 'manual' | 'catchup';

export interface UpdateResult {
  skipped: boolean;
  reason?: string;
  blendId?: string;
  sessionScoped?: boolean;
  coveredSeq?: number;
  noteMd?: string;
  memoryMd?: string;
}

/**
 * Fold a session's activity into its summary and (when linked) its Blender
 * file's durable memory. Idempotent, lock-guarded, cancel-safe.
 */
export async function updateMemory(
  sessionDir: string,
  opts: { trigger: UpdateTrigger; dryRun?: boolean } = { trigger: 'manual' }
): Promise<UpdateResult> {
  const synth = await acquireLockWait(path.join(sessionDir, SYNTH_LOCK), 60_000);
  try {
    // Catch up activity first ONLY when no live follower owns the digest; a live
    // follower keeps the digest at most one batch behind, so we synthesize from
    // its current contiguous coverage instead of racing it.
    if (!lockHeldByLiveProcess(path.join(sessionDir, DISTILL_LOCK))) {
      await runTier1(sessionDir, { follow: false });
    }
    return await synthesize(sessionDir, opts);
  } finally {
    synth.release();
  }
}

async function synthesize(
  sessionDir: string,
  opts: { trigger: UpdateTrigger; dryRun?: boolean }
): Promise<UpdateResult> {
  const sessionId = path.basename(sessionDir);
  const digest = digestPath(sessionDir);
  const inputSeq = contiguousOkCoverage(digest);
  const events = readJsonl<DigestRecord>(digest).filter(
    (r): r is DigestEvent => r.kind === 'event' && r.src.every((s) => s <= inputSeq)
  );

  if (events.length === 0) {
    return { skipped: true, reason: 'nothing new to remember', coveredSeq: Math.max(inputSeq, 0) };
  }

  // Resolve the Blender file from link.json only; if unlinked, try a one-shot
  // detection over raw before giving up to a session-scoped summary.
  let link = readLink(sessionDir);
  if (!link) {
    const detected = detectBlendPathFromRaw(sessionDir);
    if (detected) {
      const res = linkSession({ id: sessionId, dir: sessionDir }, detected.blendPath, 'detected', detected.confidence);
      link = res.link;
    }
  }
  const sessionScoped = !link;

  const fileMemory = link ? readBlendMemory(link.blendId) : '';
  const decisions = link ? readDecisions(link.blendId) : [];

  const { noteMd, memoryMd } = await callModel(sessionId, events, fileMemory, decisions);

  if (opts.dryRun) {
    return { skipped: false, blendId: link?.blendId, sessionScoped, coveredSeq: inputSeq, noteMd, memoryMd };
  }

  // 1. Session summary — always.
  atomicWrite(notePath(sessionDir), noteMd + '\n');

  // 2. File memory — only when linked, under the blend's memory.lock with a
  //    staleness re-merge, then archive-and-write.
  if (link) {
    const memLock = await acquireLockWait(path.join(blendDir(link.blendId), MEMORY_LOCK), 30_000);
    try {
      const current = readBlendMemory(link.blendId);
      let finalMemory = memoryMd;
      if (current !== fileMemory) {
        // Another writer moved memory.md while we were in the model call — merge
        // once more against the fresh state so we don't clobber their facts.
        const remerged = await callModel(sessionId, events, current, readDecisions(link.blendId));
        finalMemory = remerged.memoryMd;
      }
      finalMemory = enforceDecisionLog(finalMemory, readDecisions(link.blendId));
      writeBlendMemory(link.blendId, finalMemory + '\n');
    } finally {
      memLock.release();
    }
  }

  // 3. Coverage marker LAST — never claims more than was merged above.
  writeMemoryInfo(sessionDir, {
    coveredSeq: inputSeq,
    updatedAt: new Date().toISOString(),
    trigger: opts.trigger,
  });

  return { skipped: false, blendId: link?.blendId, sessionScoped, coveredSeq: inputSeq, noteMd, memoryMd };
}

async function callModel(
  sessionId: string,
  events: DigestEvent[],
  fileMemory: string,
  decisions: ReturnType<typeof readDecisions>
): Promise<{ noteMd: string; memoryMd: string }> {
  const user = buildTier2User({ sessionId, events, fileMemory, decisions });
  let raw: string;
  try {
    raw = await chat({ system: TIER2_SYSTEM, user, json: true, maxTokens: 8192 });
  } catch (err) {
    if (!(err as { truncated?: boolean }).truncated) throw err;
    console.error('[horatio update] output truncated, retrying with larger cap');
    raw = await chat({ system: TIER2_SYSTEM, user, json: true, maxTokens: 16384 });
  }
  const parsed = JSON.parse(raw) as { note_md?: string; memory_md?: string };
  let noteRaw = (parsed.note_md ?? '').trim();
  let memoryRaw = (parsed.memory_md ?? '').trim();

  // Robustness: smaller models sometimes dump the file memory INTO note_md
  // (labeled "memory_md:", under a "# File memory" heading, or just as the raw
  // memory sections) instead of returning it as its own JSON key. Recover it
  // from the note's tail so the memory isn't lost.
  if (memoryRaw === '') {
    const boundary = memoryBoundary(noteRaw);
    if (boundary !== -1) {
      memoryRaw = noteRaw
        .slice(boundary)
        .replace(/^\s*\n?\s*memory_md\s*:\s*/i, '')
        .replace(/^\s*#\s*File memory\s*\n/i, '')
        .trim();
      noteRaw = noteRaw.slice(0, boundary).trim();
    }
  }

  const noteMd = enforceSections(`# Session ${sessionId}\n\n${noteRaw}`);
  let memoryMd = enforceMemory(memoryRaw);
  if (memoryMd === '') memoryMd = fileMemory; // never clobber with nothing
  return { noteMd, memoryMd };
}

/** Give file memory its heading and strip trailing JSON debris from a merged model. */
function enforceMemory(memory: string): string {
  let out = memory.trim();
  if (out === '') return out;
  // A merged/truncated model can leave a run of JSON closers on the last line.
  out = out.replace(/\s*[}\]]+\s*$/g, '').trimEnd();
  if (!/^#\s*File memory/i.test(out)) out = `# File memory\n\n${out}`;
  return out;
}

/** First index where memory content has spilled into the note text, or -1. */
function memoryBoundary(text: string): number {
  let earliest = -1;
  const patterns = [
    /\n\s*(?:memory_md\s*:\s*)?#\s*File memory/i,
    /\n\s*#\s*Project state/i,
    ...MEMORY_ONLY_HEADERS.map((h) => new RegExp(`\\n\\s*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')),
  ];
  for (const re of patterns) {
    const m = text.search(re);
    if (m !== -1 && (earliest === -1 || m < earliest)) earliest = m;
  }
  return earliest;
}

/**
 * The summary's contract is exactly the five fixed sections. Reconstruct the
 * note from ONLY those sections (in order) so any merged-in file-memory content
 * — headings the model spilled past "Open threads" — is dropped entirely.
 */
function enforceSections(note: string): string {
  const titleMatch = note.match(/^#\s+Session[^\n]*/);
  const title = titleMatch ? titleMatch[0] : '# Session';

  const bodyOf = (header: string): string => {
    const idx = note.indexOf(header);
    if (idx === -1) return '_none recorded_';
    const start = idx + header.length;
    // Section ends at the next '## ' header of any kind.
    const next = note.indexOf('\n## ', start);
    const body = (next === -1 ? note.slice(start) : note.slice(start, next)).trim();
    return body === '' ? '_none recorded_' : body;
  };

  const parts = [title, ...NOTE_SECTIONS.map((h) => `${h}\n${bodyOf(h)}`)];
  return parts.join('\n\n');
}

/**
 * Every journaled decision must survive the model's rewrite of the Decision
 * log — missing ones are re-appended mechanically. The journal, not the model,
 * is the source of truth for decisions.
 */
function enforceDecisionLog(memory: string, decisions: ReturnType<typeof readDecisions>): string {
  if (decisions.length === 0) return memory;
  let out = memory;
  if (!out.includes('## Decision log')) out += '\n\n## Decision log';
  const missing = decisions.filter((d) => !out.includes(d.text));
  if (missing.length === 0) return out;
  const lines = missing.map((d) => `- ${d.ts} — ${d.text}`).join('\n');
  const at = out.indexOf('## Decision log') + '## Decision log'.length;
  const nextSection = out.indexOf('\n## ', at);
  const insertAt = nextSection === -1 ? out.length : nextSection;
  return out.slice(0, insertAt).replace(/\n*$/, '\n') + lines + out.slice(insertAt);
}

/**
 * Ensure a session's activity is digested up to the current raw EOF (used by
 * agent-memory export). No-op when a live follower already owns the digest.
 */
export async function ensureDistilled(sessionDir: string): Promise<void> {
  if (lockHeldByLiveProcess(path.join(sessionDir, DISTILL_LOCK))) return;
  const raw = readJsonl<{ seq: number }>(rawPath(sessionDir));
  if (raw.length === 0) return;
  const lastSeq = raw[raw.length - 1].seq;
  if (contiguousOkCoverage(digestPath(sessionDir)) < lastSeq) {
    await runTier1(sessionDir, { follow: false });
  }
}
