/**
 * Limits on how much one caller may ask of the Worker and of a room.
 *
 * Per socket, a token bucket: MESSAGE_BURST messages at once, refilled at
 * MESSAGES_PER_SECOND. Real play stays far below it (a host sends about 30
 * messages a second at its busiest, a player about 15). A message over the
 * limit is dropped and still counted, so a socket that keeps sending faster
 * than the refill falls further behind and is closed.
 *
 * Per address, Cloudflare rate-limit bindings (wrangler.jsonc): TOKEN_RATE for
 * /api/token and ROOM_RATE for new room connections. A missing binding (local
 * dev, tests) means no limit.
 */
export const MESSAGE_BURST = 120;
export const MESSAGES_PER_SECOND = 60;
/** Close code for a socket that stayed over the message limit. */
export const CLOSE_TOO_MANY = 4008;

export type Bucket = { tokens: number; at: number };

export function newBucket(now: number): Bucket {
  return { tokens: MESSAGE_BURST, at: now };
}

/** Count one message: "ok" to handle it, "drop" to ignore it, "close" when the socket has stayed over the limit. */
export function take(b: Bucket, now: number): "ok" | "drop" | "close" {
  b.tokens = Math.min(MESSAGE_BURST, b.tokens + (Math.max(0, now - b.at) / 1000) * MESSAGES_PER_SECOND);
  b.at = now;
  b.tokens -= 1;
  if (b.tokens >= 0) return "ok";
  return b.tokens < -MESSAGE_BURST ? "close" : "drop";
}

/** A Cloudflare rate-limit binding. */
export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/** The caller's address, as Cloudflare saw it. */
export function clientAddress(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** True when `key` is within the limit. No binding, or a binding that fails, is no limit. */
export async function withinLimit(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}
