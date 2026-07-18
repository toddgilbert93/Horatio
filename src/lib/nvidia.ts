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
import OpenAI from 'openai';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';

export function modelId(): string {
  return process.env.FLIGHTREC_MODEL ?? DEFAULT_MODEL_ID;
}

/** Load .env from the repo root (dist/lib/nvidia.js → ../../.env). Missing file is fine. */
export function loadEnv(): void {
  try {
    const envPath = new URL('../../.env', import.meta.url);
    process.loadEnvFile(envPath.pathname);
  } catch {
    /* no .env — rely on ambient environment */
  }
}

let client: OpenAI | undefined;

export function getClient(): OpenAI {
  if (!client) {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) {
      throw new Error(
        'NVIDIA_API_KEY is not set. Put it in the flightrec .env or export it in the environment.'
      );
    }
    client = new OpenAI({ apiKey: key, baseURL: NVIDIA_BASE_URL });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Single-file rate limiting: all Nemotron calls in a process funnel through
// one promise chain with minimum spacing. No parallel calls anywhere (spec).
// ---------------------------------------------------------------------------
const MIN_SPACING_MS = 1600; // 40 req/min = 1500ms floor + margin
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const wait = lastCallAt + MIN_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);

  const backoffs = [2000, 4000, 8000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    lastCallAt = Date.now();
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

/** Defensive: strip <think> blocks and markdown code fences if they ever appear. */
export function stripWrappers(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = out.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) out = fence[1].trim();
  return out;
}
