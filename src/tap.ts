#!/usr/bin/env node
/**
 * Horatio tap — transparent stdio wrapper around an MCP server.
 *
 *   node dist/tap.js -- uvx blender-mcp
 *
 * Forwarding is byte-for-byte via stream piping and never waits on logging.
 * Logging is a separate read of the same streams: newline-split, JSON-parsed
 * per line; a parse failure logs a raw record and changes nothing else.
 *
 * v2: session dirs are flat and NEVER move, so paths are stable for a
 * session's whole lifetime. The tap owns session.json (lifecycle) and its
 * live/ pointer; it does no blend detection and no store scans — nothing runs
 * on the forwarding path but forwarding.
 *
 * Session rotation: long-lived MCP clients (Cursor) keep one tap process
 * alive for days, so "one session per process" would smear unrelated work
 * into a single session. When a substantive request arrives after a long idle
 * gap (default 30 min, HORATIO_ROTATE_IDLE_MS to tune, ≤0 disables), the tap
 * closes the current session exactly like a real end (session_end meta →
 * follower flushes + folds memory) and opens a fresh one. Rotation lives on
 * the logging path only and is fully try/caught — a rotation failure means we
 * keep writing to the old session, never a crash.
 *
 * node:* builtins only. Boring is the spec.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageRef, RawRecord, SessionMeta } from './lib/schema.js';
import {
  artifactsDir,
  ensureRecordingHome,
  newSessionDir,
  rawPath,
  readSessionInfo,
  removeLivePointer,
  writeLivePointer,
  writeSessionInfo,
  type SessionRef,
} from './lib/store.js';

// --------------------------------------------------------------------------
// argv: everything after `--` is the child command
// --------------------------------------------------------------------------
const sep = process.argv.indexOf('--');
const childCmd = sep === -1 ? [] : process.argv.slice(sep + 1);
if (childCmd.length === 0) {
  console.error('usage: tap.js -- <command> [args...]');
  process.exit(2);
}

// --------------------------------------------------------------------------
// session + log stream (recording never blocks on store state — v1 stores
// get v2-shaped sessions appended; migration unifies later)
//
// Session state is a unit swapped atomically by rotation: dir, raw stream,
// and the per-session seq counter.
// --------------------------------------------------------------------------
ensureRecordingHome();

/** Idle gap after which the NEXT substantive request starts a fresh session. */
const ROTATE_IDLE_MS = (() => {
  const raw = process.env.HORATIO_ROTATE_IDLE_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n; // ≤ 0 disables rotation
  }
  return 30 * 60 * 1000;
})();

let session!: SessionRef;
let logFile!: string;
let logStream!: fs.WriteStream;
let closed = false;
let seq = 0;
/** Last time we logged substantive (non-protocol-noise) traffic. */
let lastSubstantiveMs = Date.now();

/** Open a fresh session: dir + stream + metadata + live pointer + follower. */
function openSession(): void {
  const next = newSessionDir();
  const nextLogFile = rawPath(next.dir);
  const nextStream = fs.createWriteStream(nextLogFile, { flags: 'a' });
  nextStream.on('error', () => { /* logging must never take down forwarding */ });
  // Everything that can throw has succeeded — commit the swap.
  session = next;
  logFile = nextLogFile;
  logStream = nextStream;
  seq = 0;
  lastSubstantiveMs = Date.now();
  try {
    writeSessionInfo(session.dir, {
      id: session.id,
      startedAt: new Date().toISOString(),
      tapPid: process.pid,
      cmd: childCmd,
    });
    writeLivePointer(session, process.pid);
  } catch {
    /* metadata is best-effort; raw recording carries the ground truth */
  }
  writeRecord({
    dir: 'meta',
    bytes: 0,
    meta: { event: 'session_start', cmd: childCmd, tapPid: process.pid },
  });
  spawnFollower(session);
}

/**
 * Open a fresh session, then close the old one the same way a real end would
 * — session_end meta so its live follower flushes + folds memory. Order
 * matters: if opening the new session throws, the old one is untouched and
 * recording simply continues there.
 */
function rotateSession(): void {
  const old = session;
  const oldStream = logStream;
  const oldEndSeq = seq;
  openSession(); // swaps session/logFile/logStream/seq — may throw (caller catches)

  try {
    const full: RawRecord = {
      ts: new Date().toISOString(),
      seq: oldEndSeq,
      dir: 'meta',
      bytes: 0,
      meta: { event: 'session_end' },
    };
    oldStream.write(JSON.stringify(full) + '\n');
  } catch { /* ignore */ }
  try {
    const info = readSessionInfo(old.dir);
    if (info) {
      writeSessionInfo(old.dir, {
        ...info,
        endedAt: new Date().toISOString(),
        endReason: 'rotated',
      });
    }
  } catch { /* ignore */ }
  try { removeLivePointer(old.id); } catch { /* ignore */ }
  try { oldStream.end(); } catch { /* ignore */ }
  console.error(`[horatio tap] rotated session ${old.id} -> ${session.id} (idle >= ${ROTATE_IDLE_MS}ms)`);
}

/** Rotation check — called only for substantive requests, never throws. */
function maybeRotate(): void {
  if (closed || ROTATE_IDLE_MS <= 0) return;
  if (Date.now() - lastSubstantiveMs < ROTATE_IDLE_MS) return;
  try {
    rotateSession();
  } catch {
    /* rotation failure: keep recording into the current session */
  }
}

function writeRecord(rec: Omit<RawRecord, 'ts' | 'seq'>): void {
  if (closed) return;
  try {
    const full: RawRecord = { ts: new Date().toISOString(), seq: seq++, ...rec };
    logStream.write(JSON.stringify(full) + '\n');
  } catch {
    /* never throw from the logging path */
  }
}

/** Teardown: sync writes so they survive process.exit. */
function writeFinalRecord(meta: SessionMeta): void {
  if (closed) return;
  closed = true;
  try {
    const full: RawRecord = { ts: new Date().toISOString(), seq: seq++, dir: 'meta', bytes: 0, meta };
    fs.appendFileSync(logFile, JSON.stringify(full) + '\n');
  } catch { /* ignore */ }
  try {
    const info = readSessionInfo(session.dir);
    if (info) {
      writeSessionInfo(session.dir, {
        ...info,
        endedAt: new Date().toISOString(),
        endReason: 'session_end',
      });
    }
  } catch { /* ignore */ }
  try { removeLivePointer(session.id); } catch { /* ignore */ }
  try { logStream.end(); } catch { /* ignore */ }
}

// --------------------------------------------------------------------------
// child + forwarding (the entire transparency-critical path)
// --------------------------------------------------------------------------
const child: ChildProcess = spawn(childCmd[0], childCmd.slice(1), {
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.on('error', (err) => {
  console.error(`[horatio tap] failed to spawn child: ${String(err)}`);
  writeFinalRecord({ event: 'session_end', exitCode: null });
  process.exit(1);
});

process.stdin.pipe(child.stdin!);
child.stdout!.pipe(process.stdout);

// Stray-write guards: a dead parent or dead child must not crash the tap.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') shutdown();
});
child.stdin!.on('error', () => { /* child gone; 'exit' handler owns cleanup */ });
process.stdin.on('error', () => { /* ignore */ });
process.stdin.on('end', () => {
  try { child.stdin!.end(); } catch { /* ignore */ }
});

// --------------------------------------------------------------------------
// logging path: newline splitter + JSON-RPC classification
// --------------------------------------------------------------------------
const MAX_LINE = 64 * 1024 * 1024; // screenshots are single multi-MB lines; 64MB is headroom

class LineSplitter {
  private buf: Buffer[] = [];
  private size = 0;
  constructor(private onLine: (line: string, bytes: number) => void) {}

  feed(chunk: Buffer): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        this.buf.push(chunk.subarray(start, i));
        this.emit();
        start = i + 1;
      }
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.buf.push(rest);
      this.size += rest.length;
      if (this.size > MAX_LINE) this.emit(); // pathological line: flush what we have
    }
  }

  private emit(): void {
    const line = Buffer.concat(this.buf);
    this.buf = [];
    this.size = 0;
    if (line.length > 0) this.onLine(line.toString('utf8'), line.length);
  }
}

/**
 * Protocol chatter that must not count as activity for session rotation —
 * Cursor pings and list-refreshes forever, so an "any traffic" clock would
 * never see an idle gap. Mirrors the distiller's noise set (tier1.ts).
 */
const NOISE_METHODS = new Set([
  'ping',
  'initialize',
  'tools/list',
  'resources/list',
  'prompts/list',
]);

function isProtocolNoise(name: string): boolean {
  return NOISE_METHODS.has(name) || name.startsWith('notifications/');
}

/**
 * req id → tool name, so responses (which carry no method) can be attributed.
 * Keyed by originating stream: client ids ('in') and server-initiated ids
 * ('out') are separate JSON-RPC id spaces and may collide.
 */
const pending = new Map<string, { tool: string; at: number }>();
const PENDING_CAP = 10_000;
const PENDING_TTL_MS = 10 * 60 * 1000;

function rememberRequest(source: 'in' | 'out', id: number | string, tool: string): void {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (pending.size < PENDING_CAP && now - v.at < PENDING_TTL_MS) break;
    pending.delete(k); // Map iterates in insertion order → FIFO eviction
  }
  pending.set(`${source}:${String(id)}`, { tool, at: now });
}

function logLine(line: string, bytes: number, source: 'in' | 'out'): void {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    writeRecord({ dir: 'raw', payload: trimmed, bytes });
    return;
  }
  if (Array.isArray(msg)) {
    // Legacy JSON-RPC batch: log each element as its own record.
    for (const m of msg) logMessage(m, bytes, source);
    return;
  }
  logMessage(msg, bytes, source);
}

function logMessage(msg: unknown, bytes: number, source: 'in' | 'out'): void {
  if (typeof msg !== 'object' || msg === null) {
    writeRecord({ dir: 'raw', payload: msg, bytes });
    return;
  }
  const m = msg as Record<string, unknown>;

  if (typeof m.method === 'string') {
    const hasId = 'id' in m && m.id !== null && m.id !== undefined;
    const id = hasId ? (m.id as number | string) : null;
    const tool =
      m.method === 'tools/call' &&
      typeof (m.params as Record<string, unknown> | undefined)?.name === 'string'
        ? ((m.params as Record<string, unknown>).name as string)
        : m.method;
    const substantive = !isProtocolNoise(m.method);
    // Rotate on the request boundary so a req/res pair never straddles two
    // sessions; the request below is then the new session's first record.
    if (substantive) maybeRotate();
    if (hasId) rememberRequest(source, id as number | string, tool);
    writeRecord({ dir: 'req', id, method: m.method, tool, payload: m.params, bytes });
    if (substantive) lastSubstantiveMs = Date.now();
    return;
  }

  if ('id' in m && ('result' in m || 'error' in m)) {
    const id = m.id as number | string;
    // A response answers a request from the opposite stream.
    const key = `${source === 'in' ? 'out' : 'in'}:${String(id)}`;
    const known = pending.get(key);
    if (known) pending.delete(key);
    const isErr =
      'error' in m || (m.result as Record<string, unknown> | undefined)?.isError === true;
    const payload = 'error' in m ? m.error : extractImages(m.result, id);
    writeRecord({
      dir: 'res',
      id,
      tool: known?.tool,
      status: isErr ? 'error' : 'success',
      payload,
      bytes,
    });
    // Unknown attribution counts as substantive — err toward NOT rotating.
    if (!known || !isProtocolNoise(known.tool)) lastSubstantiveMs = Date.now();
    return;
  }

  // Parsed JSON but not recognizable JSON-RPC: keep it verbatim.
  writeRecord({ dir: 'raw', payload: m, bytes });
}

// --------------------------------------------------------------------------
// image extraction — never let base64 hit the log
// --------------------------------------------------------------------------
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function extractImages(result: unknown, id: number | string): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.content)) return result;

  let imgN = 0;
  let swapped = false;
  const content = r.content.map((item: unknown) => {
    const it = item as Record<string, unknown> | null;
    if (
      it &&
      it.type === 'image' &&
      typeof it.data === 'string' &&
      it.data.length > 0
    ) {
      try {
        const buf = Buffer.from(it.data, 'base64');
        const mime = typeof it.mimeType === 'string' ? it.mimeType : 'image/png';
        const ext = EXT_BY_MIME[mime] ?? '.png';
        const name = `shot-${String(id)}${imgN > 0 ? `-${imgN}` : ''}${ext}`;
        imgN++;
        const dir = artifactsDir(session.dir);
        fs.mkdirSync(dir, { recursive: true });
        // async: artifact writes stay off the forwarding/logging hot path
        fs.writeFile(path.join(dir, name), buf, () => {});
        swapped = true;
        const ref: ImageRef = {
          type: 'image_ref',
          image_ref: `artifacts/${name}`,
          bytes: buf.length,
          mimeType: mime,
        };
        return ref;
      } catch {
        return item; // extraction failure: log as-is rather than lose data
      }
    }
    return item;
  });
  return swapped ? { ...r, content } : result;
}

// --------------------------------------------------------------------------
// wire up logging listeners (forwarding above is untouched by these)
// --------------------------------------------------------------------------
const inSplitter = new LineSplitter((l, b) => logLine(l, b, 'in'));
const outSplitter = new LineSplitter((l, b) => logLine(l, b, 'out'));
const errSplitter = new LineSplitter((l) => writeRecord({ dir: 'err', payload: { stderr: l }, bytes: Buffer.byteLength(l) }));

process.stdin.on('data', (c: Buffer) => inSplitter.feed(c));
child.stdout!.on('data', (c: Buffer) => outSplitter.feed(c));
child.stderr!.on('data', (c: Buffer) => {
  process.stderr.write(c); // mirror so host MCP logs still show tracebacks
  errSplitter.feed(c);
});

// --------------------------------------------------------------------------
// lifecycle
// --------------------------------------------------------------------------
openSession();

child.on('exit', (code) => {
  writeFinalRecord({ event: 'session_end', exitCode: code });
  process.exit(code ?? 0);
});

let killTimer: ReturnType<typeof setTimeout> | undefined;
function shutdown(): void {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  killTimer ??= setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }, 3000);
  killTimer.unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// --------------------------------------------------------------------------
// auto-spawn the live-activity follower — once per session (fire-and-forget;
// failure never touches forwarding)
// --------------------------------------------------------------------------
function spawnFollower(target: SessionRef): void {
  const noActivity =
    process.env.HORATIO_NO_ACTIVITY === '1' || process.env.FLIGHTREC_NO_AUTODISTILL === '1';
  if (noActivity) return;
  try {
    const cliPath = fileURLToPath(new URL('./distill/cli.js', import.meta.url));
    if (fs.existsSync(cliPath)) {
      const logFd = fs.openSync(path.join(target.dir, 'distill.log'), 'a');
      spawn(process.execPath, [cliPath, 'watch', target.id], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      }).unref();
      fs.closeSync(logFd);
    }
  } catch (err) {
    console.error(`[horatio tap] follower auto-spawn failed (ignored): ${String(err)}`);
  }
}
