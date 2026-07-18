/**
 * Store layout + JSONL I/O. node:* builtins only — tap.ts depends on this.
 *
 * $FLIGHTREC_HOME (default ~/.flightrec)/
 *   projects/<project>/
 *     project-state.md
 *     decisions.jsonl
 *     sessions/<ISO-timestamp>/
 *       raw.jsonl  digest.jsonl  note.md  artifacts/
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DecisionEntry } from './schema.js';

export const RAW_FILE = 'raw.jsonl';
export const DIGEST_FILE = 'digest.jsonl';
export const NOTE_FILE = 'note.md';
export const ARTIFACTS_DIR = 'artifacts';
export const STATE_FILE = 'project-state.md';
export const DECISIONS_FILE = 'decisions.jsonl';

export interface SessionRef {
  id: string;
  dir: string;
}

export function flightrecHome(): string {
  const h = process.env.FLIGHTREC_HOME;
  if (h && h.trim() !== '') return expandTilde(h.trim());
  return path.join(os.homedir(), '.flightrec');
}

export function projectName(): string {
  const p = process.env.FLIGHTREC_PROJECT;
  return p && p.trim() !== '' ? p.trim() : 'default';
}

export function projectDir(project?: string): string {
  return path.join(flightrecHome(), 'projects', project ?? projectName());
}

export function sessionsDir(project?: string): string {
  return path.join(projectDir(project), 'sessions');
}

/** ISO UTC timestamp with ':' → '-' so it's a valid dirname everywhere. */
export function sessionIdNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

export function newSessionDir(project?: string): SessionRef {
  let id = sessionIdNow();
  let dir = path.join(sessionsDir(project), id);
  // Two sessions in the same second: suffix rather than merge.
  for (let n = 2; fs.existsSync(dir); n++) {
    dir = path.join(sessionsDir(project), `${id}-${n}`);
    if (!fs.existsSync(dir)) id = `${id}-${n}`;
  }
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

/** Newest first — ISO ids sort lexicographically. */
export function listSessions(project?: string): SessionRef[] {
  const base = sessionsDir(project);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, dir: path.join(base, d.name) }))
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function latestSession(project?: string): SessionRef | undefined {
  return listSessions(project)[0];
}

/** 'latest' | session id | absolute/relative path → session dir (must exist). */
export function resolveSession(ref: string, project?: string): SessionRef {
  if (ref === 'latest') {
    const s = latestSession(project);
    if (!s) throw new Error(`no sessions found under ${sessionsDir(project)}`);
    return s;
  }
  const asId = path.join(sessionsDir(project), ref);
  if (fs.existsSync(asId)) return { id: ref, dir: asId };
  const asPath = path.resolve(ref);
  if (fs.existsSync(asPath)) return { id: path.basename(asPath), dir: asPath };
  throw new Error(`session not found: ${ref}`);
}

// ---------------------------------------------------------------------------
// JSONL + file helpers
// ---------------------------------------------------------------------------

export function appendJsonl(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

/** Tolerant reader: unparseable lines are skipped (warned to stderr), never fatal. */
export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      console.error(`[flightrec] skipping unparseable line in ${file}`);
    }
  }
  return out;
}

export function readProjectState(project?: string): string {
  const f = path.join(projectDir(project), STATE_FILE);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

/** Atomic write (tmp + rename); previous content saved to .bak. */
export function writeProjectState(content: string, project?: string): void {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, STATE_FILE);
  if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, f);
}

export function readDecisions(project?: string): DecisionEntry[] {
  return readJsonl<DecisionEntry>(path.join(projectDir(project), DECISIONS_FILE));
}

const DECISION_LOG_HEADER = '## Decision log';

/**
 * Journal the decision (source of truth — the one artifact not re-derivable
 * from raw.jsonl) and rewrite the Decision log section of project-state.md.
 */
export function appendDecision(text: string, project?: string): DecisionEntry {
  const entry: DecisionEntry = { ts: new Date().toISOString(), text, source: 'agent' };
  appendJsonl(path.join(projectDir(project), DECISIONS_FILE), entry);

  const state = readProjectState(project);
  const line = `- ${entry.ts} — ${text}`;
  let next: string;
  if (state.includes(DECISION_LOG_HEADER)) {
    // Append to the end of the existing section (before the next ## or EOF).
    const start = state.indexOf(DECISION_LOG_HEADER);
    const afterHeader = start + DECISION_LOG_HEADER.length;
    const nextSection = state.indexOf('\n## ', afterHeader);
    const insertAt = nextSection === -1 ? state.length : nextSection;
    next =
      state.slice(0, insertAt).replace(/\n*$/, '\n') + line + '\n' + state.slice(insertAt);
  } else {
    next = (state === '' ? `# Project state\n` : state.replace(/\n*$/, '\n')) +
      `\n${DECISION_LOG_HEADER}\n${line}\n`;
  }
  writeProjectState(next, project);
  return entry;
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
export function artifactsDir(sessionDir: string): string {
  return path.join(sessionDir, ARTIFACTS_DIR);
}

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}
