#!/usr/bin/env node
/**
 * flightrec distill --follow [session]   tail a live session
 * flightrec distill --replay [session]   re-derive digest + note from offset 0
 *
 * session = 'latest' (default) | session id | path to a session directory.
 * Same pipeline either way — replay is the re-derivability invariant as a command.
 */
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/nvidia.js';
import { digestPath, resolveSession } from '../lib/store.js';
import { runTier1 } from './tier1.js';
import { synthesizeSession } from './tier2.js';

loadEnv();

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    follow: { type: 'boolean', default: false },
    replay: { type: 'boolean', default: false },
  },
});

const [command, sessionRef = 'latest'] = positionals;
if (command !== 'distill' || values.follow === values.replay) {
  console.error('usage: flightrec distill (--follow | --replay) [session]');
  process.exit(2);
}

const session = resolveSession(sessionRef);
console.error(`[flightrec distill] ${values.replay ? 'replay' : 'follow'} ${session.dir}`);

if (values.replay) {
  // Re-derivation: downstream is disposable by design.
  fs.rmSync(digestPath(session.dir), { force: true });
}

let finalizing = false;
async function finalize(reason: string): Promise<void> {
  if (finalizing) return;
  finalizing = true;
  try {
    console.error(`[flightrec distill] synthesizing session note (${reason})`);
    await synthesizeSession(session.dir);
    console.error('[flightrec distill] note.md + project-state.md written');
  } catch (err) {
    console.error(`[flightrec distill] tier2 failed (lazy recall() will retry): ${String(err)}`);
  }
}

// Manual-terminal case: Ctrl-C should still try to leave a note behind.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void finalize(sig).then(() => process.exit(0));
  });
}

const result = await runTier1(session.dir, { follow: values.follow });
// Every exit path synthesizes: session_end marker, explicit replay, or the
// follow-mode dead-tap fallback (stream only ends in follow mode when the tap
// is gone and the log has been quiet for 5 minutes).
await finalize(
  result.sawSessionEnd ? 'session_end' : values.replay ? 'replay' : 'tap_dead'
);
process.exit(0);
