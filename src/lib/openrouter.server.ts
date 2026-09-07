/**
 * Text engine: MiniMax M3 (free) on OpenRouter.
 *
 * Replaces the old Gemini setup completely.
 *
 * Rules baked in here:
 *  - ONE model only: `minimax/minimax-m3:free`. The account has no credits, so
 *    a paid model must never be requested.
 *  - Keys are used ONE AT A TIME (never in parallel). Every call is queued, so
 *    two requests can never race the same key's rate limit.
 *  - When a key hits its DAILY free-model quota it is parked until the next
 *    UTC midnight and the pool automatically switches to the next key.
 *  - A short per-minute rate limit only parks the key for the delay asked for.
 */

import { openrouterKeys } from "./keys.server";

const API = "https://openrouter.ai/api/v1/chat/completions";

/** The only model this app is allowed to call. */
export const MODEL = "minimax/minimax-m3:free";

/**
 * Free models on OpenRouter allow ~20 requests/minute per key. A 3.5s gap per
 * key keeps us comfortably inside that without collecting 429s.
 */
const MIN_GAP_MS = 3_500;

type Slot = { exhaustedUntil: number; lastUsed: number };

const slots = new Map<string, Slot>();
/** Index of the key currently in use. */
let keyIdx = 0;
/** Global serialization: one request in flight at a time. */
let chain: Promise<unknown> = Promise.resolve();

function slotFor(key: string): Slot {
  let s = slots.get(key);
  if (!s) {
    s = { exhaustedUntil: 0, lastUsed: 0 };
    slots.set(key, s);
  }
  return s;
}

/** Next UTC midnight — when OpenRouter resets the free daily allowance. */
function nextDailyReset(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    5,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ChatOptions = {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Total attempts across keys before giving up. */
  attempts?: number;
};

/**
 * One text completion. Queued behind every other text call, so the active key
 * is never hit in parallel.
 */
export function openrouterChat(user: string, opts: ChatOptions = {}): Promise<string> {
  const run = chain.then(
    () => callOpenRouter(user, opts),
    () => callOpenRouter(user, opts),
  );
  chain = run.catch(() => undefined);
  return run;
}

async function callOpenRouter(user: string, opts: ChatOptions): Promise<string> {
  const keys = openrouterKeys();
  const attempts = opts.attempts ?? Math.max(10, keys.length * 3);
  let lastErr = "";

  for (let attempt = 0; attempt < attempts; attempt++) {
    let key = pickKey(keys);
    if (!key) {
      // Some keys may only be on a short cooldown — wait for the first one.
      const wait = earliestFree(keys) - Date.now();
      if (wait > 0 && wait <= 120_000) {
        await sleep(wait + 500);
        key = pickKey(keys);
      }
    }
    if (!key) {
      throw new Error(
        "Every OpenRouter key has used its daily free-model allowance. Try again after the daily reset (midnight UTC).",
      );
    }
    const slot = slotFor(key);

    const gap = MIN_GAP_MS - (Date.now() - slot.lastUsed);
    if (gap > 0) await sleep(gap);
    slot.lastUsed = Date.now();

    try {
      const res = await fetch(API, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://lovable.dev",
          "X-Title": "Script to Manga",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            ...(opts.system ? [{ role: "system", content: opts.system }] : []),
            { role: "user", content: user },
          ],
          temperature: opts.temperature ?? 0.7,
          max_tokens: opts.maxOutputTokens ?? 120_000,
        }),
      });

      if (res.ok) {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          error?: { message?: string; code?: number };
        };
        const text = (json.choices?.[0]?.message?.content ?? "").trim();
        if (text) {
          // Stay on this key: the pool only moves on when a key is parked
          // (daily quota, rate limit or a dead key), never after a good call.
          return text;
        }
        lastErr = json.error?.message ?? "empty completion";
        continue;

      }

      const body = (await res.text().catch(() => "")).slice(0, 600);
      lastErr = `${res.status} ${body}`;

      if (res.status === 429) {
        if (/per\s*day|daily|free-models-per-day/i.test(body)) {
          slot.exhaustedUntil = nextDailyReset();
        } else {
          const retryAfter = Number(res.headers.get("retry-after") ?? 0);
          slot.exhaustedUntil =
            Date.now() + Math.min(90_000, (retryAfter > 0 ? retryAfter : 20) * 1000 + 2000);
        }
        advanceKey(keys.length);
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 402) {
        // Dead / creditless key: park it for the day and move on.
        slot.exhaustedUntil = nextDailyReset();
        advanceKey(keys.length);
        continue;
      }
      if (res.status === 400) break; // bad request — retrying cannot help
      // 5xx / provider hiccup: brief backoff, next key.
      advanceKey(keys.length);
      await sleep(1200 * (attempt + 1));
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      advanceKey(keys.length);
      await sleep(800 * (attempt + 1));
    }
  }

  throw new Error(`MiniMax M3 request failed: ${lastErr}`);
}

/** First key that is not parked, starting from the active one. */
function pickKey(keys: string[]): string | null {
  const now = Date.now();
  for (let step = 0; step < keys.length; step++) {
    const i = (keyIdx + step) % keys.length;
    const key = keys[i] as string;
    if (slotFor(key).exhaustedUntil > now) continue;
    keyIdx = i;
    return key;
  }
  return null;
}

function advanceKey(total: number) {
  keyIdx = (keyIdx + 1) % total;
}

function earliestFree(keys: string[]): number {
  let soonest = Infinity;
  for (const key of keys) soonest = Math.min(soonest, slotFor(key).exhaustedUntil);
  return soonest;
}

export function engineStatus(): { model: string; keyIndex: number; keys: number } {
  const keys = openrouterKeys();
  return { model: MODEL, keyIndex: keyIdx + 1, keys: keys.length };
}
