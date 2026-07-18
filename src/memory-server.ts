#!/usr/bin/env node
/**
 * Horatio memory server — serves accumulated memory back to agents.
 *
 *   "horatio-memory": { "command": "node", "args": [".../dist/memory-server.js"] }
 *
 * Memory is per Blender file. recall() resolves the file from (in order) an
 * explicit `file` arg, the live session's link, or the newest linked session —
 * never an ambient env var, never a stale config value, and it never silently
 * substitutes a different file's memory (design §8). All three tools are
 * read-only except log_decision, which only ever appends.
 *
 * stdout belongs to the MCP protocol; all diagnostics go to stderr.
 */
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadEnv } from './lib/nvidia.js';
import type { BlendMeta, DigestEvent, DigestRecord } from './lib/schema.js';
import {
  appendDecision,
  appendSessionDecision,
  contiguousOkCoverage,
  currentLiveSession,
  digestPath,
  listBlendMetas,
  MigrationNeededError,
  notePath,
  rawPath,
  readBlendMemory,
  readDecisions,
  readJsonl,
  readLink,
  readMemoryInfo,
  storeState,
  type SessionRef,
} from './lib/store.js';
import { listSessionsWithLinks } from './lib/blend-link.js';

loadEnv();

const server = new McpServer({ name: 'horatio-memory', version: '0.2.0' });

const MIGRATION_HINT =
  'Horatio found an older flightrec store that has not been migrated. Ask the user to run `horatio migrate` (or click Migrate in the Horatio app); memory is unavailable until then.';

function guardStore(): void {
  if (storeState() === 'v1') throw new MigrationNeededError('');
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

type Target =
  | { kind: 'blend'; meta: BlendMeta; liveSession?: SessionRef }
  | { kind: 'live-unlinked'; session: SessionRef }
  | { kind: 'ambiguous'; matches: BlendMeta[] }
  | { kind: 'none' };

function blendById(id: string): BlendMeta | undefined {
  return listBlendMetas().find((m) => m.id === id);
}

/** Match a file arg against known Blender files by path or name substring. */
function blendsByFileArg(file: string): BlendMeta[] {
  const q = file.toLowerCase();
  const metas = listBlendMetas();
  const exact = metas.filter((m) => m.blendPath && m.blendPath.toLowerCase() === q);
  if (exact.length) return exact;
  return metas.filter(
    (m) => m.name.toLowerCase().includes(q) || (m.blendPath && m.blendPath.toLowerCase().includes(q))
  );
}

function newestLinkedBlend(): BlendMeta | undefined {
  for (const s of listSessionsWithLinks()) {
    if (s.blendId) {
      const meta = blendById(s.blendId);
      if (meta) return meta;
    }
  }
  return undefined;
}

function resolveTarget(file?: string): Target {
  if (file && file.trim() !== '') {
    const matches = blendsByFileArg(file.trim());
    if (matches.length === 1) return { kind: 'blend', meta: matches[0] };
    if (matches.length > 1) return { kind: 'ambiguous', matches };
    return { kind: 'none' };
  }
  const live = currentLiveSession();
  if (live) {
    const link = readLink(live.dir);
    if (link) {
      const meta = blendById(link.blendId) ?? {
        id: link.blendId,
        blendPath: link.blendPath,
        name: link.blendPath ? link.blendPath.split('/').pop()! : link.blendId,
        createdAt: '',
        updatedAt: '',
      };
      return { kind: 'blend', meta, liveSession: live };
    }
    return { kind: 'live-unlinked', session: live };
  }
  const newest = newestLinkedBlend();
  if (newest) return { kind: 'blend', meta: newest };
  return { kind: 'none' };
}

function latestSessionForBlend(blendId: string): SessionRef | undefined {
  return listSessionsWithLinks().find((s) => s.blendId === blendId);
}

// ---------------------------------------------------------------------------
// freshness + activity
// ---------------------------------------------------------------------------

interface Freshness {
  coveredSeq: number;
  activitySeq: number; // last contiguous ok activity seq
  lastRawSeq: number;
  status: 'fresh' | 'stale' | 'missing';
}

/** Cheap tail read of raw.jsonl for the last seq. */
function lastRawSeq(sessionDir: string): number {
  const f = rawPath(sessionDir);
  try {
    const size = fs.statSync(f).size;
    const start = Math.max(0, size - 64 * 1024);
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim() !== '');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i]) as { seq?: number };
          if (typeof rec.seq === 'number') return rec.seq;
        } catch {
          /* keep scanning up */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* no raw */
  }
  return -1;
}

function freshnessFor(sessionDir: string): Freshness {
  const coveredSeq = readMemoryInfo(sessionDir)?.coveredSeq ?? -1;
  const activitySeq = contiguousOkCoverage(digestPath(sessionDir));
  const raw = lastRawSeq(sessionDir);
  const hasNote = fs.existsSync(notePath(sessionDir));
  const status: Freshness['status'] = !hasNote || coveredSeq < 0 ? 'missing' : coveredSeq >= activitySeq ? 'fresh' : 'stale';
  return { coveredSeq, activitySeq, lastRawSeq: raw, status };
}

const MAX_FALLBACK_EVENTS = 30;

/** Activity events past the covered seq, most recent last, capped. */
function activitySince(sessionDir: string, coveredSeq: number): { lines: string[]; extra: number } {
  const events = readJsonl(digestPath(sessionDir)).filter(
    (r): r is DigestEvent => (r as DigestEvent).kind === 'event' && Math.max(...(r as DigestEvent).src) > coveredSeq
  );
  const shown = events.slice(-MAX_FALLBACK_EVENTS);
  const lines = shown.map((e) => {
    const bits = [`[${e.type}]`, e.summary];
    if (e.tool) bits.push(`tool=${e.tool}`);
    if (e.error) bits.push(`error="${e.error.message}"`);
    return `- (${e.batch} src=${e.src.join(',')}) ${bits.join(' — ')}`;
  });
  return { lines, extra: Math.max(0, events.length - shown.length) };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

server.registerTool(
  'recall',
  {
    description:
      'Call this FIRST when starting Blender work. Returns Horatio’s accumulated memory for the Blender file you’re working on: durable file memory (object inventory, budgets, naming conventions, known failure modes), the decision log, and the latest session summary. Pass `file` (a .blend path or name) to load a specific file; otherwise it uses the live session’s file, or the most recently worked file. Session summaries are written automatically when a session ends (or press Update memory in Horatio / run `horatio update`).',
    inputSchema: {
      file: z
        .string()
        .optional()
        .describe('optional: a .blend path or file-name substring to load a specific Blender file’s memory'),
    },
  },
  async ({ file }) => {
    try {
      guardStore();
    } catch {
      return { content: [{ type: 'text', text: MIGRATION_HINT }] };
    }
    const target = resolveTarget(file);

    if (target.kind === 'ambiguous') {
      const list = target.matches.map((m) => `- ${m.name}${m.blendPath ? ` (${m.blendPath})` : ''}`).join('\n');
      return {
        content: [
          { type: 'text', text: `More than one Blender file matches "${file}". Pass a more specific \`file\`:\n${list}` },
        ],
      };
    }

    if (target.kind === 'none') {
      return {
        content: [
          {
            type: 'text',
            text: 'No Horatio memory yet — no recorded sessions for any Blender file. Work in Blender through a Horatio-wrapped MCP server and memory will accumulate.',
          },
        ],
      };
    }

    if (target.kind === 'live-unlinked') {
      const { lines, extra } = activitySince(target.session.dir, -1);
      const newest = newestLinkedBlend();
      const hint = newest
        ? `\nThe most recently worked file is **${newest.name}** — if that’s what’s open, call recall with \`file: "${newest.name}"\` to load its memory.`
        : '';
      return {
        content: [
          {
            type: 'text',
            text:
              `# Recording a live session — no Blender file identified yet\n\n` +
              `Horatio is recording, but hasn’t seen which .blend this session is working on, so there’s no durable file memory to load yet.${hint}\n\n` +
              `## Activity so far (${lines.length}${extra ? ` of ${lines.length + extra}` : ''} events)\n` +
              (lines.length ? lines.join('\n') : '_nothing recorded yet_'),
          },
        ],
      };
    }

    // Resolved to a specific Blender file.
    const meta = target.meta;
    const memory = stripEmbeddedDecisionLog(readBlendMemory(meta.id)).replace(
      /^#\s*File memory\s*\n+/i,
      ''
    );
    const decisions = readDecisions(meta.id);
    const latest = latestSessionForBlend(meta.id);

    let summaryBlock = '_no sessions recorded for this file yet_';
    let activityBlock = '';
    if (latest) {
      const fresh = freshnessFor(latest.dir);
      if (fresh.status === 'fresh') {
        summaryBlock = fs.readFileSync(notePath(latest.dir), 'utf8');
      } else if (fresh.status === 'stale') {
        summaryBlock =
          fs.readFileSync(notePath(latest.dir), 'utf8') +
          `\n\n> ⚠️ This summary covers activity through event ${fresh.coveredSeq}; ` +
          `${fresh.activitySeq - fresh.coveredSeq} newer event range(s) are not yet folded in.`;
        const { lines, extra } = activitySince(latest.dir, fresh.coveredSeq);
        activityBlock =
          `\n\n## Activity since the summary\n` +
          (lines.length ? lines.join('\n') : '_none_') +
          (extra ? `\n…and ${extra} earlier uncovered event(s) — use search_sessions for more.` : '');
      } else {
        summaryBlock =
          '_No session summary yet. Horatio writes one automatically when the session ends, ' +
          'or on Update memory. Recent activity below._';
        const { lines, extra } = activitySince(latest.dir, -1);
        activityBlock =
          `\n\n## Recent activity\n` +
          (lines.length ? lines.join('\n') : '_none_') +
          (extra ? `\n…and ${extra} earlier event(s) — use search_sessions for more.` : '');
      }
      if (fresh.lastRawSeq > fresh.activitySeq) {
        activityBlock += `\n\n_(The most recent moments are still being processed into activity.)_`;
      }
    }

    const decisionBlock =
      decisions.length > 0
        ? decisions.map((d) => `- ${d.ts} — ${d.text}`).join('\n')
        : '_no decisions logged yet_';

    const updatedWhen = readMemoryUpdatedWhen(meta.id);
    const text =
      `# File memory — ${meta.name}${updatedWhen ? ` (updated ${updatedWhen})` : ''}\n` +
      `${meta.blendPath ? `Blender file: \`${meta.blendPath}\`\n` : ''}\n` +
      `${memory.trim() === '' ? '_no durable memory recorded yet_' : memory}\n\n` +
      `## Decisions\n${decisionBlock}\n\n` +
      `## Latest session summary${latest ? ` — ${latest.id}` : ''}\n${summaryBlock}${activityBlock}`;
    return { content: [{ type: 'text', text }] };
  }
);

const MAX_HITS = 40;

server.registerTool(
  'search_sessions',
  {
    description:
      'Search every recorded Horatio session (summaries, activity events, file memory) for a substring — error messages, object names, tool names, parameter values. Returns matching lines with session and event citations.',
    inputSchema: { query: z.string().min(1).describe('substring to search for (case-insensitive)') },
  },
  async ({ query }) => {
    try {
      guardStore();
    } catch {
      return { content: [{ type: 'text', text: MIGRATION_HINT }] };
    }
    const q = query.toLowerCase();
    const hits: string[] = [];
    const sessions = listSessionsWithLinks();

    for (const meta of listBlendMetas()) {
      if (hits.length >= MAX_HITS) break;
      for (const line of readBlendMemory(meta.id).split('\n')) {
        if (hits.length >= MAX_HITS) break;
        if (line.toLowerCase().includes(q)) hits.push(`【${meta.name} memory】 ${line.trim()}`);
      }
    }

    for (const session of sessions) {
      if (hits.length >= MAX_HITS) break;
      const note = notePath(session.dir);
      if (fs.existsSync(note)) {
        for (const line of fs.readFileSync(note, 'utf8').split('\n')) {
          if (hits.length >= MAX_HITS) break;
          if (line.toLowerCase().includes(q)) hits.push(`【${session.id}】 ${line.trim()}`);
        }
      }
      for (const rec of readJsonl<DigestRecord>(digestPath(session.dir))) {
        if (hits.length >= MAX_HITS) break;
        if (rec.kind !== 'event') continue;
        const hay = [
          rec.summary,
          rec.tool ?? '',
          rec.error?.message ?? '',
          rec.error?.resolution ?? '',
          Object.entries(rec.params ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(' '),
        ]
          .join(' ')
          .toLowerCase();
        if (hay.includes(q)) {
          const err = rec.error ? ` — error="${rec.error.message}"` : '';
          hits.push(`【${session.id} ${rec.batch} src=${rec.src.join(',')}】 [${rec.type}] ${rec.summary}${err}`);
        }
      }
    }

    const text =
      hits.length === 0
        ? `No matches for "${query}" across ${sessions.length} session(s).`
        : hits.join('\n');
    return { content: [{ type: 'text', text }] };
  }
);

server.registerTool(
  'log_decision',
  {
    description:
      'Record a durable decision (budget, naming convention, approach choice, constraint) so future sessions on this Blender file inherit it. Pass `file` to target a specific .blend; otherwise it uses the live session’s file. If the live session’s file isn’t identified yet, the decision is queued on the session and merges into the file’s memory once the file is known.',
    inputSchema: {
      text: z.string().min(1).describe('the decision, stated concretely with exact values'),
      file: z.string().optional().describe('optional: a .blend path or name to attach the decision to'),
    },
  },
  async ({ text, file }) => {
    try {
      guardStore();
    } catch {
      return { content: [{ type: 'text', text: MIGRATION_HINT }] };
    }
    const target = resolveTarget(file);
    if (target.kind === 'blend') {
      const entry = appendDecision(target.meta.id, text);
      return { content: [{ type: 'text', text: `Logged to ${target.meta.name} memory (${entry.ts}): ${text}` }] };
    }
    if (target.kind === 'live-unlinked') {
      const entry = appendSessionDecision(target.session.dir, text);
      return {
        content: [
          {
            type: 'text',
            text: `Queued on the current session (${entry.ts}): ${text}\nIt will merge into the Blender file’s memory once Horatio identifies which .blend this session is working on.`,
          },
        ],
      };
    }
    if (target.kind === 'ambiguous') {
      const list = target.matches.map((m) => `- ${m.name}`).join('\n');
      return { content: [{ type: 'text', text: `More than one Blender file matches "${file}". Pass a more specific \`file\`:\n${list}` }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: 'No active Blender file to attach this decision to. Start a recorded session, or pass `file` with a .blend path or name.',
        },
      ],
    };
  }
);

function stripEmbeddedDecisionLog(memory: string): string {
  const at = memory.indexOf('## Decision log');
  if (at === -1) return memory;
  return memory.slice(0, at).trimEnd();
}

function readMemoryUpdatedWhen(blendId: string): string | undefined {
  const latest = latestSessionForBlend(blendId);
  if (!latest) return undefined;
  const info = readMemoryInfo(latest.dir);
  if (!info) return undefined;
  return humanWhen(info.updatedAt);
}

function humanWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[horatio memory] serving ${listSessionsWithLinks().length} session(s) across ${listBlendMetas().length} Blender file(s)`);
