#!/usr/bin/env node
/**
 * Horatio memory server — warm-starts agents from recorded MCP work.
 *
 *   "horatio-memory": { "command": "node", "args": [".../dist/memory-server.js"] }
 *
 * Session-first: recall resolves a Horatio session (live → latest → optional
 * session/file filter). The .blend is a tag on that session, not the primary
 * key. Tier-2 note/memory enrich when present; digests + decisions always work.
 *
 * stdout belongs to the MCP protocol; all diagnostics go to stderr.
 */
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadEnv } from './lib/nvidia.js';
import type { BlendMeta, DigestEvent, DigestRecord, LinkInfo, SessionInfo } from './lib/schema.js';
import {
  appendDecision,
  appendSessionDecision,
  decisionsPathForSession,
  digestPath,
  listBlendMetas,
  listLiveSessions,
  listSessions,
  MigrationNeededError,
  notePath,
  readBlendMemory,
  readBlendMeta,
  readDecisions,
  readDecisionsFile,
  readJsonl,
  readLink,
  readSessionInfo,
  readUserEvents,
  storeState,
  type SessionRef,
} from './lib/store.js';
import { listSessionsWithLinks } from './lib/blend-link.js';

loadEnv();

const server = new McpServer({ name: 'horatio-memory', version: '0.2.0' });

const MIGRATION_HINT =
  'Horatio found an older flightrec store that has not been migrated. Ask the user to run `horatio migrate` (or Migrate in Horatio Preferences); memory is unavailable until then.';

const MAX_ACTIVITY_EVENTS = 40;
const MAX_HITS = 40;

function guardStore(): void {
  if (storeState() === 'v1') throw new MigrationNeededError('');
}

// ---------------------------------------------------------------------------
// Session resolution (primary) — blend is a tag
// ---------------------------------------------------------------------------

type ResolvedSession = {
  session: SessionRef;
  info?: SessionInfo;
  link?: LinkInfo;
  blend?: BlendMeta;
  live: boolean;
};

type ResolveResult =
  | { kind: 'ok'; target: ResolvedSession }
  | { kind: 'ambiguous'; matches: Array<{ id: string; label: string }> }
  | { kind: 'none' };

function blendForLink(link: LinkInfo | undefined): BlendMeta | undefined {
  if (!link?.blendId) return undefined;
  return (
    readBlendMeta(link.blendId) ?? {
      id: link.blendId,
      blendPath: link.blendPath,
      name: link.blendPath ? link.blendPath.split('/').pop()! : link.blendId,
      createdAt: '',
      updatedAt: '',
    }
  );
}

function sessionLabel(info: SessionInfo | undefined, id: string): string {
  if (info?.title?.trim()) return info.title.trim();
  return humanizeSessionId(id);
}

function humanizeSessionId(id: string): string {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})[:-](\d{2})[:-](\d{2})/);
  if (!m) return id;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  if (Number.isNaN(d.getTime())) return id;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function hydrate(session: SessionRef, live: boolean): ResolvedSession {
  const info = readSessionInfo(session.dir);
  const link = readLink(session.dir);
  return { session, info, link, blend: blendForLink(link), live };
}

/** Match session arg against id (exact/prefix) or title substring. */
function sessionsByArg(arg: string): SessionRef[] {
  const q = arg.trim().toLowerCase();
  if (!q) return [];
  const all = listSessions();
  const exact = all.filter((s) => s.id.toLowerCase() === q);
  if (exact.length) return exact;
  const prefix = all.filter((s) => s.id.toLowerCase().startsWith(q));
  if (prefix.length) return prefix;
  return all.filter((s) => {
    const title = readSessionInfo(s.dir)?.title?.toLowerCase() ?? '';
    return title.includes(q);
  });
}

function blendsByFileArg(file: string): BlendMeta[] {
  const q = file.toLowerCase();
  const metas = listBlendMetas();
  const exact = metas.filter((m) => m.blendPath && m.blendPath.toLowerCase() === q);
  if (exact.length) return exact;
  return metas.filter(
    (m) => m.name.toLowerCase().includes(q) || (m.blendPath && m.blendPath.toLowerCase().includes(q))
  );
}

/**
 * Has this session distilled anything worth warm-starting from? A tap that
 * just booted holds a live pointer and a fresh raw.jsonl (handshake,
 * tools/list) but has nothing to say yet. Live pointers rank by raw.jsonl
 * mtime, so without this check a client that just opened resolves to its OWN
 * empty session — purely because it wrote last.
 */
function hasSubstance(session: SessionRef): boolean {
  try {
    return readJsonl<DigestRecord>(digestPath(session.dir)).some((r) => r.kind === 'event');
  } catch {
    return false;
  }
}

/** Ids of every live tap — several clients can be recording at once. */
function liveIds(): Set<string> {
  return new Set(listLiveSessions().map((s) => s.id));
}

/** Latest session tagged to a blend (listSessions is newest-first). */
function latestSessionForBlend(blendId: string): SessionRef | undefined {
  for (const s of listSessions()) {
    const link = readLink(s.dir);
    if (link?.blendId === blendId) return s;
  }
  return undefined;
}

/**
 * Resolve which session to warm-start from:
 *   explicit session → explicit file (latest session with that blend tag) →
 *   live tap → newest session overall.
 */
function resolveSession(opts: { session?: string; file?: string }): ResolveResult {
  if (opts.session && opts.session.trim() !== '') {
    const matches = sessionsByArg(opts.session);
    if (matches.length === 1) {
      return { kind: 'ok', target: hydrate(matches[0], liveIds().has(matches[0].id)) };
    }
    if (matches.length > 1) {
      return {
        kind: 'ambiguous',
        matches: matches.slice(0, 8).map((s) => ({
          id: s.id,
          label: sessionLabel(readSessionInfo(s.dir), s.id),
        })),
      };
    }
    return { kind: 'none' };
  }

  if (opts.file && opts.file.trim() !== '') {
    const blends = blendsByFileArg(opts.file.trim());
    if (blends.length > 1) {
      return {
        kind: 'ambiguous',
        matches: blends.map((m) => ({ id: m.id, label: m.name })),
      };
    }
    if (blends.length === 1) {
      // Any live tap tagged to this blend beats mtime order — a second client
      // recording elsewhere must not shadow the one actually on this file.
      const live = listLiveSessions().find((s) => readLink(s.dir)?.blendId === blends[0].id);
      if (live) return { kind: 'ok', target: hydrate(live, true) };

      const latest = latestSessionForBlend(blends[0].id);
      if (latest) return { kind: 'ok', target: hydrate(latest, false) };
      return { kind: 'none' };
    }
    return { kind: 'none' };
  }

  // Most recently active live tap that has actually distilled something. Skips
  // the just-booted-client case; falls through to history when every tap is new.
  const substantiveLive = listLiveSessions().find(hasSubstance);
  if (substantiveLive) return { kind: 'ok', target: hydrate(substantiveLive, true) };

  const all = listSessions();
  const newest = all.find(hasSubstance) ?? all[0];
  if (newest) return { kind: 'ok', target: hydrate(newest, liveIds().has(newest.id)) };

  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Activity + note helpers (tier2 optional)
// ---------------------------------------------------------------------------

function recentActivity(sessionDir: string): { lines: string[]; total: number } {
  const events = readJsonl(digestPath(sessionDir)).filter(
    (r): r is DigestEvent => (r as DigestEvent).kind === 'event'
  );
  const shown = events.slice(-MAX_ACTIVITY_EVENTS);
  const lines = shown.map((e) => {
    const bits = [`[${e.type}]`, e.summary];
    if (e.tool) bits.push(`tool=${e.tool}`);
    if (e.error) bits.push(`error="${e.error.message}"`);
    if (e.artifacts?.length) bits.push(`artifacts=${e.artifacts.join(',')}`);
    return `- ${bits.join(' — ')}`;
  });
  return { lines, total: events.length };
}

function mdSection(md: string, header: string): string {
  const idx = md.indexOf(header);
  if (idx === -1) return '';
  const start = idx + header.length;
  const next = md.indexOf('\n## ', start);
  return (next === -1 ? md.slice(start) : md.slice(start, next)).trim();
}

function orNone(body: string): string {
  return body.trim() === '' ? '_none recorded_' : body.trim();
}

function readNote(sessionDir: string): string {
  const f = notePath(sessionDir);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

const EPISTEMIC_BANNER =
  `> **Horatio memory is MCP-recorded history, not a live scene dump.** ` +
  `Use it for recent work, decisions, and open threads. ` +
  `Before editing objects, re-check the live scene with Blender MCP ` +
  `(\`get_scene_info\` / \`get_object_info\`).`;

/** Session-first recall: activity always; note/memory only as enrichment. */
function formatSessionRecall(target: ResolvedSession): string {
  const title = sessionLabel(target.info, target.session.id);
  const { lines, total } = recentActivity(target.session.dir);
  const noteMd = readNote(target.session.dir);

  const parts: string[] = [
    `# ${title}`,
    `Session: \`${target.session.id}\`${target.live ? ' · **live**' : ''}`,
  ];

  if (target.blend) {
    parts.push(
      `Blend tag: **${target.blend.name}**` +
        (target.blend.blendPath ? ` (\`${target.blend.blendPath}\`)` : '')
    );
  } else {
    parts.push(`Blend tag: _none yet_`);
  }

  parts.push('', EPISTEMIC_BANNER, '', `## Recent activity (${lines.length}${total > lines.length ? ` of ${total}` : ''})`);
  parts.push(lines.length ? lines.join('\n') : '_nothing recorded yet_');

  // Tier-2 enrichment — optional; never required for a useful recall.
  const openThreads = mdSection(noteMd, '## Open threads');
  const failures = mdSection(noteMd, '## Failures & fixes');
  const summary = mdSection(noteMd, '## Summary');

  if (summary || openThreads || failures) {
    parts.push('', `## From session note`);
    if (summary) {
      parts.push('', `### Summary`, summary);
    }
    if (openThreads) {
      parts.push('', `### Open threads`, openThreads);
    }
    if (failures) {
      parts.push('', `### Failures & fixes`, failures);
    }
  }

  // Durable layer on the blend tag (thin).
  if (target.blend) {
    const decisions = [
      ...readDecisions(target.blend.id),
      ...readDecisionsFile(decisionsPathForSession(target.session.dir)),
    ];
    // Dedup by ts+text
    const seen = new Set<string>();
    const unique = decisions.filter((d) => {
      const k = `${d.ts}|${d.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const memoryMd = stripEmbeddedDecisionLog(readBlendMemory(target.blend.id));
    const budgets = mdSection(memoryMd, '## Budgets & constraints');
    const naming = mdSection(memoryMd, '## Naming conventions');
    const knownFails = mdSection(memoryMd, '## Known failure modes');

    parts.push('', `## Durable decisions (${target.blend.name})`);
    parts.push(
      unique.length > 0
        ? unique.map((d) => `- ${d.ts} — ${d.text}`).join('\n')
        : '_no decisions logged yet_'
    );

    if (budgets || naming || knownFails) {
      parts.push('', `## Durable constraints (${target.blend.name})`);
      if (budgets) parts.push('', `### Budgets & constraints`, orNone(budgets));
      if (naming) parts.push('', `### Naming conventions`, orNone(naming));
      if (knownFails) parts.push('', `### Known failure modes`, orNone(knownFails));
    }

    // Hand edits (Blender addon) — verbatim, no causal claims: these say what
    // the human touched, never why. Agents must re-check the live scene.
    const userEvents = readUserEvents(target.blend.id, 15).filter((e) => e.kind !== 'meta');
    if (userEvents.length > 0) {
      parts.push('', `## Recent manual edits in Blender (${target.blend.name})`);
      parts.push(
        userEvents
          .map((e) => {
            if (e.kind === 'op') return `- ${e.ts} — ${e.name || e.op} (${e.op})`;
            const objs = (e.objects ?? [])
              .map((o) => {
                const what =
                  [o.transform && 'moved', o.geometry && 'edited'].filter(Boolean).join('+') ||
                  'changed';
                return `${o.name} ${what}${o.loc ? ` → (${o.loc.join(', ')})` : ''}`;
              })
              .join(', ');
            return `- ${e.ts} — ${objs}${e.dropped ? ` (+${e.dropped} more)` : ''}`;
          })
          .join('\n')
      );
    }
  } else {
    const sessionDecisions = readDecisionsFile(decisionsPathForSession(target.session.dir));
    if (sessionDecisions.length > 0) {
      parts.push('', `## Decisions (queued on this session — no blend tag yet)`);
      parts.push(sessionDecisions.map((d) => `- ${d.ts} — ${d.text}`).join('\n'));
    }
  }

  parts.push(
    '',
    `_Scene inventory is omitted — call Blender MCP to inspect the live scene._`
  );

  return parts.filter((p, i) => !(p === '' && i > 0 && parts[i - 1] === '')).join('\n');
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

server.registerTool(
  'recall',
  {
    description:
      'Call this FIRST when starting Blender work. Returns a session-first warm start: the live or latest Horatio session’s recent activity, optional session-note threads, and thin durable decisions for the session’s blend tag. This is MCP-recorded history — always re-check the live scene with Blender MCP before editing. Optional `session` (id or title) or `file` (.blend path/name → latest session with that tag).',
    inputSchema: {
      session: z
        .string()
        .optional()
        .describe('optional: Horatio session id or title substring'),
      file: z
        .string()
        .optional()
        .describe('optional: .blend path or name — uses the latest session tagged to that file'),
    },
  },
  async ({ session, file }) => {
    try {
      guardStore();
    } catch {
      return { content: [{ type: 'text', text: MIGRATION_HINT }] };
    }

    const resolved = resolveSession({ session, file });

    if (resolved.kind === 'ambiguous') {
      const list = resolved.matches.map((m) => `- ${m.label} (\`${m.id}\`)`).join('\n');
      const what = session ? `session "${session}"` : `file "${file}"`;
      return {
        content: [
          {
            type: 'text',
            text: `More than one match for ${what}. Pass a more specific \`session\` or \`file\`:\n${list}`,
          },
        ],
      };
    }

    if (resolved.kind === 'none') {
      const hint =
        session || file
          ? `No Horatio session matched${session ? ` session="${session}"` : ''}${file ? ` file="${file}"` : ''}.`
          : 'No Horatio sessions yet.';
      return {
        content: [
          {
            type: 'text',
            text:
              `${hint} Work in Blender through a Horatio-wrapped MCP server and sessions will appear. ` +
              `Then call recall again (no args uses the live or latest session).`,
          },
        ],
      };
    }

    return { content: [{ type: 'text', text: formatSessionRecall(resolved.target) }] };
  }
);

server.registerTool(
  'search_sessions',
  {
    description:
      'Search every recorded Horatio session (activity events, session notes, blend-tag memory) for a substring — error messages, object names, tool names, parameter values. Returns matching lines with session citations.',
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
      const label = sessionLabel(readSessionInfo(session.dir), session.id);
      const note = notePath(session.dir);
      if (fs.existsSync(note)) {
        for (const line of fs.readFileSync(note, 'utf8').split('\n')) {
          if (hits.length >= MAX_HITS) break;
          if (line.toLowerCase().includes(q)) hits.push(`【${label} / ${session.id}】 ${line.trim()}`);
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
          hits.push(`【${label} / ${session.id}】 [${rec.type}] ${rec.summary}${err}`);
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
      'Record a durable decision (budget, naming, approach, constraint). Attaches to the live session’s blend tag when known; otherwise queues on the live/latest session until a blend is tagged. Pass `file` to target a specific .blend, or `session` for a specific Horatio session.',
    inputSchema: {
      text: z.string().min(1).describe('the decision, stated concretely with exact values'),
      file: z.string().optional().describe('optional: .blend path or name to attach the decision to'),
      session: z.string().optional().describe('optional: Horatio session id or title'),
    },
  },
  async ({ text, file, session }) => {
    try {
      guardStore();
    } catch {
      return { content: [{ type: 'text', text: MIGRATION_HINT }] };
    }

    // Explicit file → blend journal (session-agnostic durable write).
    if (file && file.trim() !== '') {
      const blends = blendsByFileArg(file.trim());
      if (blends.length > 1) {
        const list = blends.map((m) => `- ${m.name}`).join('\n');
        return {
          content: [
            { type: 'text', text: `More than one Blender file matches "${file}". Pass a more specific \`file\`:\n${list}` },
          ],
        };
      }
      if (blends.length === 1) {
        const entry = appendDecision(blends[0].id, text);
        return {
          content: [{ type: 'text', text: `Logged to ${blends[0].name} (${entry.ts}): ${text}` }],
        };
      }
      return {
        content: [{ type: 'text', text: `No Blender file matched "${file}".` }],
      };
    }

    const resolved = resolveSession({ session });
    if (resolved.kind === 'ambiguous') {
      const list = resolved.matches.map((m) => `- ${m.label} (\`${m.id}\`)`).join('\n');
      return {
        content: [
          { type: 'text', text: `More than one session matched. Pass a more specific \`session\`:\n${list}` },
        ],
      };
    }
    if (resolved.kind === 'none') {
      return {
        content: [
          {
            type: 'text',
            text: 'No session to attach this decision to. Start a recorded Blender MCP session, or pass `file` / `session`.',
          },
        ],
      };
    }

    const target = resolved.target;
    if (target.blend) {
      const entry = appendDecision(target.blend.id, text);
      return {
        content: [
          {
            type: 'text',
            text: `Logged to ${target.blend.name} via session ${sessionLabel(target.info, target.session.id)} (${entry.ts}): ${text}`,
          },
        ],
      };
    }

    const entry = appendSessionDecision(target.session.dir, text);
    return {
      content: [
        {
          type: 'text',
          text:
            `Queued on session ${sessionLabel(target.info, target.session.id)} (${entry.ts}): ${text}\n` +
            `It will merge into the blend tag’s memory once Horatio links a .blend to this session.`,
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[horatio memory] session-first · ${listSessions().length} session(s) · ${listBlendMetas().length} blend tag(s)`
);
