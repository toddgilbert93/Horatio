/**
 * Blender-file linking (design §5). A "blend" is one .blend file on disk,
 * `blends/<id>/` holds its durable memory. Sessions NEVER move — linking a
 * session to a blend is purely `link.json` + ensuring the blend dir exists.
 *
 * Detection runs in the follower (incrementally, over records it already
 * tails) or as a one-shot catch-up scan — never on the tap's forwarding path.
 *
 * Priority: explicit `"filepath": "….blend"` evidence (save/open/probe
 * results) outranks loose path mentions, which can never permanently bind —
 * `/lib.blend/Object/…` append-directories are excluded by a boundary rule.
 * Manual links always win and are never auto-rebound.
 *
 * node:* builtins only — runs next to the tap's process family.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BlendMeta, LinkInfo } from './schema.js';
import {
  blendDir,
  decisionsPathForBlend,
  decisionsPathForSession,
  expandTilde,
  listBlendMetas,
  listSessions,
  mergeDecisionFiles,
  rawPath,
  readBlendMeta,
  readLink,
  writeBlendMeta,
  writeLink,
  type SessionRef,
} from './store.js';

export type LinkConfidence = LinkInfo['confidence'];

export interface DetectedBlend {
  blendPath: string;
  confidence: LinkConfidence;
}

/** Stable id from absolute blend path: `<sanitized-basename>-<hash8>`. */
export function blendIdForPath(blendPath: string): string {
  const abs = path.resolve(expandTilde(blendPath));
  const base = path.basename(abs, path.extname(abs)) || 'blend';
  const safe = base.replace(/[/\\]/g, '-').replace(/[^\w.\- +()[\]]+/g, '-').trim() || 'blend';
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}

/** Create/refresh the blend dir + meta for a saved .blend path. No config writes. */
export function ensureBlendForPath(blendPath: string): BlendMeta {
  const abs = path.resolve(expandTilde(blendPath));
  if (!abs.toLowerCase().endsWith('.blend')) {
    throw new Error(`not a .blend path: ${blendPath}`);
  }
  const id = blendIdForPath(abs);
  const existing = readBlendMeta(id);
  const now = new Date().toISOString();
  const meta: BlendMeta = {
    id,
    blendPath: abs,
    name: path.basename(abs),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  // Refresh meta only when something actually changed — read paths that call
  // through here indirectly must never cause watch churn.
  if (!existing || existing.blendPath !== abs || existing.name !== meta.name) {
    writeBlendMeta(meta);
  }
  return existing && existing.blendPath === abs && existing.name === meta.name
    ? existing
    : meta;
}

/** A named group with no backing .blend (legacy buckets, _recovered). */
export function ensureNamedBlendGroup(id: string, name?: string): BlendMeta {
  const existing = readBlendMeta(id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const meta: BlendMeta = { id, blendPath: '', name: name ?? id, createdAt: now, updatedAt: now };
  writeBlendMeta(meta);
  return meta;
}

export interface LinkResult {
  link: LinkInfo;
  changed: boolean;
  rebound: boolean;
}

/**
 * Apply the §5 linking rules for a session.
 * - manual always wins (and may re-link)
 * - auto explicit beats auto loose (one-time upgrade, reported as rebound)
 * - auto never overwrites manual; a second explicit never rebinds the first
 * On a new/changed link, session-scoped decisions merge into the blend's file.
 */
export function linkSession(
  session: SessionRef,
  blendPath: string,
  via: LinkInfo['via'],
  confidence: LinkConfidence
): LinkResult {
  const existing = readLink(session.dir);
  const abs = path.resolve(expandTilde(blendPath));
  const id = blendIdForPath(abs);

  if (existing) {
    const same = existing.blendId === id;
    if (via === 'detected') {
      if (existing.via === 'manual') return { link: existing, changed: false, rebound: false };
      if (same) {
        // Same file — upgrade recorded confidence if we now have explicit evidence.
        if (existing.confidence === 'loose' && confidence === 'explicit') {
          const upgraded: LinkInfo = { ...existing, confidence: 'explicit', at: new Date().toISOString() };
          writeLink(session.dir, upgraded);
          return { link: upgraded, changed: true, rebound: false };
        }
        return { link: existing, changed: false, rebound: false };
      }
      // Different file: only explicit evidence may rebind a loose link.
      if (!(existing.confidence === 'loose' && confidence === 'explicit')) {
        return { link: existing, changed: false, rebound: false };
      }
    }
    // manual re-link, or explicit-over-loose rebind: fall through and write.
  }

  const meta = ensureBlendForPath(abs);
  const link: LinkInfo = {
    blendId: meta.id,
    blendPath: abs,
    via,
    confidence: via === 'manual' ? 'explicit' : confidence,
    at: new Date().toISOString(),
  };
  writeLink(session.dir, link);
  mergeDecisionFiles(decisionsPathForSession(session.dir), decisionsPathForBlend(meta.id));
  try {
    if (fs.existsSync(decisionsPathForSession(session.dir))) {
      fs.unlinkSync(decisionsPathForSession(session.dir));
    }
  } catch {
    /* merged already; a leftover file is re-merged on the next link write */
  }
  return { link, changed: true, rebound: Boolean(existing && existing.blendId !== link.blendId) };
}

/** Manual link used by UI/CLI. */
export function linkSessionManually(session: SessionRef, blendPath: string): LinkResult {
  return linkSession(session, blendPath, 'manual', 'explicit');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Explicit: a filepath key whose value ends in .blend — matched at any JSON
// escape depth by flattening escapes first.
const EXPLICIT_RE = /"filepath"\s*:\s*"([^"]+?\.blend)"/gi;
// Loose: absolute or ~/ or drive-letter path token ending in .blend followed
// by a boundary (quote/space/EOL — NOT '/' — so append-directories like
// `/lib.blend/Object/Tree` never match).
const LOOSE_RE = /(?:^|[\s"'=(,])((?:\/|~\/|[A-Za-z]:[\\/])[^\s"'<>,)]+\.blend)(?=$|["'\s<>,)]|\\n|\\")/gm;

/** Flatten up to two levels of JSON string escaping so nested payloads match. */
function flattenEscapes(text: string): string {
  let out = text;
  for (let i = 0; i < 2 && out.includes('\\"'); i++) {
    out = out.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  }
  return out;
}

function looksLikeBlendPath(p: string): boolean {
  const n = p.trim();
  if (!n.toLowerCase().endsWith('.blend')) return false;
  if (n.includes('..')) return false;
  return n.startsWith('/') || n.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(n);
}

/**
 * Scan one chunk of record text for blend-path evidence.
 * Returns the best evidence in the chunk: first explicit hit, else first loose.
 */
export function detectInText(text: string): DetectedBlend | undefined {
  const flat = flattenEscapes(text);
  EXPLICIT_RE.lastIndex = 0;
  for (let m = EXPLICIT_RE.exec(flat); m !== null; m = EXPLICIT_RE.exec(flat)) {
    const p = m[1];
    if (looksLikeBlendPath(p)) {
      return { blendPath: path.resolve(expandTilde(p)), confidence: 'explicit' };
    }
  }
  LOOSE_RE.lastIndex = 0;
  for (let m = LOOSE_RE.exec(flat); m !== null; m = LOOSE_RE.exec(flat)) {
    const p = m[1];
    if (looksLikeBlendPath(p)) {
      return { blendPath: path.resolve(expandTilde(p)), confidence: 'loose' };
    }
  }
  return undefined;
}

/**
 * Incremental detector for the follower: feed each raw record's JSON line as
 * it is read; `apply` links as soon as evidence allows and stops once the
 * session is explicitly bound. Cheap: only new records are ever scanned.
 */
export class BlendDetector {
  private done = false;

  constructor(private session: SessionRef) {
    const existing = readLink(session.dir);
    if (existing && (existing.via === 'manual' || existing.confidence === 'explicit')) {
      this.done = true;
    }
  }

  /** Returns a LinkResult when this record changed the link. */
  feed(recordLine: string): LinkResult | undefined {
    if (this.done) return undefined;
    const hit = detectInText(recordLine);
    if (!hit) return undefined;
    const res = linkSession(this.session, hit.blendPath, 'detected', hit.confidence);
    const now = readLink(this.session.dir);
    if (now && (now.via === 'manual' || now.confidence === 'explicit')) this.done = true;
    return res.changed ? res : undefined;
  }
}

/** One-shot catch-up scan over the whole raw log (update on unlinked sessions). */
export function detectBlendPathFromRaw(sessionDir: string): DetectedBlend | undefined {
  const raw = rawPath(sessionDir);
  if (!fs.existsSync(raw)) return undefined;
  let explicit: DetectedBlend | undefined;
  let loose: DetectedBlend | undefined;
  const text = fs.readFileSync(raw, 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const hit = detectInText(line);
    if (!hit) continue;
    if (hit.confidence === 'explicit') {
      explicit ??= hit; // FIRST explicit hit wins
      break;
    }
    loose ??= hit;
  }
  return explicit ?? loose;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface BlendInfo extends BlendMeta {
  dir: string;
  sessionCount: number;
  blendExists: boolean;
}

export interface SessionListing extends SessionRef {
  blendId?: string;
}

/** All sessions with their link (single flat scan, read-only). */
export function listSessionsWithLinks(): SessionListing[] {
  return listSessions().map((s) => ({ ...s, blendId: readLink(s.dir)?.blendId }));
}

/** All blend groups with session counts. Read-only — writes nothing (§5). */
export function listBlendInfos(): BlendInfo[] {
  const counts = new Map<string, number>();
  for (const s of listSessionsWithLinks()) {
    if (s.blendId) counts.set(s.blendId, (counts.get(s.blendId) ?? 0) + 1);
  }
  const metas = listBlendMetas();
  const known = new Set(metas.map((m) => m.id));
  // Sessions may reference a blend whose dir vanished — surface it anyway.
  for (const [id] of counts) {
    if (!known.has(id)) {
      metas.push({ id, blendPath: '', name: id, createdAt: '', updatedAt: '' });
    }
  }
  return metas
    .map((m) => ({
      ...m,
      dir: blendDir(m.id),
      sessionCount: counts.get(m.id) ?? 0,
      blendExists: Boolean(m.blendPath && fs.existsSync(m.blendPath)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
