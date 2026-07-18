/**
 * One-time v1 → v2 store migration (design §9).
 *
 * Handles every v1 population found in the wild:
 *   - app-data `projects/<blend-hash-bucket>/sessions/*`   (era 3)
 *   - app-data `projects/<named-bucket>/sessions/*`        (era 2: hoy/dd/default)
 *   - app-data `projects/_unsaved/…`
 *   - flat local `.flightrec/`: root sessions/ + project-state.md + decisions.jsonl
 *   - `*.stale-backup` session dirs → legacy-backup/
 *
 * Guarantees:
 *   - decisions.jsonl is NEVER overwritten or dropped — always JSONL
 *     union-merged (dedup ts+text).
 *   - Idempotent by construction: every migrated source is removed, so re-runs
 *     only process leftovers (e.g. from a stray late v1 tap).
 *   - Refuses while a session appears live (raw.jsonl recently modified).
 *   - Move = rename, with EXDEV copy+remove fallback for cross-volume homes.
 *
 * Client-config rewriting (server ids, env keys, runtime paths) is
 * install.ts's job — the CLI `horatio migrate` runs both halves.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LinkInfo, RawRecord, SessionInfo } from './schema.js';
import {
  BLENDS_DIR,
  CONFIG_FILE,
  DECISIONS_FILE,
  DIGEST_FILE,
  LEGACY_BACKUP_DIR,
  MEMORY_MD,
  NOTE_FILE,
  RAW_FILE,
  RECOVERED_BLEND_ID,
  SESSIONS_DIR,
  STORE_VERSION,
  atomicWrite,
  contiguousOkCoverage,
  defaultAppDataHome,
  envWithFallback,
  horatioHome,
  legacyAppDataHome,
  mergeDecisionFiles,
  readJsonl,
  storeState,
  writeMemoryInfo,
  writeSessionInfo,
} from './store.js';

const LIVE_WINDOW_MS = 10 * 60 * 1000;
export const MOVED_MARKER = 'MOVED-TO-HORATIO.txt';

export interface MigrationReport {
  dryRun: boolean;
  sources: string[];
  target: string;
  sessionsMigrated: number;
  blendsMigrated: number;
  decisionsMerged: number;
  parked: string[]; // paths parked under legacy-backup/
  actions: string[]; // human-readable log of what was (or would be) done
  refusedLive?: string[]; // session dirs that look live — migration refused
}

class Ctx {
  report: MigrationReport;
  constructor(
    public target: string,
    public dryRun: boolean
  ) {
    this.report = {
      dryRun,
      sources: [],
      target,
      sessionsMigrated: 0,
      blendsMigrated: 0,
      decisionsMerged: 0,
      parked: [],
      actions: [],
    };
  }
  act(msg: string): void {
    this.report.actions.push(msg);
  }
}

/**
 * Migrate everything reachable into the resolved v2 home.
 * Sources: the resolved home itself (when v1-shaped) and the legacy default
 * app-data dir when it differs from the target.
 */
export function migrateStore(opts: { dryRun?: boolean } = {}): MigrationReport {
  const target = horatioHome();
  const ctx = new Ctx(target, opts.dryRun ?? false);

  const sources: string[] = [];
  if (storeState(target) === 'v1') sources.push(target);
  // Only fold in the default-location flightrec store when the user did NOT
  // choose a custom home — an explicit HORATIO_HOME (or project-local .horatio)
  // must not vacuum the global store into itself.
  const customHome = envWithFallback('HOME') !== undefined;
  const legacy = legacyAppDataHome();
  if (
    !customHome &&
    path.resolve(target) === path.resolve(defaultAppDataHome()) &&
    path.resolve(legacy) !== path.resolve(target) &&
    fs.existsSync(legacy) &&
    !fs.existsSync(path.join(legacy, MOVED_MARKER))
  ) {
    sources.push(legacy);
  }
  ctx.report.sources = sources;
  if (sources.length === 0) {
    ctx.act('nothing to migrate — store is already v2');
    return ctx.report;
  }

  // ---- live-session guard (§9.0) -----------------------------------------
  const live: string[] = [];
  for (const src of sources) {
    for (const dir of allV1SessionDirs(src)) {
      const raw = path.join(dir, RAW_FILE);
      try {
        if (Date.now() - fs.statSync(raw).mtimeMs < LIVE_WINDOW_MS) live.push(dir);
      } catch {
        /* no raw — not live */
      }
    }
  }
  if (live.length > 0) {
    ctx.report.refusedLive = live;
    ctx.act(
      `refused: ${live.length} session(s) look active (recording in the last 10 minutes) — finish or close active Blender sessions first`
    );
    return ctx.report;
  }

  // ---- migrate each source ------------------------------------------------
  for (const src of sources) {
    migrateOneStore(src, ctx);
  }

  // ---- stamp v2 -----------------------------------------------------------
  if (!ctx.dryRun) {
    const cfgFile = path.join(target, CONFIG_FILE);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    } catch {
      /* fresh */
    }
    delete cfg.lastProject; // v1 value (often '_unsaved') must not seed anything
    cfg.storeVersion = STORE_VERSION;
    atomicWrite(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
    fs.mkdirSync(path.join(target, SESSIONS_DIR), { recursive: true });
    fs.mkdirSync(path.join(target, BLENDS_DIR), { recursive: true });
  }
  ctx.act(`stamped storeVersion ${STORE_VERSION}`);
  return ctx.report;
}

// ---------------------------------------------------------------------------

function migrateOneStore(src: string, ctx: Ctx): void {
  const target = ctx.target;
  const inPlace = path.resolve(src) === path.resolve(target);
  ctx.act(`${inPlace ? 'restructuring' : 'importing'} ${src}`);

  // Flat-local root artifacts (v1 project-local shape) → _recovered group.
  recoverRootArtifacts(src, ctx);

  // Root-level sessions (flat local shape): synthesize metadata in place /
  // move into the target when importing from another store.
  const rootSessions = path.join(src, SESSIONS_DIR);
  if (fs.existsSync(rootSessions)) {
    for (const ent of sessionDirsIn(rootSessions)) {
      migrateSession(ent, undefined, src, ctx);
    }
  }

  // projects/<bucket>/ trees.
  const projectsDir = path.join(src, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const ent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      migrateBucket(path.join(projectsDir, ent.name), ent.name, src, ctx);
    }
    if (!ctx.dryRun) removeIfEmpty(projectsDir, ctx);
  }

  // Copy .env / config extras when importing from the legacy app-data dir.
  if (!inPlace) {
    for (const f of ['.env']) {
      const from = path.join(src, f);
      const to = path.join(target, f);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        ctx.act(`copy ${f}`);
        if (!ctx.dryRun) {
          fs.mkdirSync(target, { recursive: true });
          fs.copyFileSync(from, to);
        }
      }
    }
    if (!ctx.dryRun) {
      atomicWrite(
        path.join(src, MOVED_MARKER),
        `This data moved to ${target} on ${new Date().toISOString()}.\n` +
          `If new files appear here, an old flightrec install is still writing — ` +
          `run \`horatio migrate\` again after restarting your MCP clients.\n`
      );
    }
    ctx.act(`left ${MOVED_MARKER} in ${src}`);
  }
}

/** Bucket = projects/<name>: sessions move out flat; bucket artifacts → blends/. */
function migrateBucket(bucketDir: string, bucket: string, src: string, ctx: Ctx): void {
  const meta = readJsonSafe<{ id?: string; blendPath?: string; name?: string }>(
    path.join(bucketDir, 'meta.json')
  );
  const blendPath = (meta?.blendPath ?? '').trim();
  // Where this bucket's sessions/artifacts belong:
  //   blend-linked bucket → its own id;  _unsaved → unlinked sessions +
  //   recovered artifacts;  legacy named bucket → named group under its name.
  const isUnsaved = bucket === '_unsaved';
  const blendId = isUnsaved ? undefined : (meta?.id ?? bucket);

  const sessionsDir = path.join(bucketDir, SESSIONS_DIR);
  if (fs.existsSync(sessionsDir)) {
    for (const ent of sessionDirsIn(sessionsDir)) {
      migrateSession(ent, isUnsaved ? undefined : { blendId: blendId!, blendPath }, src, ctx);
    }
    if (!ctx.dryRun) removeIfEmpty(sessionsDir, ctx);
  }

  // Bucket-level artifacts.
  const destBlendId = isUnsaved ? RECOVERED_BLEND_ID : blendId!;
  const destDir = path.join(ctx.target, BLENDS_DIR, destBlendId);
  const state = path.join(bucketDir, 'project-state.md');
  const decisions = path.join(bucketDir, DECISIONS_FILE);
  const hasArtifacts =
    fs.existsSync(state) || fs.existsSync(decisions) || fs.existsSync(path.join(bucketDir, 'meta.json'));
  if (hasArtifacts) {
    ctx.act(`bucket ${bucket} → blends/${destBlendId}`);
    ctx.report.blendsMigrated++;
    if (!ctx.dryRun) {
      fs.mkdirSync(destDir, { recursive: true });
      writeBlendMetaFor(destDir, destBlendId, blendPath, meta?.name, isUnsaved);
      if (fs.existsSync(state)) {
        mergeMarkdownInto(state, path.join(destDir, MEMORY_MD), ctx);
        fs.unlinkSync(state);
        for (const bak of ['project-state.md.bak', 'project-state.md.tmp']) {
          const f = path.join(bucketDir, bak);
          if (fs.existsSync(f)) parkPath(f, ctx);
        }
      }
      if (fs.existsSync(decisions)) {
        const added = mergeDecisionFiles(decisions, path.join(destDir, DECISIONS_FILE));
        ctx.report.decisionsMerged += added;
        fs.unlinkSync(decisions);
      }
      const bucketMeta = path.join(bucketDir, 'meta.json');
      if (fs.existsSync(bucketMeta)) fs.unlinkSync(bucketMeta);
    }
  }

  if (!ctx.dryRun) {
    // Anything left in the bucket (stray files, .DS_Store) → legacy-backup.
    parkLeftovers(bucketDir, ctx);
    removeIfEmpty(bucketDir, ctx);
  }
}

/** Move one session dir into target/sessions/ and synthesize v2 metadata. */
function migrateSession(
  srcDir: string,
  linkTo: { blendId: string; blendPath: string } | undefined,
  srcStore: string,
  ctx: Ctx
): void {
  const sid = path.basename(srcDir);

  if (sid.endsWith('.stale-backup')) {
    ctx.act(`park stale backup ${sid}`);
    if (!ctx.dryRun) parkPath(srcDir, ctx);
    else ctx.report.parked.push(srcDir);
    return;
  }

  const destRoot = path.join(ctx.target, SESSIONS_DIR);
  let dest = path.join(destRoot, sid);
  const inPlace = path.resolve(srcDir) === path.resolve(dest);

  if (!inPlace && fs.existsSync(dest)) {
    const srcRaw = statSize(path.join(srcDir, RAW_FILE));
    const destRaw = statSize(path.join(dest, RAW_FILE));
    if (srcRaw <= destRaw) {
      // Destination is the more complete copy — park the incoming duplicate.
      ctx.act(`duplicate session ${sid}: keeping existing (larger), parking incoming`);
      if (!ctx.dryRun) parkPath(srcDir, ctx);
      else ctx.report.parked.push(srcDir);
      return;
    }
    // Incoming is more complete: park the existing one, take its place.
    ctx.act(`duplicate session ${sid}: incoming is more complete — swapping`);
    if (!ctx.dryRun) parkPath(dest, ctx);
    else ctx.report.parked.push(dest);
  }

  ctx.act(`session ${sid}${linkTo ? ` → ${linkTo.blendId}` : ''}`);
  ctx.report.sessionsMigrated++;
  if (ctx.dryRun) return;

  if (!inPlace) {
    fs.mkdirSync(destRoot, { recursive: true });
    moveDir(srcDir, dest);
  } else {
    dest = srcDir;
  }

  // ---- synthesize the three metadata files ----
  // Overwrite a v1-format session.json (had projectId/attachedAt, no v2
  // startedAt); never clobber an already-synthesized v2 one.
  const existingSession = readJsonSafe<{ startedAt?: string }>(path.join(dest, 'session.json'));
  if (!existingSession || !existingSession.startedAt) {
    writeSessionInfo(dest, synthesizeSessionInfo(dest, sid));
  }
  if (linkTo && linkTo.blendId !== RECOVERED_BLEND_ID && !fs.existsSync(path.join(dest, 'link.json'))) {
    const link: LinkInfo = {
      blendId: linkTo.blendId,
      blendPath: linkTo.blendPath,
      // Loose so genuine explicit evidence found later may still rebind a
      // legacy named-bucket guess; blend-hash buckets carry real paths and
      // get explicit confidence.
      via: 'detected',
      confidence: linkTo.blendPath ? 'explicit' : 'loose',
      at: new Date().toISOString(),
    };
    atomicWrite(path.join(dest, 'link.json'), JSON.stringify(link, null, 2) + '\n');
  }
  if (!fs.existsSync(path.join(dest, 'memory.json')) && fs.existsSync(path.join(dest, NOTE_FILE))) {
    // A v1 note exists — record what it can possibly cover: the contiguous
    // ok-batch high-water of the digest at migration time.
    const covered = contiguousOkCoverage(path.join(dest, DIGEST_FILE));
    if (covered >= 0) {
      let updatedAt = new Date().toISOString();
      try {
        updatedAt = fs.statSync(path.join(dest, NOTE_FILE)).mtime.toISOString();
      } catch {
        /* keep now */
      }
      writeMemoryInfo(dest, { coveredSeq: covered, updatedAt, trigger: 'catchup' });
    }
  }
  void srcStore;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function synthesizeSessionInfo(dir: string, sid: string): SessionInfo {
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let tapPid: number | undefined;
  let cmd: string[] | undefined;
  let sawEnd = false;
  try {
    // First + last line of raw.jsonl carry session_start / session_end.
    const records = readJsonl<RawRecord>(path.join(dir, RAW_FILE));
    for (const r of records) {
      if (r.dir !== 'meta' || !r.meta) continue;
      if (r.meta.event === 'session_start') {
        startedAt ??= r.ts;
        tapPid ??= r.meta.tapPid;
        cmd ??= r.meta.cmd;
      } else if (r.meta.event === 'session_end') {
        endedAt = r.ts;
        sawEnd = true;
      }
    }
    if (!startedAt && records.length > 0) startedAt = records[0].ts;
    if (!endedAt && records.length > 0) endedAt = records[records.length - 1].ts;
  } catch {
    /* fall through to id parse */
  }
  startedAt ??= startedAtFromId(sid);
  const info: SessionInfo = { id: sid, startedAt, tapPid, cmd };
  if (endedAt) {
    info.endedAt = endedAt;
    info.endReason = sawEnd ? 'session_end' : 'inactivity';
  }
  return info;
}

/** `2026-07-18T18-20-18Z-2` → `2026-07-18T18:20:18Z` (suffix-safe). */
export function startedAtFromId(sid: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(sid);
  if (!m) return new Date(0).toISOString();
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
}

function recoverRootArtifacts(src: string, ctx: Ctx): void {
  const state = path.join(src, 'project-state.md');
  const decisions = path.join(src, DECISIONS_FILE);
  if (!fs.existsSync(state) && !fs.existsSync(decisions)) return;
  const destDir = path.join(ctx.target, BLENDS_DIR, RECOVERED_BLEND_ID);
  ctx.act(`root notes/decisions → blends/${RECOVERED_BLEND_ID}`);
  if (ctx.dryRun) return;
  fs.mkdirSync(destDir, { recursive: true });
  writeBlendMetaFor(destDir, RECOVERED_BLEND_ID, '', 'Recovered notes', true);
  if (fs.existsSync(state)) {
    mergeMarkdownInto(state, path.join(destDir, MEMORY_MD), ctx);
    fs.unlinkSync(state);
    for (const bak of ['project-state.md.bak']) {
      const f = path.join(src, bak);
      if (fs.existsSync(f)) parkPath(f, ctx);
    }
  }
  if (fs.existsSync(decisions)) {
    ctx.report.decisionsMerged += mergeDecisionFiles(decisions, path.join(destDir, DECISIONS_FILE));
    fs.unlinkSync(decisions);
  }
}

function writeBlendMetaFor(
  destDir: string,
  id: string,
  blendPath: string,
  name: string | undefined,
  isGroup: boolean
): void {
  const metaFile = path.join(destDir, 'meta.json');
  if (fs.existsSync(metaFile)) return; // never clobber an existing v2 meta
  const now = new Date().toISOString();
  atomicWrite(
    metaFile,
    JSON.stringify(
      {
        id,
        blendPath,
        name: name ?? (isGroup ? id : path.basename(blendPath) || id),
        createdAt: now,
        updatedAt: now,
      },
      null,
      2
    ) + '\n'
  );
}

/**
 * Merge a v1 project-state.md into a possibly-existing v2 memory.md without
 * dropping either: absent target ⇒ move; present ⇒ append under a divider.
 */
function mergeMarkdownInto(from: string, to: string, ctx: Ctx): void {
  const incoming = fs.readFileSync(from, 'utf8').trim();
  if (incoming === '') return;
  if (!fs.existsSync(to)) {
    atomicWrite(to, incoming + '\n');
    return;
  }
  const existing = fs.readFileSync(to, 'utf8');
  if (existing.includes(incoming)) return; // already merged (idempotent re-run)
  atomicWrite(to, existing.replace(/\n*$/, '\n') + `\n---\n\n<!-- merged from v1 on ${new Date().toISOString()} -->\n\n` + incoming + '\n');
  ctx.act(`merged extra memory into ${path.basename(path.dirname(to))}`);
}

function allV1SessionDirs(store: string): string[] {
  const out: string[] = [];
  const root = path.join(store, SESSIONS_DIR);
  if (fs.existsSync(root)) out.push(...sessionDirsIn(root));
  const projects = path.join(store, 'projects');
  if (fs.existsSync(projects)) {
    for (const ent of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const s = path.join(projects, ent.name, SESSIONS_DIR);
      if (fs.existsSync(s)) out.push(...sessionDirsIn(s));
    }
  }
  return out;
}

function sessionDirsIn(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name));
}

function parkPath(p: string, ctx: Ctx): void {
  const backupRoot = path.join(ctx.target, LEGACY_BACKUP_DIR);
  fs.mkdirSync(backupRoot, { recursive: true });
  let dest = path.join(backupRoot, path.basename(p));
  for (let n = 2; fs.existsSync(dest); n++) {
    dest = path.join(backupRoot, `${path.basename(p)}-${n}`);
  }
  moveDir(p, dest);
  ctx.report.parked.push(dest);
}

function parkLeftovers(dir: string, ctx: Ctx): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir)) {
    if (ent === '.DS_Store') {
      try {
        fs.unlinkSync(path.join(dir, ent));
      } catch {
        /* ignore */
      }
      continue;
    }
    parkPath(path.join(dir, ent), ctx);
  }
}

function removeIfEmpty(dir: string, ctx: Ctx): void {
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      ctx.act(`removed empty ${dir}`);
    }
  } catch {
    /* ignore */
  }
}

/** rename with EXDEV fallback (copy + verify count + remove). */
function moveDir(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
  const a = countEntries(from);
  const b = countEntries(to);
  if (b < a) throw new Error(`copy verification failed: ${to} has ${b}/${a} entries`);
  fs.rmSync(from, { recursive: true, force: true });
}

function countEntries(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      n++;
      if (ent.isDirectory()) walk(path.join(d, ent.name));
    }
  };
  try {
    if (fs.statSync(dir).isDirectory()) walk(dir);
    else return 1;
  } catch {
    return 0;
  }
  return n;
}

function statSize(f: string): number {
  try {
    return fs.statSync(f).size;
  } catch {
    return -1;
  }
}

function readJsonSafe<T>(f: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
