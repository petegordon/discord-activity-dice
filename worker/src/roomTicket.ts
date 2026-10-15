/**
 * Discord rooms and tickets.
 *
 * A Discord Activity's relay room is named after an HMAC of its instance id,
 * not the id itself, so a shaker-remote link (which carries the room name)
 * doesn't reveal the instance id. Players join a Discord room only with a
 * ticket, which /api/token hands out after a successful Discord login. Anyone
 * holding just a remote link can connect as a remote, which the host ignores
 * unless a player has paired it.
 *
 * The HMAC key is derived from the Discord client secret, so there's no extra
 * secret to manage. Shared by the Worker and the tests (WebCrypto in both).
 */
export const DISCORD_ROOM_RE = /^d[0-9a-f]{30}$/;

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

export async function roomTicket(secret: string, room: string, playerId: string): Promise<string> {
  return (await sign(secret, `ticket:${room}:${playerId}`)).slice(0, 32);
}

export async function verifyRoomTicket(secret: string, room: string, playerId: string, ticket: unknown): Promise<boolean> {
  if (typeof ticket !== "string" || ticket.length !== 32) return false;
  const expected = await roomTicket(secret, room, playerId);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ ticket.charCodeAt(i);
  return diff === 0;
}
