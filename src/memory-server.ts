#!/usr/bin/env node
/**
 * flightrec memory server — serves accumulated project memory back to agents.
 *
 *   "flightrec-memory": { "command": "node", "args": [".../dist/memory-server.js"] }
 *
 * Three tools: recall, search_sessions, log_decision.
 * stdout belongs to the MCP protocol; all diagnostics go to stderr.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadEnv } from './lib/nvidia.js';
import type { DigestRecord, RawRecord } from './lib/schema.js';
import {
  appendDecision,
  digestPath,
  listSessions,
  latestSession,
  notePath,
  noteExists,
  projectName,
  rawPath,
  readJsonl,
  readProjectState,
} from './lib/store.js';
import { ensureDistilled, synthesizeSession } from './distill/tier2.js';

loadEnv();

const server = new McpServer({ name: 'flightrec-memory', version: '0.1.0' });

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

/** A session is live while its tap process is still alive. */
function sessionIsLive(sessionDir: string): boolean {
  const records = readJsonl<RawRecord>(rawPath(sessionDir));
  if (records.length === 0) return false;
  const last = records[records.length - 1];
  if (last.dir === 'meta' && last.meta?.event === 'session_end') return false;
  const start = records.find((r) => r.meta?.event === 'session_start');
  const pid = start?.meta?.tapPid;
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Serialize lazy synthesis so concurrent recalls don't double-spend the API.
let synthesisLock: Promise<unknown> = Promise.resolve();

server.registerTool(
  'recall',
  {
    description:
      'Call this first when starting work on this project. Returns accumulated project memory: durable project state (object inventory, budgets, naming conventions, known failure modes, decision log) and the latest work session’s notes. Warm-starts you with everything previous sessions learned.',
    inputSchema: {},
  },
  async () => {
    const state = readProjectState();
    const latest = latestSession();
    let noteBlock = '_no sessions recorded yet_';
    let sessionLabel = '';

    if (latest) {
      sessionLabel = latest.id;
      if (noteExists(latest.dir)) {
        noteBlock = fs.readFileSync(notePath(latest.dir), 'utf8');
      } else {
        // Lazy synthesis — the non-optional fallback for sessions whose
        // exit-time distillation never ran.
        const live = sessionIsLive(latest.dir);
        try {
          const run: Promise<{ noteMd: string }> = synthesisLock.then(async () => {
            if (!live && noteExists(latest.dir)) {
              return { noteMd: fs.readFileSync(notePath(latest.dir), 'utf8') };
            }
            await ensureDistilled(latest.dir);
            // Live session: synthesize an interim note but do NOT write
            // note.md — that would suppress the real end-of-session run.
            return synthesizeSession(latest.dir, { dryRun: live });
          });
          synthesisLock = run.catch(() => {});
          const result = await run;
          noteBlock = live
            ? `_(interim note — session still in progress)_\n\n${result.noteMd}`
            : result.noteMd;
        } catch (err) {
          console.error(`[flightrec memory] lazy synthesis failed: ${String(err)}`);
          noteBlock = `_session note unavailable (synthesis failed: ${String(
            (err as Error).message ?? err
          )}). Raw session data is intact; try again later._`;
        }
      }
    }

    const text = `# Project memory: ${projectName()}

## Durable project state
${state.trim() === '' ? '_no project state recorded yet_' : state}

## Latest session${sessionLabel ? ` (${sessionLabel})` : ''}
${noteBlock}`;
    return { content: [{ type: 'text', text }] };
  }
);

// ---------------------------------------------------------------------------
// search_sessions — substring scan, deliberately no embeddings
// ---------------------------------------------------------------------------

const MAX_HITS = 40;

server.registerTool(
  'search_sessions',
  {
    description:
      'Search all recorded work sessions (notes, digest events, project state) for a substring — error messages, object names, tool names, parameter values. Returns matching lines with session and batch citations.',
    inputSchema: { query: z.string().min(1).describe('substring to search for (case-insensitive)') },
  },
  async ({ query }) => {
    const q = query.toLowerCase();
    const hits: string[] = [];

    const state = readProjectState();
    for (const line of state.split('\n')) {
      if (hits.length >= MAX_HITS) break;
      if (line.toLowerCase().includes(q)) hits.push(`【project-state】 ${line.trim()}`);
    }

    for (const session of listSessions()) {
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
          hits.push(
            `【${session.id} ${rec.batch} src=${rec.src.join(',')}】 [${rec.type}] ${rec.summary}${err}`
          );
        }
      }
    }

    const text =
      hits.length === 0
        ? `No matches for "${query}" across ${listSessions().length} session(s).`
        : hits.join('\n');
    return { content: [{ type: 'text', text }] };
  }
);

// ---------------------------------------------------------------------------
// log_decision — memory is bidirectional
// ---------------------------------------------------------------------------

server.registerTool(
  'log_decision',
  {
    description:
      'Record a durable project decision (budget, naming convention, approach choice, constraint) so future sessions inherit it. Use for commitments that should outlive this conversation.',
    inputSchema: { text: z.string().min(1).describe('the decision, stated concretely with exact values') },
  },
  async ({ text }) => {
    const entry = appendDecision(text);
    return {
      content: [
        { type: 'text', text: `Logged to project memory (${entry.ts}): ${text}` },
      ],
    };
  }
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[flightrec memory] serving project "${projectName()}" (${listSessions().length} session(s), state: ${
    readProjectState() === '' ? 'empty' : path.basename(projectName())
  })`
);
