/**
 * Store layout + JSONL I/O. node:* builtins only — tap.ts depends on this.
 *
 * v2 layout (sessions-first; session dirs are NEVER moved or renamed):
 *   <home>/
 *     config.json  .env
 *     live/<session-id>.json      # per-tap live pointers
 *     nemotron-last-call          # cross-process rate spacing
 *     sessions/<ISO-id>/          # flat
 *       session.json link.json memory.json
 *       raw.jsonl digest.jsonl note.md distill.log agent-memory.md artifacts/
 *     blends/<blendId>/
 *       meta.json memory.md memory-history/ decisions.jsonl
 *
 * Home resolution: HORATIO_HOME → FLIGHTREC_HOME (deprecated, warned once)
 * → platform app-data dir (Application Support/Horatio · %APPDATA%/Horatio
 * · $XDG_CONFIG_HOME/horatio). A workspace `.horatio` (or legacy `.flightrec`)
 * home has the SAME shape — project-local mode differs only in location.
 *
 * v1 stores (a `projects/` tree, or flat root project-state.md) are refused by
 * readers with a migration hint. The tap is the exception: recording must
 * never be blocked, so it appends v2-shaped sessions regardless and migration
 * unifies later.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BatchMeta,
  BlendMeta,
  DecisionEntry,
  DigestRecord,
  LivePointer,
  MemoryInfo,
  LinkInfo,
  SessionInfo,
} from './schema.js';

export const RAW_FILE = 'raw.jsonl';
export const DIGEST_FILE = 'digest.jsonl';
export const NOTE_FILE = 'note.md';
export const AGENT_MEMORY_FILE = 'agent-memory.md';
export const ARTIFACTS_DIR = 'artifacts';
export const DISTILL_LOG = 'distill.log';
export const SESSION_FILE = 'session.json';
export const LINK_FILE = 'link.json';
export const MEMORY_FILE = 'memory.json';
export const MEMORY_MD = 'memory.md';
export const MEMORY_HISTORY_DIR = 'memory-history';
export const MEMORY_HISTORY_KEEP = 10;
export const BLEND_META_FILE = 'meta.json';
export const DECISIONS_FILE = 'decisions.jsonl';
export const CONFIG_FILE = 'config.json';
export const SESSIONS_DIR = 'sessions';
export const BLENDS_DIR = 'blends';
export const LIVE_DIR = 'live';
/** Migration parks unmergeable/stale artifacts here, never deletes them. */
export const LEGACY_BACKUP_DIR = 'legacy-backup';
/** Blend group holding recovered v1 state/decisions that had no blend. */
export const RECOVERED_BLEND_ID = '_recovered';

export const STORE_VERSION = 2;

export interface SessionRef {
  id: string;
  dir: string;
}

export interface AppConfig {
  storeVersion?: number;
  /** Desktop sidebar selection memory ONLY — recall never consults this. */
  lastBlendId?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Home resolution
// ---------------------------------------------------------------------------

/** Platform default store root (Application Support / XDG / APPDATA). */
export function defaultAppDataHome(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Horatio');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'Horatio');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'horatio');
}

/** The v1 default store root — migration source, nothing else reads it. */
export function legacyAppDataHome(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'flightrec');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'flightrec');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'flightrec');
}

let warnedLegacyEnv = false;

/** First set of HORATIO_<name> / FLIGHTREC_<name>; legacy hit warns once. */
export function envWithFallback(name: string): string | undefined {
  const v = process.env[`HORATIO_${name}`];
  if (v !== undefined && v.trim() !== '') return v.trim();
  const legacy = process.env[`FLIGHTREC_${name}`];
  if (legacy !== undefined && legacy.trim() !== '') {
    if (!warnedLegacyEnv) {
      warnedLegacyEnv = true;
      console.error(
        `[horatio] FLIGHTREC_${name} is deprecated — rename it to HORATIO_${name}`
      );
    }
    return legacy.trim();
  }
  return undefined;
}

/** True when home is a workspace `.horatio`/`.flightrec` (not under ~ directly). */
export function isProjectLocalHome(home: string): boolean {
  const resolved = path.resolve(home);
  const base = path.basename(resolved);
  if (base !== '.horatio' && base !== '.flightrec') return false;
  return (
    resolved !== path.resolve(path.join(os.homedir(), '.horatio')) &&
    resolved !== path.resolve(path.join(os.homedir(), '.flightrec'))
  );
}

/** Resolve the store root: HORATIO_HOME → FLIGHTREC_HOME → app-data path. */
export function horatioHome(): string {
  const h = envWithFallback('HOME');
  if (h) return expandTilde(h);
  return defaultAppDataHome();
}

// ---------------------------------------------------------------------------
// Store-version detection (design §2)
// ---------------------------------------------------------------------------

export type StoreState = 'v2' | 'v1' | 'empty';

/**
 * v2 ⇔ config.json says storeVersion 2. Otherwise any v1 marker (projects/
 * tree, flat root project-state.md, or session dirs without a v2 stamp) ⇒ v1.
 * Anything else ⇒ empty (safe to initialize).
 */
export function storeState(home: string = horatioHome()): StoreState {
  const cfg = readConfigAt(home);
  if (cfg.storeVersion === STORE_VERSION) return 'v2';
  if (fs.existsSync(path.join(home, 'projects'))) return 'v1';
  if (fs.existsSync(path.join(home, 'project-state.md'))) return 'v1';
  const sess = path.join(home, SESSIONS_DIR);
  if (fs.existsSync(sess)) {
    const hasDirs = fs
      .readdirSync(sess, { withFileTypes: true })
      .some((d) => d.isDirectory());
    if (hasDirs) return 'v1';
  }
  return 'empty';
}

export class MigrationNeededError extends Error {
  constructor(home: string) {
    super(
      `this store was written by flightrec (v1) and needs a one-time migration — run \`horatio migrate\` (store: ${home})`
    );
    this.name = 'MigrationNeededError';
  }
}

/**
 * Reader-side home: refuses v1 stores, initializes empty ones.
 * Everything except the tap and migrate goes through this.
 */
export function ensureV2Home(): string {
  const home = horatioHome();
  const state = storeState(home);
  if (state === 'v1') throw new MigrationNeededError(home);
  initV2(home);
  return home;
}

/**
 * Tap-side home: NEVER refuses (recording must not be blocked, design §2).
 * On a v1 store it only mkdirs sessions/ + live/ and leaves config alone so
 * v1 markers stay intact for migration.
 */
export function ensureRecordingHome(): string {
  const home = horatioHome();
  if (storeState(home) === 'v1') {
    fs.mkdirSync(path.join(home, SESSIONS_DIR), { recursive: true });
    fs.mkdirSync(path.join(home, LIVE_DIR), { recursive: true });
    return home;
  }
  initV2(home);
  return home;
}

function initV2(home: string): void {
  fs.mkdirSync(path.join(home, SESSIONS_DIR), { recursive: true });
  fs.mkdirSync(path.join(home, BLENDS_DIR), { recursive: true });
  fs.mkdirSync(path.join(home, LIVE_DIR), { recursive: true });
  const cfg = readConfigAt(home);
  if (cfg.storeVersion !== STORE_VERSION) {
    writeConfigAt(home, { ...cfg, storeVersion: STORE_VERSION });
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readConfigAt(home: string): AppConfig {
  const f = path.join(home, CONFIG_FILE);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as AppConfig;
  } catch {
    return {};
  }
}

function writeConfigAt(home: string, cfg: AppConfig): void {
  fs.mkdirSync(home, { recursive: true });
  const f = path.join(home, CONFIG_FILE);
  atomicWrite(f, JSON.stringify(cfg, null, 2) + '\n');
}

export function readAppConfig(): AppConfig {
  return readConfigAt(horatioHome());
}

export function writeAppConfig(cfg: AppConfig): void {
  writeConfigAt(horatioHome(), cfg);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function sessionsRoot(): string {
  return path.join(horatioHome(), SESSIONS_DIR);
}

export function sessionDirById(id: string): string {
  return path.join(sessionsRoot(), id);
}

/** ISO UTC timestamp with ':' → '-' so it's a valid dirname everywhere. */
export function sessionIdNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

/**
 * Create a fresh session dir with an EXCLUSIVE mkdir — two taps starting in
 * the same second get distinct dirs instead of silently sharing one.
 */
export function newSessionDir(): SessionRef {
  const root = sessionsRoot();
  fs.mkdirSync(root, { recursive: true });
  const base = sessionIdNow();
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const dir = path.join(root, id);
    try {
      fs.mkdirSync(dir); // non-recursive: throws EEXIST instead of succeeding
      return { id, dir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** A directory counts as a session iff it has session.json or raw.jsonl. */
function isSessionDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, SESSION_FILE)) ||
    fs.existsSync(path.join(dir, RAW_FILE))
  );
}

/** Newest first — ISO ids sort lexicographically. */
export function listSessions(): SessionRef[] {
  const base = sessionsRoot();
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, dir: path.join(base, d.name) }))
    .filter((s) => isSessionDir(s.dir))
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function latestSession(): SessionRef | undefined {
  return listSessions()[0];
}

/** 'latest' | session id | path-to-session-dir (must hold session data). */
export function resolveSession(ref: string): SessionRef {
  if (ref === 'latest') {
    const s = latestSession();
    if (!s) throw new Error(`no sessions found under ${sessionsRoot()}`);
    return s;
  }
  const asId = sessionDirById(ref);
  if (fs.existsSync(asId) && isSessionDir(asId)) return { id: ref, dir: asId };
  const asPath = path.resolve(ref);
  // Guard: never treat an arbitrary existing dir as a session (a mistyped
  // path must not get digest/note files written into it).
  if (fs.existsSync(asPath) && isSessionDir(asPath)) {
    return { id: path.basename(asPath), dir: asPath };
  }
  throw new Error(`session not found: ${ref}`);
}

// --- per-session metadata (design §3: one writer class per file) -----------

export function readSessionInfo(sessionDir: string): SessionInfo | undefined {
  return readJsonFile<SessionInfo>(path.join(sessionDir, SESSION_FILE));
}

export function writeSessionInfo(sessionDir: string, info: SessionInfo): void {
  atomicWrite(path.join(sessionDir, SESSION_FILE), JSON.stringify(info, null, 2) + '\n');
}

export function readLink(sessionDir: string): LinkInfo | undefined {
  const l = readJsonFile<LinkInfo>(path.join(sessionDir, LINK_FILE));
  return l && l.blendId ? l : undefined;
}

export function writeLink(sessionDir: string, link: LinkInfo): void {
  atomicWrite(path.join(sessionDir, LINK_FILE), JSON.stringify(link, null, 2) + '\n');
}

export function readMemoryInfo(sessionDir: string): MemoryInfo | undefined {
  return readJsonFile<MemoryInfo>(path.join(sessionDir, MEMORY_FILE));
}

export function writeMemoryInfo(sessionDir: string, info: MemoryInfo): void {
  atomicWrite(path.join(sessionDir, MEMORY_FILE), JSON.stringify(info, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Live pointers — one file per tap (design §4)
// ---------------------------------------------------------------------------

const LIVE_STALE_SWEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A pointer only counts as live-and-active if raw.jsonl moved recently. */
export const LIVE_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export function writeLivePointer(session: SessionRef, pid: number): void {
  const dir = path.join(horatioHome(), LIVE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p: LivePointer = { sessionId: session.id, pid, startedAt: new Date().toISOString() };
  atomicWrite(path.join(dir, `${session.id}.json`), JSON.stringify(p, null, 2) + '\n');
}

/** Each tap removes ONLY its own pointer (never a concurrent tap's). */
export function removeLivePointer(sessionId: string): void {
  try {
    fs.unlinkSync(path.join(horatioHome(), LIVE_DIR, `${sessionId}.json`));
  } catch {
    /* best-effort */
  }
}

/** ESRCH ⇒ dead. EPERM ⇒ ALIVE (another user's process — never break it). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LiveSessionRef extends SessionRef {
  pid: number;
  startedAt: string;
  /** raw.jsonl mtime — ranking key for "the" live session. */
  lastActivityMs: number;
}

/**
 * Live sessions: pointer present, pid alive, session dir exists. Sorted most
 * recently active first. Sweeps pointer files that are clearly stale.
 */
export function listLiveSessions(): LiveSessionRef[] {
  const dir = path.join(horatioHome(), LIVE_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: LiveSessionRef[] = [];
  const now = Date.now();
  for (const ent of fs.readdirSync(dir)) {
    if (!ent.endsWith('.json')) continue;
    const f = path.join(dir, ent);
    const p = readJsonFile<LivePointer>(f);
    if (!p || typeof p.pid !== 'number' || !p.sessionId) {
      sweep(f);
      continue;
    }
    const sdir = sessionDirById(p.sessionId);
    const dead = !pidAlive(p.pid) || !fs.existsSync(sdir);
    if (dead) {
      // Dead pointers are swept once old enough that a slow teardown can't race us.
      const age = now - Date.parse(p.startedAt || '') || LIVE_STALE_SWEEP_MS;
      if (age > 60_000) sweep(f);
      continue;
    }
    let lastActivityMs = 0;
    try {
      lastActivityMs = fs.statSync(path.join(sdir, RAW_FILE)).mtimeMs;
    } catch {
      /* no raw yet — keep 0 */
    }
    out.push({ id: p.sessionId, dir: sdir, pid: p.pid, startedAt: p.startedAt, lastActivityMs });
  }
  return out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

/** The most recently active live session with recent traffic, if any. */
export function currentLiveSession(): LiveSessionRef | undefined {
  const live = listLiveSessions();
  if (live.length === 0) return undefined;
  const top = live[0];
  // A live pid with ancient traffic is a parked client, still "live" but the
  // caller decides; we only require the dir to exist (checked in list).
  return top;
}

function sweep(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Blends
// ---------------------------------------------------------------------------

export function blendsRoot(): string {
  return path.join(horatioHome(), BLENDS_DIR);
}

export function blendDir(blendId: string): string {
  return path.join(blendsRoot(), blendId);
}

export function readBlendMeta(blendId: string): BlendMeta | undefined {
  return readJsonFile<BlendMeta>(path.join(blendDir(blendId), BLEND_META_FILE));
}

export function writeBlendMeta(meta: BlendMeta): void {
  const dir = blendDir(meta.id);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, BLEND_META_FILE), JSON.stringify(meta, null, 2) + '\n');
}

export function listBlendMetas(): BlendMeta[] {
  const base = blendsRoot();
  if (!fs.existsSync(base)) return [];
  const out: BlendMeta[] = [];
  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const meta = readJsonFile<BlendMeta>(path.join(base, ent.name, BLEND_META_FILE));
    out.push(
      meta ?? {
        id: ent.name,
        blendPath: '',
        name: ent.name,
        createdAt: '',
        updatedAt: '',
      }
    );
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** File memory (memory.md). '' when absent. */
export function readBlendMemory(blendId: string): string {
  const f = path.join(blendDir(blendId), MEMORY_MD);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

/**
 * Overwrite file memory, archiving the previous generation first
 * (memory-history/, pruned to MEMORY_HISTORY_KEEP). Caller holds memory.lock.
 */
export function writeBlendMemory(blendId: string, content: string): void {
  const dir = blendDir(blendId);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, MEMORY_MD);
  if (fs.existsSync(f)) {
    const hist = path.join(dir, MEMORY_HISTORY_DIR);
    fs.mkdirSync(hist, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-');
    fs.copyFileSync(f, path.join(hist, `memory-${stamp}.md`));
    const gens = fs.readdirSync(hist).filter((n) => n.startsWith('memory-')).sort();
    for (const old of gens.slice(0, Math.max(0, gens.length - MEMORY_HISTORY_KEEP))) {
      try {
        fs.unlinkSync(path.join(hist, old));
      } catch {
        /* ignore */
      }
    }
  }
  atomicWrite(f, content);
}

// ---------------------------------------------------------------------------
// Decisions — the one non-re-derivable artifact. Never overwritten, only
// appended or union-merged.
// ---------------------------------------------------------------------------

export function decisionsPathForBlend(blendId: string): string {
  return path.join(blendDir(blendId), DECISIONS_FILE);
}

export function decisionsPathForSession(sessionDir: string): string {
  return path.join(sessionDir, DECISIONS_FILE);
}

export function readDecisionsFile(file: string): DecisionEntry[] {
  return readJsonl<DecisionEntry>(file);
}

export function readDecisions(blendId: string): DecisionEntry[] {
  return readDecisionsFile(decisionsPathForBlend(blendId));
}

const DECISION_LOG_HEADER = '## Decision log';

/**
 * Journal the decision into the blend's decisions.jsonl and mechanically
 * rewrite the Decision log section of its memory.md (the journal, not the
 * model, is the source of truth for decisions).
 */
export function appendDecision(blendId: string, text: string): DecisionEntry {
  const entry: DecisionEntry = { ts: new Date().toISOString(), text, source: 'agent' };
  fs.mkdirSync(blendDir(blendId), { recursive: true });
  appendJsonl(decisionsPathForBlend(blendId), entry);

  const state = readBlendMemory(blendId);
  const line = `- ${entry.ts} — ${text}`;
  let next: string;
  if (state.includes(DECISION_LOG_HEADER)) {
    const start = state.indexOf(DECISION_LOG_HEADER);
    const afterHeader = start + DECISION_LOG_HEADER.length;
    const nextSection = state.indexOf('\n## ', afterHeader);
    const insertAt = nextSection === -1 ? state.length : nextSection;
    next = state.slice(0, insertAt).replace(/\n*$/, '\n') + line + '\n' + state.slice(insertAt);
  } else {
    next =
      (state === '' ? `# File memory\n` : state.replace(/\n*$/, '\n')) +
      `\n${DECISION_LOG_HEADER}\n${line}\n`;
  }
  writeBlendMemory(blendId, next);
  return entry;
}

/** Session-scoped decision (unlinked session): journal only, merged on link. */
export function appendSessionDecision(sessionDir: string, text: string): DecisionEntry {
  const entry: DecisionEntry = { ts: new Date().toISOString(), text, source: 'agent' };
  appendJsonl(decisionsPathForSession(sessionDir), entry);
  return entry;
}

/**
 * Union-merge decisions from `fromFile` into `toFile`, dedup key ts+text.
 * Never drops or reorders existing target lines. Returns entries added.
 */
export function mergeDecisionFiles(fromFile: string, toFile: string): number {
  const from = readJsonl<DecisionEntry>(fromFile);
  if (from.length === 0) return 0;
  const existing = new Set(readJsonl<DecisionEntry>(toFile).map((d) => `${d.ts} ${d.text}`));
  let added = 0;
  for (const d of from) {
    if (existing.has(`${d.ts} ${d.text}`)) continue;
    appendJsonl(toFile, d);
    existing.add(`${d.ts} ${d.text}`);
    added++;
  }
  return added;
}

// ---------------------------------------------------------------------------
// JSONL + file helpers
// ---------------------------------------------------------------------------

export function appendJsonl(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

/** Tolerant reader: unparseable lines are skipped (warned), never fatal. */
export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      console.error(`[horatio] skipping unparseable line in ${file}`);
    }
  }
  return out;
}

function readJsonFile<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Atomic write: tmp + rename. */
export function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Contiguous-from-0 high-water mark over ok digest batches; -1 when none.
 * THE canonical coverage/staleness primitive (design §3/§6): memory.json's
 * coveredSeq must always be derived from this — a scalar that can never sit
 * above a coverage hole.
 */
export function contiguousOkCoverage(digestFile: string): number {
  const metas = readJsonl<DigestRecord>(digestFile).filter(
    (r): r is BatchMeta => (r as BatchMeta).kind === 'batch' && (r as BatchMeta).status === 'ok'
  );
  const ranges = metas.map((m) => m.srcRange).sort((a, b) => a[0] - b[0]);
  let covered = -1;
  for (const [lo, hi] of ranges) {
    if (lo > covered + 1) break;
    covered = Math.max(covered, hi);
  }
  return covered;
}

export function noteExists(sessionDir: string): boolean {
  return fs.existsSync(path.join(sessionDir, NOTE_FILE));
}

export function rawPath(sessionDir: string): string {
  return path.join(sessionDir, RAW_FILE);
}
export function digestPath(sessionDir: string): string {
  return path.join(sessionDir, DIGEST_FILE);
}
export function notePath(sessionDir: string): string {
  return path.join(sessionDir, NOTE_FILE);
}
export function agentMemoryPath(sessionDir: string): string {
  return path.join(sessionDir, AGENT_MEMORY_FILE);
}
export function artifactsDir(sessionDir: string): string {
  return path.join(sessionDir, ARTIFACTS_DIR);
}
export function distillLogPath(sessionDir: string): string {
  return path.join(sessionDir, DISTILL_LOG);
}

export function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}
