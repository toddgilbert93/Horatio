#!/usr/bin/env node
/**
 * horatio install [...]                    wire the tap + memory server into clients
 * horatio uninstall [...]                  remove Horatio from client configs
 * horatio migrate [--dry-run]              one-time v1 (flightrec) → v2 store migration
 * horatio watch   <session>                live activity — tail a session, auto-update memory
 * horatio update  [session]                write session summary + fold into file memory
 * horatio rebuild [session]                wipe activity, re-derive it, then update memory
 * horatio export-memory [session] [--out path] [--assemble]
 *
 * session = 'latest' (default) | session id | path to a session directory.
 *
 * Legacy aliases still work: `distill --follow|--save|--replay` map to
 * watch|update|rebuild.
 */
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/nvidia.js';
import { digestPath, MigrationNeededError, resolveSession } from '../lib/store.js';
import { runTier1 } from './tier1.js';
import { updateMemory } from './tier2.js';

const USAGE = `usage:
  horatio watch <session>              live activity feed (auto-updates memory at session end)
  horatio update [session]             write the session summary + fold into file memory
  horatio rebuild [session]            wipe activity, re-derive it, then update memory
  horatio export-memory [session] [--out <path>] [--assemble]
  horatio migrate [--dry-run]          one-time flightrec → Horatio store migration
  horatio install [--wrap <server>] [--project-dir <path>] [--client <name>|all] [--config <path>]
  horatio install --repair-store       point all wraps at the app-data store
  horatio uninstall [--client <name>|all] [--config <path>]

  session = latest (default) | session id | path to a session directory`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const argv = process.argv.slice(2);
const sub = argv[0];

// --- install / uninstall (delegate) ----------------------------------------
if (sub === 'install' || sub === 'uninstall') {
  const { runInstaller } = await import('../install.js');
  await runInstaller(sub, argv.slice(1));
  process.exit(process.exitCode ?? 0);
}

// --- migrate ----------------------------------------------------------------
if (sub === 'migrate') {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { 'dry-run': { type: 'boolean', default: false } },
  });
  const { migrateStore } = await import('../lib/migrate.js');
  const report = migrateStore({ dryRun: values['dry-run'] });
  for (const line of report.actions) console.error(`[horatio migrate] ${line}`);
  if (report.refusedLive?.length) {
    console.error('[horatio migrate] migration refused — active recordings present.');
    process.exit(1);
  }
  console.error(
    `[horatio migrate] ${report.dryRun ? 'DRY RUN — ' : ''}${report.sessionsMigrated} session(s), ` +
      `${report.blendsMigrated} Blender file(s), ${report.decisionsMerged} decision(s) merged, ` +
      `${report.parked.length} parked.`
  );
  // Rewriting the user's global client configs is only appropriate for a
  // default-store migration. A custom HORATIO_HOME (or FLIGHTREC_HOME) means a
  // targeted/test store — never repoint the user's live Claude/Cursor at it.
  const customHome =
    (process.env.HORATIO_HOME ?? process.env.FLIGHTREC_HOME ?? '').trim() !== '';
  if (!report.dryRun && report.sources.length > 0 && !customHome) {
    try {
      const { migrateClientConfigs } = await import('../install.js');
      for (const line of migrateClientConfigs()) console.error(`[horatio migrate] ${line}`);
      console.error('[horatio migrate] Restart Claude / Cursor so they pick up the new store.');
    } catch (err) {
      console.error(`[horatio migrate] client-config update skipped: ${String(err)}`);
    }
  } else if (customHome && !report.dryRun && report.sources.length > 0) {
    console.error('[horatio migrate] custom HORATIO_HOME set — left client configs untouched.');
  }
  process.exit(0);
}

// --- normalize legacy `distill --follow|--save|--replay [session]` ----------
let command: 'watch' | 'update' | 'rebuild' | 'export-memory' | undefined;
let rest = argv.slice(1);
if (sub === 'distill') {
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      follow: { type: 'boolean', default: false },
      save: { type: 'boolean', default: false },
      replay: { type: 'boolean', default: false },
    },
  });
  const modes = [values.follow, values.save, values.replay].filter(Boolean).length;
  if (modes !== 1) fail(USAGE);
  command = values.follow ? 'watch' : values.save ? 'update' : 'rebuild';
  rest = positionals;
} else if (sub === 'watch' || sub === 'update' || sub === 'rebuild' || sub === 'export-memory') {
  command = sub;
} else {
  fail(USAGE);
}

loadEnv();

// --- export-memory ----------------------------------------------------------
if (command === 'export-memory') {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { out: { type: 'string' }, assemble: { type: 'boolean', default: false } },
  });
  const { exportAgentMemory } = await import('./agent-memory.js');
  try {
    const session = resolveSession(positionals[0] ?? 'latest');
    console.error(`[horatio export-memory] ${session.dir}`);
    const result = await exportAgentMemory(session.dir, {
      outPath: values.out,
      assemble: values.assemble,
    });
    console.error(`[horatio export-memory] wrote ${result.sessionPath}`);
    if (result.blendPath) console.error(`[horatio export-memory] file memory copy ${result.blendPath}`);
    if (result.outPath) console.error(`[horatio export-memory] copied → ${result.outPath}`);
    process.stdout.write(result.markdown);
    process.exit(0);
  } catch (err) {
    if (err instanceof MigrationNeededError) fail(err.message);
    console.error(`[horatio export-memory] failed: ${String(err)}`);
    process.exit(1);
  }
}

// --- watch / update / rebuild ----------------------------------------------
let session;
try {
  session = resolveSession(rest[0] ?? 'latest');
} catch (err) {
  if (err instanceof MigrationNeededError) fail(err.message);
  throw err;
}
console.error(`[horatio ${command}] ${session.dir}`);

if (command === 'update') {
  try {
    const res = await updateMemory(session.dir, { trigger: 'manual' });
    console.error(
      res.skipped
        ? `[horatio update] ${res.reason ?? 'nothing to do'}`
        : `[horatio update] memory updated${res.sessionScoped ? ' (session summary only — no Blender file linked)' : ''}`
    );
    process.exit(0);
  } catch (err) {
    console.error(`[horatio update] failed: ${String(err)}`);
    process.exit(1);
  }
}

if (command === 'rebuild') {
  // Re-derivation: activity is disposable by design. A live follower holds the
  // lock — runTier1 will refuse rather than corrupt it.
  fs.rmSync(digestPath(session.dir), { force: true });
  // SIGINT mid-rebuild leaves the store half-derived — exit non-zero so scripts notice.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.error(`[horatio rebuild] ${sig} — aborting (store partially rebuilt; re-run rebuild)`);
      process.exit(130);
    });
  }
  try {
    await runTier1(session.dir, { follow: false });
    const res = await updateMemory(session.dir, { trigger: 'manual' });
    console.error(
      res.skipped ? `[horatio rebuild] activity rebuilt; ${res.reason}` : '[horatio rebuild] activity + memory rebuilt'
    );
    process.exit(0);
  } catch (err) {
    console.error(`[horatio rebuild] failed: ${String(err)}`);
    process.exit(1);
  }
}

// command === 'watch'
// A live follower digests until the tap ends; SIGTERM/SIGINT abort WITHOUT a
// model call or partial write (raw is truth; the next pass catches up).
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.error(`[horatio watch] ${sig} — exiting`);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}
try {
  const result = await runTier1(session.dir, { follow: true });
  console.error(
    `[horatio watch] done (${result.sawSessionEnd ? 'session_end' : result.endedViaDeadTap ? 'tap gone' : 'exit'})`
  );
  process.exit(0);
} catch (err) {
  console.error(`[horatio watch] failed: ${String(err)}`);
  process.exit(1);
}
