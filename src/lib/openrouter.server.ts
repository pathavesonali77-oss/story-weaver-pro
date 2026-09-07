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

type Slot = { exhaustedUntil: number; lastUsed: number; shortHits: number };

const slots = new Map<string, Slot>();
/** Index of the key currently in use. */
let keyIdx = 0;
/** Global serialization: one request in flight at a time. */
let chain: Promise<unknown> = Promise.resolve();

function slotFor(key: string): Slot {
  let s = slots.get(key);
  if (!s) {
    s = { exhaustedUntil: 0, lastUsed: 0, shortHits: 0 };
    slots.set(key, s);
  }
  return s;
}

/** Next UTC midnight — when OpenRouter resets the free daily allowance. */
function nextDailyReset(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
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
          // A good call resets this key's short-limit streak.
          slot.shortHits = 0;
          // Stay on this key: the pool only moves on when a key is parked
          // (daily quota, rate limit or a dead key), never after a good call.
          return text;
        }
        // OpenRouter also reports quota problems INSIDE a 200 response body
        // ({"error":{"code":429,...}}). Treating that as "empty completion"
        // kept hammering the same exhausted key instead of switching — that is
        // the auto-switch failure. Classify it exactly like an HTTP error.
        const inBody = json.error;
        if (inBody) {
          lastErr = `${inBody.code ?? "error"} ${inBody.message ?? ""}`.trim();
          const handled = park(slot, keys.length, inBody.code ?? 0, inBody.message ?? "", 0);
          if (handled === "stop") break;
          continue;
        }
        lastErr = "empty completion";
        // Empty answers repeat on the same key — move on rather than loop.
        advanceKey(keys.length);
        continue;
      }

      const body = (await res.text().catch(() => "")).slice(0, 600);
      lastErr = `${res.status} ${body}`;

      const handled = park(
        slot,
        keys.length,
        res.status,
        body,
        Number(res.headers.get("retry-after") ?? 0),
      );
      if (handled === "stop") break;
      if (handled === "parked") continue;

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

/**
 * Decides what to do with the key that just failed.
 *
 * "parked"  — the key was put on cooldown (short) or benched for the rest of
 *             the UTC day (daily quota / dead key) and the pool moved on.
 * "stop"    — the request itself is wrong; another key cannot help.
 * "other"   — not a quota problem; the caller applies its own backoff.
 */
function park(
  slot: Slot,
  total: number,
  status: number,
  body: string,
  retryAfterSec: number,
): "parked" | "stop" | "other" {
  const daily =
    /per\s*day|daily|free-models-per-day|day limit|quota|insufficient|add (more )?credits|requires more credits|out of credits/i.test(
      body,
    );

  if (status === 429) {
    if (daily) {
      slot.exhaustedUntil = nextDailyReset();
    } else {
      slot.shortHits += 1;
      // Three short rate-limits in a row on one key means the free allowance
      // for that key is effectively spent: bench it for the day instead of
      // bouncing back onto it every few seconds.
      slot.exhaustedUntil =
        slot.shortHits >= 3
          ? nextDailyReset()
          : Date.now() + Math.min(90_000, (retryAfterSec > 0 ? retryAfterSec : 20) * 1000 + 2000);
    }
    advanceKey(total);
    return "parked";
  }

  if (status === 401 || status === 402 || status === 403) {
    // Dead / creditless key: bench it for the day and move on.
    slot.exhaustedUntil = nextDailyReset();
    advanceKey(total);
    return "parked";
  }

  if (daily) {
    slot.exhaustedUntil = nextDailyReset();
    advanceKey(total);
    return "parked";
  }

  if (status === 400) return "stop";
  return "other";
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
