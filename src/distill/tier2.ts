/**
 * Tier 2 — session synthesis. Input = digest.jsonl + project-state.md +
 * decisions.jsonl. NEVER raw (locked decision: keeps the call small and fast
 * so the exit-time attempt wins its race and lazy recall() doesn't stall).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chat } from '../lib/nvidia.js';
import type { BatchMeta, DigestRecord, DigestEvent, RawRecord } from '../lib/schema.js';
import {
  digestPath,
  notePath,
  rawPath,
  readDecisions,
  readJsonl,
  readProjectState,
  writeProjectState,
} from '../lib/store.js';
import { buildTier2User, TIER2_SYSTEM } from './prompts.js';
import { runTier1 } from './tier1.js';

const NOTE_SECTIONS = [
  '## Summary',
  '## Scene changes',
  '## Decisions',
  '## Failures & fixes',
  '## Open threads',
];

export interface SynthesisResult {
  noteMd: string;
  projectStateMd: string;
}

/**
 * Catch-up: if digest.jsonl is missing or behind raw.jsonl's last seq, run
 * Tier 1 in replay-style (no waiting) to close the gap first.
 */
export async function ensureDistilled(sessionDir: string): Promise<void> {
  const rawRecords = readJsonl<RawRecord>(rawPath(sessionDir));
  if (rawRecords.length === 0) return;
  const lastSeq = rawRecords[rawRecords.length - 1].seq;
  const metas = readJsonl<DigestRecord>(digestPath(sessionDir)).filter(
    (r): r is BatchMeta => r.kind === 'batch'
  );
  const covered = metas.length > 0 ? Math.max(...metas.map((m) => m.srcRange[1])) : -1;
  if (covered < lastSeq) {
    await runTier1(sessionDir, { follow: false });
  }
}

/**
 * One Nemotron call → { note_md, project_state_md }. Writes note.md and the
 * merged project-state.md unless opts.dryRun (used for interim notes on
 * still-live sessions, which must NOT suppress the real end-of-session run).
 */
export async function synthesizeSession(
  sessionDir: string,
  opts: { dryRun?: boolean } = {}
): Promise<SynthesisResult> {
  const sessionId = path.basename(sessionDir);
  const events = readJsonl<DigestRecord>(digestPath(sessionDir)).filter(
    (r): r is DigestEvent => r.kind === 'event'
  );
  const projectState = readProjectState();
  const decisions = readDecisions();

  const user = buildTier2User({ sessionId, events, projectState, decisions });
  let raw: string;
  try {
    raw = await chat({ system: TIER2_SYSTEM, user, json: true, maxTokens: 8192 });
  } catch (err) {
    if (!(err as { truncated?: boolean }).truncated) throw err;
    console.error('[flightrec distill] tier2 output truncated, retrying with larger cap');
    raw = await chat({ system: TIER2_SYSTEM, user, json: true, maxTokens: 16384 });
  }
  const parsed = JSON.parse(raw) as { note_md?: string; project_state_md?: string };

  const noteMd = enforceSections(
    `# Session ${sessionId}\n\n${(parsed.note_md ?? '').trim()}`
  );
  let projectStateMd = (parsed.project_state_md ?? '').trim();
  if (projectStateMd === '') projectStateMd = projectState; // never clobber with nothing
  projectStateMd = enforceDecisionLog(projectStateMd, decisions);

  if (!opts.dryRun) {
    const tmp = notePath(sessionDir) + '.tmp';
    fs.writeFileSync(tmp, noteMd + '\n');
    fs.renameSync(tmp, notePath(sessionDir));
    writeProjectState(projectStateMd + '\n');
  }
  return { noteMd, projectStateMd };
}

/** The five fixed sections are the note's contract; insert any the model missed. */
function enforceSections(note: string): string {
  // The model sometimes appends the project state to the note despite the
  // prompt — it belongs exclusively in project-state.md, so cut it here.
  let out = note;
  for (const marker of ['\n# Project state', '\n## Project state']) {
    const at = out.indexOf(marker);
    if (at !== -1) out = out.slice(0, at).trimEnd();
  }
  for (const header of NOTE_SECTIONS) {
    if (!out.includes(header)) out += `\n\n${header}\n_none recorded_`;
  }
  return out;
}

/**
 * Code safety net for rule 5: every journaled decision must survive the
 * model's rewrite of the Decision log. Missing ones are re-appended
 * mechanically — the journal, not the model, is the source of truth.
 */
function enforceDecisionLog(state: string, decisions: ReturnType<typeof readDecisions>): string {
  if (decisions.length === 0) return state;
  let out = state;
  if (!out.includes('## Decision log')) out += '\n\n## Decision log';
  const missing = decisions.filter((d) => !out.includes(d.text));
  if (missing.length === 0) return out;
  const lines = missing.map((d) => `- ${d.ts} — ${d.text}`).join('\n');
  const at = out.indexOf('## Decision log') + '## Decision log'.length;
  const nextSection = out.indexOf('\n## ', at);
  const insertAt = nextSection === -1 ? out.length : nextSection;
  return out.slice(0, insertAt).replace(/\n*$/, '\n') + lines + out.slice(insertAt);
}
