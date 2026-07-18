/**
 * File locks (design §7). node:* builtins only.
 *
 * Protocol: JSON `{pid, startedAt}` created with O_EXCL ('wx'). On EEXIST the
 * lock is STALE iff its pid is dead (ESRCH; EPERM counts as ALIVE) or the file
 * is older than 24h (pid-reuse backstop). Breaking a stale lock is an atomic
 * rename to `<lock>.stale-<ts>` — exactly one breaker wins the rename; the
 * loser's rename throws ENOENT and it simply retries acquisition.
 */
import * as fs from 'node:fs';
import { pidAlive } from './store.js';

export const DISTILL_LOCK = 'distill.lock';
export const SYNTH_LOCK = 'synth.lock';
export const MEMORY_LOCK = 'memory.lock';

const STALE_AGE_MS = 24 * 60 * 60 * 1000;

interface LockBody {
  pid: number;
  startedAt: string;
}

export interface LockHandle {
  file: string;
  release(): void;
}

export class LockHeldError extends Error {
  constructor(
    public file: string,
    public holderPid: number | undefined
  ) {
    super(`lock held${holderPid ? ` by pid ${holderPid}` : ''}: ${file}`);
    this.name = 'LockHeldError';
  }
}

function readLock(file: string): LockBody | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockBody;
  } catch {
    return undefined;
  }
}

function isStale(file: string): boolean {
  const body = readLock(file);
  if (body && typeof body.pid === 'number' && pidAlive(body.pid)) return false;
  if (!body) {
    // Unreadable lock: age alone decides.
    try {
      return Date.now() - fs.statSync(file).mtimeMs > 60_000;
    } catch {
      return false; // vanished — next acquire attempt settles it
    }
  }
  return true; // pid dead
}

function isExpired(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > STALE_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Try once to acquire. Returns a handle, or throws LockHeldError when a live
 * holder exists. Stale locks are broken (atomic rename) and retried.
 */
export function acquireLock(file: string): LockHandle {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(body) + '\n', { flag: 'wx' });
      return {
        file,
        release() {
          // Only remove a lock we still own (a breaker may have renamed ours).
          const cur = readLock(file);
          if (cur?.pid === process.pid) {
            try {
              fs.unlinkSync(file);
            } catch {
              /* ignore */
            }
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (isStale(file) || isExpired(file)) {
      try {
        fs.renameSync(file, `${file}.stale-${Date.now()}`);
      } catch {
        /* another breaker won — retry acquisition */
      }
      continue;
    }
    throw new LockHeldError(file, readLock(file)?.pid);
  }
  throw new LockHeldError(file, readLock(file)?.pid);
}

/** True when a LIVE (non-stale) holder currently has the lock. */
export function lockHeldByLiveProcess(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  return !isStale(file);
}

/**
 * Acquire, waiting up to `waitMs` for a live holder to finish (poll 500ms).
 */
export async function acquireLockWait(file: string, waitMs: number): Promise<LockHandle> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return acquireLock(file);
    } catch (err) {
      if (!(err instanceof LockHeldError) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function withLock<T>(
  file: string,
  waitMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const handle = await acquireLockWait(file, waitMs);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
