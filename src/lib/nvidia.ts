/**
 * Nemotron client. OpenAI SDK against the NVIDIA integrate endpoint.
 *
 * Smoke-test findings (2026-07-18, verified live against the catalog):
 *  - Model ID: nvidia/nemotron-3-super-120b-a12b (120B hybrid MoE, 12B active, 1M ctx)
 *  - Reasoning is ON by default; disabled via BOTH a "/no_think" system-prompt
 *    prefix and chat_template_kwargs: { enable_thinking: false } (extra_body).
 *    With it off, content is direct ("ok"), no reasoning_content emitted.
 *  - response_format { type: "json_object" } IS supported and returns clean JSON.
 *  - Free tier: 40 requests/minute → single queue, 1600ms min spacing, no fan-out.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import OpenAI from 'openai';
import { defaultAppDataHome, envWithFallback, horatioHome } from './store.js';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';

const require = createRequire(import.meta.url);

export function modelId(): string {
  return envWithFallback('MODEL') ?? DEFAULT_MODEL_ID;
}

/** Manual .env parse — Electron's process.loadEnvFile can be missing/unreliable. */
function loadEnvFileManual(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * Load .env files (missing is fine). Order: app-data home, then repo root.
 * Does not override already-set env vars, so earlier wins: ambient → app-data → repo.
 */
export function loadEnv(): void {
  const tryLoad = (file: string) => {
    try {
      if (!fs.existsSync(file)) return;
      if (typeof process.loadEnvFile === 'function') {
        try {
          process.loadEnvFile(file);
          return;
        } catch {
          /* fall through to manual */
        }
      }
      loadEnvFileManual(file);
    } catch {
      /* ignore */
    }
  };
  try {
    const homeEnv = envWithFallback('HOME');
    const home = homeEnv ?? defaultAppDataHome();
    tryLoad(path.join(home, '.env'));
    const resolved = horatioHome();
    if (resolved !== home) tryLoad(path.join(resolved, '.env'));
  } catch {
    /* ignore */
  }
  try {
    const envPath = new URL('../../.env', import.meta.url);
    tryLoad(envPath.pathname);
  } catch {
    /* no repo .env */
  }
  const repoRoot = envWithFallback('REPO_ROOT');
  if (repoRoot) {
    tryLoad(path.join(repoRoot, '.env'));
  }
}

/** Accept the current global hook or the legacy one (desktop may bind either). */
function injectedFetch(): typeof fetch | undefined {
  const g = globalThis as { __horatioFetch?: typeof fetch; __flightrecFetch?: typeof fetch };
  return g.__horatioFetch ?? g.__flightrecFetch;
}

/** Electron's default fetch hangs for outbound HTTPS from main — use net.fetch. */
function electronFetch(): ((url: RequestInfo, init?: RequestInit) => Promise<Response>) | undefined {
  const injected = injectedFetch();
  const raw = injected
    ? (injected as typeof fetch)
    : (() => {
        if (!process.versions.electron) return undefined;
        try {
          const electron = require('electron') as {
            net?: { fetch: typeof fetch };
            default?: { net?: { fetch: typeof fetch } };
          };
          const net = electron.net ?? electron.default?.net;
          return net?.fetch ? (net.fetch.bind(net) as typeof fetch) : undefined;
        } catch {
          return undefined;
        }
      })();
  if (!raw) return undefined;

  // OpenAI SDK often passes a Request object; Electron net.fetch rejects that
  // with net::ERR_INVALID_ARGUMENT. Normalize to (url, init).
  return async (input: RequestInfo, init?: RequestInit) => {
    if (typeof input === 'string' || input instanceof URL) {
      return raw(input.toString(), init);
    }
    const req = input as Request;
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    let body = init?.body;
    if (body === undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      body = await req.text();
    }
    return raw(req.url, {
      method: init?.method ?? req.method,
      headers,
      body: body as BodyInit | undefined,
    });
  };
}

/** Desktop main injects Electron `net.fetch` so OpenAI SDK calls don't hang. */
export function setElectronFetch(fetchImpl: typeof fetch): void {
  (globalThis as { __horatioFetch?: typeof fetch }).__horatioFetch = fetchImpl;
  client = undefined;
}

let client: OpenAI | undefined;

export function getClient(): OpenAI {
  if (!client) {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) {
      throw new Error(
        'NVIDIA_API_KEY is not set. Add it in Horatio Preferences (or the Horatio .env) or export it in the environment.'
      );
    }
    const fetchImpl = electronFetch();
    client = new OpenAI({
      apiKey: key,
      baseURL: NVIDIA_BASE_URL,
      timeout: 90_000,
      ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
    });
  }
  return client;
}

/** Drop cached client (e.g. after API key change). */
export function resetClient(): void {
  client = undefined;
}

// ---------------------------------------------------------------------------
// Rate limiting (design §7). Two layers:
//  - Per process: all calls funnel through one promise chain, no parallelism.
//  - Cross process: a shared <home>/nemotron-last-call mtime coordinates the
//    tap follower, the desktop, and CLI runs against the one 40 req/min account.
// spaceCall() runs INSIDE the queue immediately before EVERY attempt (first try
// and each retry): it waits out the remaining spacing versus both the in-process
// clock and the shared file, then stamps both. clamp() tolerates clock steps.
// ---------------------------------------------------------------------------
const MIN_SPACING_MS = 1600; // 40 req/min = 1500ms floor + margin
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function spacingFile(): string | undefined {
  try {
    return path.join(horatioHome(), 'nemotron-last-call');
  } catch {
    return undefined;
  }
}

/** Wait until MIN_SPACING_MS has elapsed since the last call anywhere, then stamp. */
async function spaceCall(): Promise<void> {
  const now = Date.now();
  let waitInProc = lastCallAt + MIN_SPACING_MS - now;
  let waitCrossProc = 0;
  const file = spacingFile();
  if (file) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      waitCrossProc = clamp(mtime + MIN_SPACING_MS - now, 0, MIN_SPACING_MS);
    } catch {
      /* first call in this store — no wait */
    }
  }
  const wait = clamp(Math.max(waitInProc, waitCrossProc), 0, MIN_SPACING_MS);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, String(lastCallAt));
      fs.renameSync(tmp, file);
    } catch {
      /* best-effort — in-process spacing still holds */
    }
  }
}

export interface ChatOpts {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export function chat(opts: ChatOpts): Promise<string> {
  const run = queue.then(() => doChat(opts));
  // Keep the chain alive even when a call fails.
  queue = run.catch(() => {});
  return run;
}

async function doChat(opts: ChatOpts): Promise<string> {
  // Electron: OpenAI SDK + net.fetch → net::ERR_INVALID_ARGUMENT. Use a plain POST.
  const electronNetFetch = injectedFetch();
  if (electronNetFetch) {
    return doChatElectron(opts, electronNetFetch);
  }

  const backoffs = [2000, 4000, 8000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    await spaceCall();
    try {
      const res = await getClient().chat.completions.create({
        model: modelId(),
        messages: [
          // "/no_think" prefix + enable_thinking:false — both verified to
          // disable Nemotron reasoning; extraction wants direct output.
          { role: 'system', content: `/no_think\n${opts.system}` },
          { role: 'user', content: opts.user },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
        // @ts-expect-error NVIDIA NIM extension, passed through by the SDK
        chat_template_kwargs: { enable_thinking: false },
      });
      if (res.choices[0]?.finish_reason === 'length') {
        // Truncated output is unusable (invalid JSON) — surface it as a
        // distinct, non-retryable-here error so callers can raise the cap.
        const err = new Error(`output truncated at max_tokens=${opts.maxTokens ?? 4096}`) as Error & {
          status: number;
          truncated: boolean;
        };
        err.status = 422;
        err.truncated = true;
        throw err;
      }
      const content = res.choices[0]?.message?.content ?? '';
      return stripWrappers(content);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const retryable = status === 429 || (status !== undefined && status >= 500) || status === undefined;
      if (!retryable || attempt === backoffs.length) break;
      const retryAfter = Number(
        (err as { headers?: Record<string, string> }).headers?.['retry-after']
      );
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffs[attempt]);
    }
  }
  throw lastErr;
}

async function doChatElectron(opts: ChatOpts, fetchImpl: typeof fetch): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    throw new Error(
      'NVIDIA_API_KEY is not set. Put it in Preferences (or flightrec .env) or export it in the environment.'
    );
  }
  const backoffs = [2000, 4000, 8000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    await spaceCall();
    try {
      const res = await fetchImpl(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId(),
          messages: [
            { role: 'system', content: `/no_think\n${opts.system}` },
            { role: 'user', content: opts.user },
          ],
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 4096,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`NVIDIA API ${res.status}: ${text.slice(0, 200)}`) as Error & {
          status: number;
          retryAfter?: number;
        };
        err.status = res.status;
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
        throw err;
      }
      const parsed = JSON.parse(text) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
      };
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason === 'length') {
        const err = new Error(`output truncated at max_tokens=${opts.maxTokens ?? 4096}`) as Error & {
          status: number;
          truncated: boolean;
        };
        err.status = 422;
        err.truncated = true;
        throw err;
      }
      return stripWrappers(choice?.message?.content ?? '');
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const retryable = status === 429 || (status !== undefined && status >= 500) || status === undefined;
      if (!retryable || attempt === backoffs.length) break;
      const retryAfter = (err as { retryAfter?: number }).retryAfter;
      await sleep(retryAfter && retryAfter > 0 ? retryAfter * 1000 : backoffs[attempt]);
    }
  }
  throw lastErr;
}

/** Defensive: strip <think> blocks and markdown code fences if they ever appear. */
export function stripWrappers(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = out.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) out = fence[1].trim();
  return out;
}
