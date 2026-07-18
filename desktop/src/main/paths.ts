/**
 * Resolve flightrec runtime (compiled dist + node_modules + bin/node).
 * Dev: <repo>/dist
 * Packaged: <App>.app/Contents/Resources/flightrec-runtime
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import electron from 'electron';

const e = (electron as unknown as { default?: typeof electron }).default ?? electron;
const { app } = e;

/** Repo root when running from desktop/out/main (dev). */
export const REPO_ROOT = join(__dirname, '../../..');

export function isPackaged(): boolean {
  try {
    return Boolean(app?.isPackaged);
  } catch {
    return false;
  }
}

/** Absolute path to the compiled runtime root (contains tap.js, lib/, bin/node). */
export function runtimeRoot(): string {
  if (isPackaged()) {
    return join(process.resourcesPath, 'flightrec-runtime');
  }
  // Dev: always use repo dist/ so `npm run build` is picked up immediately.
  // Staged resources/flightrec-runtime is only for electron-builder packaging.
  return join(REPO_ROOT, 'dist');
}

/** Bundled Node for MCP wrap + distill spawn. */
export function bundledNodePath(): string | undefined {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const p = join(runtimeRoot(), 'bin', name);
  return existsSync(p) ? p : undefined;
}

export function resolveNodeExecutable(): string {
  if (process.env.FLIGHTREC_NODE && process.env.FLIGHTREC_NODE.trim() !== '') {
    const preferred = process.env.FLIGHTREC_NODE.trim();
    // Never use the Electron binary as node — spawn hangs / misbehaves.
    if (!preferred.includes('Electron') && existsSync(preferred)) return preferred;
  }
  const bundled = bundledNodePath();
  if (bundled) return bundled;
  if (process.env.npm_node_execpath && existsSync(process.env.npm_node_execpath)) {
    return process.env.npm_node_execpath;
  }
  for (const candidate of ['/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    if (existsSync(candidate)) return candidate;
  }
  if (!process.versions.electron) return process.execPath;
  return 'node';
}

/** Apply env so install.js / distill find the same runtime the app is using. */
export function applyRuntimeEnv(): void {
  const root = runtimeRoot();
  process.env.FLIGHTREC_RUNTIME = root;
  process.env.FLIGHTREC_REPO_ROOT = REPO_ROOT;
  const node = resolveNodeExecutable();
  process.env.FLIGHTREC_NODE = node;
  const tap = join(root, 'tap.js');
  const memory = join(root, 'memory-server.js');
  if (existsSync(tap)) process.env.FLIGHTREC_TAP_PATH = tap;
  if (existsSync(memory)) process.env.FLIGHTREC_MEMORY_PATH = memory;
}

export async function loadDist<T>(rel: string): Promise<T> {
  const root = runtimeRoot();
  const file = join(root, rel);
  if (!existsSync(file)) {
    throw new Error(
      `Missing ${file}. ` +
        (isPackaged()
          ? 'Packaged runtime is incomplete — rebuild with npm run desktop:dist.'
          : 'Run `npm run build` in the flightrec repo root first.')
    );
  }
  return import(pathToFileURL(file).href) as Promise<T>;
}
