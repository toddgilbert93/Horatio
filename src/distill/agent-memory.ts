/**
 * Export a portable agent-memory.md — drop into a coding-agent project folder
 * (next to CLAUDE.md / AGENTS.md) so the next session warm-starts without MCP.
 *
 * Input: session summary + the Blender file's memory + activity events (never
 * raw). Default path: Nemotron rewrite into fixed agent-oriented sections.
 * --assemble / opts.assemble: deterministic concat (no LLM) for offline use.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chat } from '../lib/nvidia.js';
import type { DigestEvent, DigestRecord } from '../lib/schema.js';
import {
  AGENT_MEMORY_FILE,
  agentMemoryPath,
  atomicWrite,
  blendDir,
  contiguousOkCoverage,
  digestPath,
  noteExists,
  notePath,
  readBlendMemory,
  readBlendMeta,
  readJsonl,
  readLink,
  readMemoryInfo,
} from '../lib/store.js';
import {
  AGENT_MEMORY_SECTIONS,
  AGENT_MEMORY_SYSTEM,
  buildAgentMemoryUser,
} from './prompts.js';
import { ensureDistilled } from './tier2.js';

export interface AgentMemoryResult {
  markdown: string;
  sessionPath: string;
  /** Written beside the Blender file's memory.md when the session is linked. */
  blendPath?: string;
  outPath?: string;
}

export async function exportAgentMemory(
  sessionDir: string,
  opts: {
    /** Write a copy to this path (e.g. ~/my-blender-project/horatio-memory.md). */
    outPath?: string;
    /** Skip Nemotron; assemble from summary + memory mechanically. */
    assemble?: boolean;
    /** Ensure activity/summary exist before export (default true). */
    ensureNote?: boolean;
  } = {}
): Promise<AgentMemoryResult> {
  const ensureNote = opts.ensureNote !== false;
  if (ensureNote && !opts.assemble) {
    await ensureDistilled(sessionDir);
    if (!noteExists(sessionDir)) {
      throw new Error('No session summary yet — press Update memory in Horatio (or run `horatio update`) first');
    }
  }

  const sessionId = path.basename(sessionDir);
  const link = readLink(sessionDir);
  const meta = link ? readBlendMeta(link.blendId) : undefined;
  const fileName = meta?.name ?? (link ? link.blendId : '(no Blender file linked)');
  const noteMd = fs.existsSync(notePath(sessionDir)) ? fs.readFileSync(notePath(sessionDir), 'utf8') : '';
  const fileMemory = link ? readBlendMemory(link.blendId) : '';
  const events = readJsonl<DigestRecord>(digestPath(sessionDir)).filter(
    (r): r is DigestEvent => r.kind === 'event'
  );

  let body: string;
  if (opts.assemble || !process.env.NVIDIA_API_KEY) {
    body = assembleAgentMemory({ sessionId, fileName, noteMd, fileMemory, events });
  } else {
    body = await synthesizeAgentMemory({ sessionId, fileName, noteMd, fileMemory, events });
  }

  const stale = stalenessNotice(sessionDir);
  const markdown =
    `# Horatio agent memory\n\n` +
    `> Portable warm-start brief for coding agents. Place this file in your agent project ` +
    `(e.g. next to \`CLAUDE.md\` / \`AGENTS.md\`) or paste into context.\n` +
    `> Blender file: \`${fileName}\` · Latest session: \`${sessionId}\` · Generated: ${new Date().toISOString()}\n` +
    `> Grounded in durable file memory and the latest work session. Do not invent beyond this file.\n` +
    (stale ? `>\n> ⚠️ ${stale}\n` : '') +
    `\n` +
    body.trim() +
    '\n';

  const sessionFile = agentMemoryPath(sessionDir);
  atomicWrite(sessionFile, markdown);

  let blendPath: string | undefined;
  if (link) {
    blendPath = path.join(blendDir(link.blendId), AGENT_MEMORY_FILE);
    atomicWrite(blendPath, markdown);
  }

  let outPath = opts.outPath;
  if (outPath) {
    outPath = path.resolve(outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown);
  }

  return { markdown, sessionPath: sessionFile, blendPath, outPath };
}

/** One-line notice when the summary trails the recorded activity. */
function stalenessNotice(sessionDir: string): string | undefined {
  const covered = readMemoryInfo(sessionDir)?.coveredSeq ?? -1;
  const activity = contiguousOkCoverage(digestPath(sessionDir));
  if (activity > covered) {
    return `This brief may be behind: ${activity - covered} recorded activity event range(s) are not yet in the session summary. Run \`horatio update\` to refresh.`;
  }
  return undefined;
}

async function synthesizeAgentMemory(args: {
  sessionId: string;
  fileName: string;
  noteMd: string;
  fileMemory: string;
  events: DigestEvent[];
}): Promise<string> {
  const user = buildAgentMemoryUser(args);
  let raw: string;
  try {
    raw = await chat({ system: AGENT_MEMORY_SYSTEM, user, json: true, maxTokens: 4096 });
  } catch (err) {
    if (!(err as { truncated?: boolean }).truncated) throw err;
    raw = await chat({ system: AGENT_MEMORY_SYSTEM, user, json: true, maxTokens: 8192 });
  }
  const parsed = JSON.parse(raw) as { memory_md?: string };
  return enforceAgentSections((parsed.memory_md ?? '').trim());
}

/** Offline / no-key path: map existing summary + memory into the agent sections. */
export function assembleAgentMemory(args: {
  sessionId: string;
  fileName: string;
  noteMd: string;
  fileMemory: string;
  events: DigestEvent[];
}): string {
  const section = (md: string, header: string): string => {
    const idx = md.indexOf(header);
    if (idx === -1) return '_none recorded_';
    const start = idx + header.length;
    const next = md.indexOf('\n## ', start);
    const body = (next === -1 ? md.slice(start) : md.slice(start, next)).trim();
    return body === '' ? '_none recorded_' : body;
  };

  const summary = section(args.noteMd, '## Summary');
  const scene = section(args.noteMd, '## Scene changes');
  const decisions = section(args.noteMd, '## Decisions');
  const failures = section(args.noteMd, '## Failures & fixes');
  const threads = section(args.noteMd, '## Open threads');

  const inventory = section(args.fileMemory, '## Object inventory');
  const budgets = section(args.fileMemory, '## Budgets & constraints');
  const naming = section(args.fileMemory, '## Naming conventions');
  const knownFails = section(args.fileMemory, '## Known failure modes');
  const decisionLog = section(args.fileMemory, '## Decision log');

  const exactFromEvents = args.events
    .filter((e) => e.params && Object.keys(e.params).length > 0)
    .map((e) => `- (${e.batch}) ${JSON.stringify(e.params)}`)
    .slice(0, 40);

  const durable = [
    budgets !== '_none recorded_' ? budgets : '',
    naming !== '_none recorded_' ? naming : '',
    decisionLog !== '_none recorded_' ? `### Decision log\n${decisionLog}` : '',
    decisions !== '_none recorded_' ? `### This session\n${decisions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const fails = [
    failures !== '_none recorded_' ? failures : '',
    knownFails !== '_none recorded_' ? `### Known failure modes\n${knownFails}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    `## Start here\n${summary}`,
    `## Durable constraints\n${durable || '_none recorded_'}`,
    `## Scene & inventory\n${inventory !== '_none recorded_' ? inventory : scene}`,
    `## What happened this session\n${summary}${scene !== '_none recorded_' ? `\n\n### Scene changes\n${scene}` : ''}`,
    `## Failures to avoid\n${fails || '_none recorded_'}`,
    `## Open threads — continue from here\n${threads}`,
    `## Exact values\n${exactFromEvents.length > 0 ? exactFromEvents.join('\n') : '_none recorded_'}`,
  ].join('\n\n');
}

function enforceAgentSections(body: string): string {
  let out = body;
  for (const marker of ['\n# Horatio', '\n# File memory', '\n# Project state']) {
    const at = out.indexOf(marker);
    if (at !== -1) out = out.slice(0, at).trimEnd();
  }
  for (const header of AGENT_MEMORY_SECTIONS) {
    if (!out.includes(header)) out += `\n\n${header}\n_none recorded_`;
  }
  return out;
}
