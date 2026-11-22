/**
 * Discord rooms and tickets.
 *
 * A Discord Activity's relay room is named after an HMAC of its instance id,
 * not the id itself, so a shaker-remote link (which carries the room name)
 * doesn't reveal the instance id. Players join a Discord room only with a
 * ticket, which /api/token hands out after a successful Discord login. A
 * remote needs no ticket: the room takes it only when a player there has
 * registered its key (worker/src/remotes.ts).
 *
 * The HMAC key is derived from the Discord client secret, so there's no extra
 * secret to manage. Shared by the Worker and the tests (WebCrypto in both).
 *
 * A ticket is `<expires>.<userId>.<loginId>.<sig>`: when it stops working
 * (unix seconds), the player's House Tandem account and the login that signed
 * in (both empty for a guest; the login also when the account service doesn't
 * say), and an HMAC over all of it with the room and the player id. The relay
 * credits achievements to that account, and nobody can swap in another id or a
 * later date. A ticket is good for TICKET_TTL_MS; the client asks /api/token
 * for a new one when the relay stops taking it.
 */
export const DISCORD_ROOM_RE = /^d[0-9a-f]{30}$/;

/** How long a ticket admits its player. */
export const TICKET_TTL_MS = 12 * 60 * 60 * 1000;

const encoder = new TextEncoder();

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(`dice-room-ticket:v1:${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(secret: string, data: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data)));
}

export async function discordRoom(secret: string, instanceId: string): Promise<string> {
  return "d" + (await sign(secret, `room:${instanceId}`)).slice(0, 30);
}

export async function roomTicket(
  secret: string,
  room: string,
  playerId: string,
  userId?: string,
  loginId?: number | null,
  expiresAt: number = Date.now() + TICKET_TTL_MS,
): Promise<string> {
  const exp = Math.floor(expiresAt / 1000);
  const user = userId ?? "";
  const login = userId && loginId != null ? String(loginId) : "";
  const sig = (await sign(secret, `ticket:v2:${room}:${playerId}:${exp}:${user}:${login}`)).slice(0, 32);
  return `${exp}.${user}.${login}.${sig}`;
}

const TICKET_RE = /^([0-9]{1,12})\.([0-9]{0,20})\.([0-9]{0,16})\.([0-9a-f]{32})$/;

/** A ticket the room takes: { ok, userId?, loginId? }. `expired`: it is one of ours, but its time is up. */
export async function readRoomTicket(
  secret: string,
  room: string,
  playerId: string,
  ticket: unknown,
  now: number = Date.now(),
): Promise<{ ok: boolean; expired?: boolean; userId?: string; loginId?: number }> {
  const m = typeof ticket === "string" ? TICKET_RE.exec(ticket) : null;
  if (!m) return { ok: false };
  const [whole, exp, user, login] = m;
  if (login && !user) return { ok: false };
  const expected = await roomTicket(secret, room, playerId, user || undefined, login ? Number(login) : null, Number(exp) * 1000);
  if (!same(expected, whole)) return { ok: false };
  if (Number(exp) * 1000 <= now) return { ok: false, expired: true };
  return { ok: true, ...(user ? { userId: user } : {}), ...(login ? { loginId: Number(login) } : {}) };
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyRoomTicket(secret: string, room: string, playerId: string, ticket: unknown, now: number = Date.now()): Promise<boolean> {
  return (await readRoomTicket(secret, room, playerId, ticket, now)).ok;
}
