/**
 * horatio install / uninstall — wire the tap + memory server into MCP
 * client configs without hand-editing JSON.
 *
 *   horatio install                              # status
 *   horatio install --wrap blender               # bind to app-data store
 *   horatio install --wrap blender --local .     # override → <dir>/.horatio
 *   horatio uninstall                            # unwrap + remove memory server
 *
 * Clients:
 *  - claude-code:    via the `claude mcp` CLI (user scope)
 *  - claude-desktop: direct edit of claude_desktop_config.json
 *  - cursor:         direct edit of ~/.cursor/mcp.json
 *  - --config PATH:  direct edit of any mcpServers-shaped file
 *
 * Naming eras (design §9): new entries are written as `horatio-memory` with
 * HORATIO_HOME, but ALL matching (status / repair / uninstall / migrate)
 * accepts the legacy `flightrec-memory` name and FLIGHTREC_HOME binding so
 * pre-rename installs are always found and fixable. Wrapped-server detection
 * is name-agnostic (args[0] ends with tap.js) and therefore era-agnostic.
 *
 * Default store: platform app-data home. --project-dir / --local overrides to
 * <path>/.horatio (an existing <path>/.flightrec is reused as-is — we point
 * at it rather than fork a second store next to it).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  MigrationNeededError,
  ensureV2Home,
  envWithFallback,
  horatioHome,
  isProjectLocalHome,
  storeState,
} from './lib/store.js';

const TAP_PATH_DEFAULT = fileURLToPath(new URL('./tap.js', import.meta.url));
const MEMORY_PATH_DEFAULT = fileURLToPath(new URL('./memory-server.js', import.meta.url));
export const MEMORY_NAME = 'horatio-memory';
const LEGACY_MEMORY_NAME = 'flightrec-memory';
/** Every name a memory-server entry may carry; matching must use this, never MEMORY_NAME alone. */
export const MEMORY_NAMES: string[] = [MEMORY_NAME, LEGACY_MEMORY_NAME];

function tapPath(): string {
  return envWithFallback('TAP_PATH') ?? TAP_PATH_DEFAULT;
}

function memoryPath(): string {
  return envWithFallback('MEMORY_PATH') ?? MEMORY_PATH_DEFAULT;
}

/**
 * Absolute node binary for MCP configs.
 * Prefer HORATIO_NODE (set by the desktop app; FLIGHTREC_NODE fallback), then
 * runtime bin/node next to this install.js, then process.execPath / which node.
 */
function nodeExecutable(): string {
  const fromEnv = envWithFallback('NODE');
  if (fromEnv) return fromEnv;

  const sibling = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'node');
  if (fs.existsSync(sibling)) return sibling;
  const siblingWin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'node.exe');
  if (fs.existsSync(siblingWin)) return siblingWin;

  if (!process.versions.electron) return process.execPath;
  if (process.env.npm_node_execpath && process.env.npm_node_execpath.trim() !== '') {
    return process.env.npm_node_execpath;
  }
  try {
    return execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  } catch {
    return 'node';
  }
}

/**
 * Store home for new bindings. A v1 home is NOT a blocker here: binding a wrap
 * to it is safe (the tap records v2-shaped sessions anywhere, design §2) and
 * `horatio migrate` unifies later — install must never dead-end the user.
 */
function ensureStoreHome(): string {
  try {
    return ensureV2Home();
  } catch (err) {
    if (err instanceof MigrationNeededError) return horatioHome();
    throw err;
  }
}

/** <dir>/.horatio; an existing legacy <dir>/.flightrec is reused unchanged. */
function projectLocalStoreHome(dir: string): string {
  const base = path.resolve(dir);
  const preferred = path.join(base, '.horatio');
  const legacy = path.join(base, '.flightrec');
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) return legacy;
  return preferred;
}

export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [k: string]: unknown;
}
type ServerMap = Record<string, ServerEntry>;

export interface ClientInfo {
  id: 'claude-code' | 'claude-desktop' | 'cursor' | 'custom';
  label: string;
  configPath: string;
  viaClaudeCli: boolean;
  appProcessName?: string;
  servers: Array<{
    name: string;
    kind: 'http' | 'stdio';
    wrapped: boolean;
    isMemory: boolean;
    storeHome?: string;
  }>;
  error?: string;
}

export interface InstallStatus {
  storeHome: string;
  clients: ClientInfo[];
}

interface Client {
  id: 'claude-code' | 'claude-desktop' | 'cursor' | 'custom';
  label: string;
  configPath: string;
  viaClaudeCli: boolean;
  appProcessName?: string;
}

function detectClients(customConfig?: string): Client[] {
  const home = os.homedir();
  const clients: Client[] = [];
  if (customConfig) {
    clients.push({
      id: 'custom',
      label: `custom (${customConfig})`,
      configPath: path.resolve(customConfig),
      viaClaudeCli: false,
    });
    return clients;
  }
  const claudeCodeConfig = path.join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');
  if (fs.existsSync(claudeCodeConfig) || hasClaudeCli()) {
    clients.push({
      id: 'claude-code',
      label: 'Claude Code (user scope)',
      configPath: claudeCodeConfig,
      viaClaudeCli: hasClaudeCli(),
    });
  }
  const desktopConfig = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json'
  );
  if (process.platform === 'darwin' && fs.existsSync(desktopConfig)) {
    clients.push({
      id: 'claude-desktop',
      label: 'Claude Desktop',
      configPath: desktopConfig,
      viaClaudeCli: false,
      appProcessName: 'Claude',
    });
  }
  const cursorConfig = path.join(home, '.cursor', 'mcp.json');
  if (fs.existsSync(cursorConfig)) {
    clients.push({
      id: 'cursor',
      label: 'Cursor',
      configPath: cursorConfig,
      viaClaudeCli: false,
      appProcessName: 'Cursor',
    });
  }
  return clients;
}

let claudeCliChecked: boolean | undefined;
function hasClaudeCli(): boolean {
  if (claudeCliChecked === undefined) {
    try {
      execFileSync('claude', ['--version'], { stdio: 'ignore' });
      claudeCliChecked = true;
    } catch {
      claudeCliChecked = false;
    }
  }
  return claudeCliChecked;
}

/** Name-agnostic (and thus era-agnostic): any entry spawning our tap.js. */
function isWrapped(entry: ServerEntry): boolean {
  return (
    typeof entry.command === 'string' &&
    Array.isArray(entry.args) &&
    typeof entry.args[0] === 'string' &&
    entry.args[0].endsWith(`${path.sep}tap.js`) &&
    entry.args.includes('--')
  );
}

function wrapEntry(entry: ServerEntry, storeHome?: string): ServerEntry {
  return withStoreHome(
    {
      command: nodeExecutable(),
      args: [tapPath(), '--', entry.command!, ...(entry.args ?? [])],
      ...(entry.env ? { env: entry.env } : {}),
    },
    storeHome
  );
}

function unwrapEntry(entry: ServerEntry): ServerEntry {
  const args = entry.args ?? [];
  const sep = args.indexOf('--');
  const env = entry.env ? { ...entry.env } : undefined;
  if (env) {
    delete env.HORATIO_HOME;
    delete env.FLIGHTREC_HOME;
  }
  return {
    command: args[sep + 1],
    ...(args.length > sep + 2 ? { args: args.slice(sep + 2) } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  };
}

function memoryEntry(storeHome?: string): ServerEntry {
  return withStoreHome({ command: nodeExecutable(), args: [memoryPath()] }, storeHome);
}

/** New bindings write HORATIO_HOME; a stale FLIGHTREC_HOME is dropped so the entry has one binding. */
function withStoreHome(entry: ServerEntry, storeHome?: string): ServerEntry {
  if (!storeHome) return entry;
  const env = { ...(entry.env ?? {}) };
  delete env.FLIGHTREC_HOME;
  env.HORATIO_HOME = storeHome;
  return { ...entry, env };
}

/** The store an entry is bound to — HORATIO_HOME, falling back to legacy FLIGHTREC_HOME. */
function boundHome(entry: ServerEntry): string | undefined {
  for (const key of ['HORATIO_HOME', 'FLIGHTREC_HOME']) {
    const v = entry.env?.[key];
    if (v && v.trim() !== '') return v;
  }
  return undefined;
}

function readConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function writeConfigAtomic(file: string, config: Record<string, unknown>): void {
  const backup = `${file}.horatio-backup-${new Date().toISOString().replaceAll(':', '-')}`;
  let mode = 0o644;
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backup);
    mode = fs.statSync(file).mode & 0o777;
    console.log(`  backup: ${backup}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${file}.horatio-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

function claudeCli(args: string[]): void {
  execFileSync('claude', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function getServers(client: Client): ServerMap {
  const config = readConfig(client.configPath);
  return (config.mcpServers as ServerMap | undefined) ?? {};
}

function applyChanges(client: Client, changes: Map<string, ServerEntry | null>): void {
  if (changes.size === 0) return;
  if (client.viaClaudeCli) {
    const existing = getServers(client);
    for (const [name, entry] of changes) {
      if (existing[name]) claudeCli(['mcp', 'remove', name, '-s', 'user']);
      if (entry) claudeCli(['mcp', 'add-json', name, JSON.stringify(entry), '-s', 'user']);
    }
    return;
  }
  const config = readConfig(client.configPath);
  const servers = { ...((config.mcpServers as ServerMap | undefined) ?? {}) };
  for (const [name, entry] of changes) {
    if (entry) servers[name] = entry;
    else delete servers[name];
  }
  writeConfigAtomic(client.configPath, { ...config, mcpServers: servers });
}

function appRunning(client: Client): boolean {
  if (!client.appProcessName) return false;
  try {
    execFileSync('pgrep', ['-x', client.appProcessName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function clientToInfo(client: Client): ClientInfo {
  const info: ClientInfo = {
    id: client.id,
    label: client.label,
    configPath: client.configPath,
    viaClaudeCli: client.viaClaudeCli,
    appProcessName: client.appProcessName,
    servers: [],
  };
  try {
    const servers = getServers(client);
    for (const [name, s] of Object.entries(servers)) {
      info.servers.push({
        name,
        kind: s.url ? 'http' : 'stdio',
        wrapped: isWrapped(s),
        isMemory: MEMORY_NAMES.includes(name),
        storeHome: boundHome(s),
      });
    }
  } catch (err) {
    info.error = String(err);
  }
  return info;
}

/** Structured status for CLI and Electron. */
export function getInstallStatus(opts?: { client?: string; config?: string }): InstallStatus {
  let clients = detectClients(opts?.config);
  if (opts?.client && opts.client !== 'all') {
    clients = clients.filter((c) => c.id === opts.client);
  }
  return {
    storeHome: horatioHome(),
    clients: clients.map(clientToInfo),
  };
}

export interface WrapResult {
  ok: boolean;
  storeHome: string;
  lines: string[];
  restartHint: boolean;
}

/** Wrap named servers + register memory; defaults store to app-data home. */
export function wrapServers(
  wrapNames: string[],
  opts?: { client?: string; config?: string; storeHome?: string; projectDir?: string }
): WrapResult {
  let storeHome = opts?.storeHome;
  if (!storeHome && opts?.projectDir) {
    storeHome = projectLocalStoreHome(opts.projectDir);
  }
  if (!storeHome) storeHome = ensureStoreHome();
  else fs.mkdirSync(storeHome, { recursive: true });

  let clients = detectClients(opts?.config);
  if (opts?.client && opts.client !== 'all') {
    clients = clients.filter((c) => c.id === opts.client);
  }

  const lines: string[] = [];
  let wrappedAnywhere = false;
  let restartHint = false;

  for (const client of clients) {
    lines.push(`${client.label}:`);
    let servers: ServerMap;
    try {
      servers = getServers(client);
    } catch (err) {
      lines.push(`  skipped — could not parse ${client.configPath}: ${String(err)}`);
      continue;
    }
    try {
      const changes = new Map<string, ServerEntry | null>();
      for (const name of wrapNames) {
        const entry = servers[name];
        if (!entry) {
          lines.push(`  "${name}": not configured here, skipped`);
          continue;
        }
        if (isWrapped(entry)) {
          const updated = withStoreHome(entry, storeHome);
          if (JSON.stringify(updated) !== JSON.stringify(entry)) {
            changes.set(name, updated);
            lines.push(`  "${name}": store → ${storeHome}`);
          } else {
            lines.push(`  "${name}": already wrapped, skipped`);
          }
          wrappedAnywhere = true;
          continue;
        }
        if (!entry.command) {
          lines.push(`  "${name}": not a stdio server (url-based), cannot wrap, skipped`);
          continue;
        }
        changes.set(name, wrapEntry(entry, storeHome));
        lines.push(`  "${name}": wrapped → sessions recorded to ${storeHome}`);
        wrappedAnywhere = true;
      }
      // Registering always targets the new name; a legacy-named entry is
      // folded in (removed) so the memory server is never registered twice.
      if (servers[LEGACY_MEMORY_NAME]) {
        changes.set(LEGACY_MEMORY_NAME, null);
        lines.push(`  "${LEGACY_MEMORY_NAME}": renamed → "${MEMORY_NAME}"`);
      }
      const desiredMemory = memoryEntry(storeHome);
      const existingMemory = servers[MEMORY_NAME];
      if (existingMemory && JSON.stringify(existingMemory) === JSON.stringify(desiredMemory)) {
        lines.push(`  "${MEMORY_NAME}": already registered`);
      } else {
        changes.set(MEMORY_NAME, desiredMemory);
        lines.push(`  "${MEMORY_NAME}": registered → ${storeHome}`);
      }
      applyChanges(client, changes);
      if (changes.size > 0 && appRunning(client)) {
        restartHint = true;
        lines.push(`  ⚠ restart ${client.label} to pick up config`);
      }
    } catch (err) {
      lines.push(`  FAILED: ${String(err)}`);
    }
  }

  return {
    ok: wrapNames.length === 0 || wrappedAnywhere,
    storeHome,
    lines,
    restartHint,
  };
}

/** Force all wrapped servers + memory (either era's name) onto the store home. */
export function repairStoreHomes(opts?: {
  client?: string;
  config?: string;
  storeHome?: string;
}): WrapResult {
  const storeHome = opts?.storeHome ?? ensureStoreHome();
  fs.mkdirSync(storeHome, { recursive: true });

  let clients = detectClients(opts?.config);
  if (opts?.client && opts.client !== 'all') {
    clients = clients.filter((c) => c.id === opts.client);
  }

  const lines: string[] = [];
  let restartHint = false;
  let touched = false;

  for (const client of clients) {
    lines.push(`${client.label}:`);
    let servers: ServerMap;
    try {
      servers = getServers(client);
    } catch (err) {
      lines.push(`  skipped — could not parse ${client.configPath}: ${String(err)}`);
      continue;
    }
    try {
      const changes = new Map<string, ServerEntry | null>();
      for (const [name, entry] of Object.entries(servers)) {
        if (MEMORY_NAMES.includes(name) || isWrapped(entry)) {
          const current = boundHome(entry);
          // Repair fixes the binding under whatever name the entry has;
          // renaming legacy entries is migrateClientConfigs's job.
          const updated = MEMORY_NAMES.includes(name)
            ? memoryEntry(storeHome)
            : withStoreHome(entry, storeHome);
          if (JSON.stringify(updated) !== JSON.stringify(entry)) {
            changes.set(name, updated);
            lines.push(`  "${name}": ${current ?? '(unset)'} → ${storeHome}`);
            touched = true;
          } else {
            lines.push(`  "${name}": already → ${storeHome}`);
          }
        }
      }
      if (changes.size === 0) {
        lines.push('  nothing to repair');
      } else {
        applyChanges(client, changes);
        if (appRunning(client)) {
          restartHint = true;
          lines.push(`  ⚠ restart ${client.label} to pick up config`);
        }
      }
    } catch (err) {
      lines.push(`  FAILED: ${String(err)}`);
    }
  }

  return { ok: true, storeHome, lines, restartHint: restartHint || touched };
}

/**
 * One-time client-config half of `horatio migrate` (design §9.4): rename
 * legacy memory entries, swap FLIGHTREC_HOME → HORATIO_HOME, and refresh
 * tap/memory/node paths to the current runtime. Backups exactly as any other
 * config edit. Returns human-readable action lines.
 *
 * Bound-home rule: entries bound to a workspace `.horatio`/`.flightrec` keep
 * their store (only the env key is renamed) — repointing them at the app-data
 * home would orphan a store migrateStore never touched. Everything else is
 * pointed at the current resolved home.
 */
export function migrateClientConfigs(): string[] {
  const lines: string[] = [];
  const home = horatioHome();

  const targetHomeFor = (entry: ServerEntry): string => {
    const bound = boundHome(entry);
    if (bound && isProjectLocalHome(bound)) return bound;
    return home;
  };

  for (const client of detectClients()) {
    let servers: ServerMap;
    try {
      servers = getServers(client);
    } catch (err) {
      lines.push(`${client.id}: skipped — could not parse ${client.configPath}: ${String(err)}`);
      continue;
    }
    const changes = new Map<string, ServerEntry | null>();

    // Memory server: rename legacy → horatio-memory, preserving user extras
    // (env vars and unknown fields ride along); command/args are refreshed.
    const legacyMem = servers[LEGACY_MEMORY_NAME];
    const currentMem = servers[MEMORY_NAME];
    const baseMem = currentMem ?? legacyMem;
    if (baseMem) {
      const refreshed = withStoreHome(
        { ...baseMem, command: nodeExecutable(), args: [memoryPath()] },
        targetHomeFor(baseMem)
      );
      if (legacyMem) {
        changes.set(LEGACY_MEMORY_NAME, null);
        lines.push(
          currentMem
            ? `${client.id}: removed duplicate legacy memory server`
            : `${client.id}: renamed memory server`
        );
      }
      if (JSON.stringify(refreshed) !== JSON.stringify(currentMem)) {
        changes.set(MEMORY_NAME, refreshed);
        if (currentMem) lines.push(`${client.id}: updated memory server`);
      }
    }

    // Wrapped servers: refresh node + tap path, swap the env binding.
    for (const [name, entry] of Object.entries(servers)) {
      if (MEMORY_NAMES.includes(name) || !isWrapped(entry)) continue;
      const args = [...(entry.args ?? [])];
      args[0] = tapPath();
      const refreshed = withStoreHome(
        { ...entry, command: nodeExecutable(), args },
        targetHomeFor(entry)
      );
      if (JSON.stringify(refreshed) !== JSON.stringify(entry)) {
        changes.set(name, refreshed);
        lines.push(`${client.id}: updated recording for "${name}"`);
      }
    }

    if (changes.size === 0) {
      lines.push(`${client.id}: nothing to update`);
      continue;
    }
    try {
      applyChanges(client, changes);
      if (appRunning(client)) {
        lines.push(`${client.id}: restart ${client.label} to pick up the new configuration`);
      }
    } catch (err) {
      lines.push(`${client.id}: FAILED: ${String(err)}`);
    }
  }
  return lines;
}

/** Remove memory entries of either era and unwrap every tap, era-agnostic. */
export function uninstallAll(opts?: { client?: string; config?: string }): WrapResult {
  let clients = detectClients(opts?.config);
  if (opts?.client && opts.client !== 'all') {
    clients = clients.filter((c) => c.id === opts.client);
  }

  const lines: string[] = [];
  let restartHint = false;

  for (const client of clients) {
    lines.push(`${client.label}:`);
    let servers: ServerMap;
    try {
      servers = getServers(client);
    } catch (err) {
      lines.push(`  skipped — could not parse ${client.configPath}: ${String(err)}`);
      continue;
    }
    try {
      const changes = new Map<string, ServerEntry | null>();
      for (const [name, entry] of Object.entries(servers)) {
        if (MEMORY_NAMES.includes(name)) {
          changes.set(name, null);
          lines.push(`  "${name}": removed`);
        } else if (isWrapped(entry)) {
          changes.set(name, unwrapEntry(entry));
          lines.push(`  "${name}": unwrapped`);
        }
      }
      applyChanges(client, changes);
      if (changes.size === 0) lines.push('  nothing to undo');
      else if (appRunning(client)) {
        restartHint = true;
        lines.push(`  ⚠ restart ${client.label} to pick up config`);
      }
    } catch (err) {
      lines.push(`  FAILED: ${String(err)}`);
    }
  }

  return { ok: true, storeHome: horatioHome(), lines, restartHint };
}

function statusCli(clients: Client[]): void {
  if (clients.length === 0) {
    console.log('No MCP clients detected (Claude Code, Claude Desktop, Cursor).');
    return;
  }
  const home = horatioHome();
  console.log(`Store: ${home}`);
  if (storeState(home) === 'v1') {
    console.log('  (written by flightrec — run `horatio migrate` to upgrade it)');
  }
  console.log('\nDetected MCP clients:\n');
  for (const client of clients) {
    const info = clientToInfo(client);
    console.log(`${info.label}  —  ${info.configPath}`);
    if (info.error) {
      console.log(`  (could not parse config: ${info.error})\n`);
      continue;
    }
    if (info.servers.length === 0) console.log('  (no MCP servers configured)');
    for (const s of info.servers) {
      const mark = s.isMemory
        ? ' ← Horatio memory'
        : s.wrapped
          ? ' ← wrapped by Horatio'
          : '';
      const homeMark = s.storeHome ? ` [store: ${s.storeHome}]` : '';
      console.log(`  ${s.name} (${s.kind})${mark}${homeMark}`);
    }
    console.log('');
  }
  console.log('To record a server:   horatio install --wrap <server-name>');
  console.log('  (store override:     --local <path> → <path>/.horatio)');
  console.log('To undo everything:   horatio uninstall');
}

export function runInstaller(command: 'install' | 'uninstall', argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      wrap: { type: 'string', multiple: true },
      client: { type: 'string' },
      config: { type: 'string' },
      'project-dir': { type: 'string' },
      local: { type: 'string' },
      'repair-store': { type: 'boolean', default: false },
    },
  });

  let clients = detectClients(values.config);
  if (values.client && values.client !== 'all') {
    clients = clients.filter((c) => c.id === values.client);
    if (clients.length === 0) {
      console.error(
        `client "${values.client}" not detected (choose from: claude-code, claude-desktop, cursor, all)`
      );
      process.exit(1);
    }
  }

  if (command === 'uninstall') {
    const result = uninstallAll({
      client: values.client,
      config: values.config,
    });
    for (const line of result.lines) console.log(line);
    return;
  }

  if (values['repair-store']) {
    const result = repairStoreHomes({
      client: values.client,
      config: values.config,
    });
    for (const line of result.lines) console.log(line);
    console.log(`\nCanonical store: ${result.storeHome}`);
    if (result.restartHint) {
      console.log('Restart MCP clients (Cursor / Claude) so they pick up HORATIO_HOME.');
    }
    return;
  }

  if (!values.wrap || values.wrap.length === 0) {
    statusCli(clients);
    return;
  }

  const result = wrapServers(values.wrap, {
    client: values.client,
    config: values.config,
    projectDir: values['project-dir'] ?? values.local,
  });
  for (const line of result.lines) console.log(line);
  if (!result.ok) {
    console.log(`No client had a server named ${values.wrap.map((n) => `"${n}"`).join(', ')}.`);
    console.log('Run `horatio install` with no arguments to see what is configured where.');
    process.exitCode = 1;
  }
}
