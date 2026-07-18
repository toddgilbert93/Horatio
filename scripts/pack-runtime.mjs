#!/usr/bin/env node
/**
 * Prepare desktop/resources/flightrec-runtime for electron-builder extraResources.
 *
 * Layout:
 *   flightrec-runtime/
 *     tap.js  memory-server.js  install.js  distill/  lib/  …
 *     package.json  node_modules/
 *     bin/node          (host Node binary, for MCP clients + distill)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const OUT = path.join(REPO, 'desktop', 'resources', 'flightrec-runtime');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function cpDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

console.log('[pack-runtime] building TypeScript…');
execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });

if (!fs.existsSync(path.join(DIST, 'tap.js'))) {
  console.error('[pack-runtime] dist/tap.js missing after build');
  process.exit(1);
}

console.log('[pack-runtime] staging', OUT);
rmrf(OUT);
cpDir(DIST, OUT);

const runtimePkg = {
  name: 'flightrec-runtime',
  version: ROOT_PKG.version,
  private: true,
  type: 'module',
  dependencies: ROOT_PKG.dependencies,
};
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');

console.log('[pack-runtime] npm install --omit=dev…');
execFileSync('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'], {
  cwd: OUT,
  stdio: 'inherit',
});

const binDir = path.join(OUT, 'bin');
fs.mkdirSync(binDir, { recursive: true });
let nodeSrc = process.execPath;
// Prefer a real node, not Electron, when this script is somehow run under Electron.
if (process.versions.electron) {
  try {
    nodeSrc = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('[pack-runtime] need a system node binary to bundle');
    process.exit(1);
  }
}
const nodeDest = path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
console.log('[pack-runtime] bundling node:', nodeSrc, '→', nodeDest);
fs.copyFileSync(nodeSrc, nodeDest);
fs.chmodSync(nodeDest, 0o755);

// Light marker for the app to detect a complete runtime
fs.writeFileSync(
  path.join(OUT, 'RUNTIME.json'),
  JSON.stringify(
    {
      version: ROOT_PKG.version,
      builtAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      host: os.hostname(),
    },
    null,
    2
  ) + '\n'
);

console.log('[pack-runtime] done');
