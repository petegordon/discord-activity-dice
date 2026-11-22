import type { Attachment } from "./peers";

/**
 * Which phone remotes a room takes.
 *
 * A player's remote link carries a random key after the #. The player's own
 * client (already admitted to the room) registers the SHA-256 of that key over
 * its socket: in its first message, and again whenever it makes a new link or
 * unpairs. A remote socket joins the room only by presenting, in its first
 * message, a key whose hash a player there has registered; it then plays for
 * that player and nobody else. Until then it is not part of the room: it is
 * not listed, hears nothing and counts toward nothing but a small waiting
 * list. Anything else from it, or no first message in time, closes it.
 *
 * The registration lives on the player's socket, so it goes when the player
 * unpairs, makes a new link or leaves. A remote whose registration is gone is
 * closed at once; when its player has only dropped for a moment (no socket, or
 * a new one that hasn't said its first message yet) it is kept for
 * REMOTE_GRACE_MS, and in that time the same remote may also reconnect.
 *
 * These are pure functions over the sockets' attachments; the Durable Object
 * (worker/src/index.ts) applies what they decide.
 */
export const HASH_RE = /^[0-9a-f]{64}$/;
/** A remote's id is the first 16 hex chars of its key's hash (src/net/identityKey.ts). */
export const remoteIdOf = (hash: string) => hash.slice(0, 16);

/** How long a remote outlasts its player's connection. */
export const REMOTE_GRACE_MS = 10_000;
/** A new remote socket has this long to send its key. */
export const JOIN_DEADLINE_MS = 5_000;
/** Remote sockets that may be waiting to send their key at once, per room. */
export const MAX_WAITING = 8;
/** Close code: this remote's key isn't registered here (any more). */
export const CLOSE_NOT_LINKED = 4003;
/** Close code: no first message in time. */
export const CLOSE_NO_JOIN = 4002;

type Sock = { att: Attachment };

const isPlayer = (s: Sock) => s.att.role !== "remote";
const isRemote = (s: Sock) => s.att.role === "remote" && !s.att.pending;

/**
 * A player registering (`hash`) or clearing (null/undefined) their remote key.
 * Returns what to keep on the player's socket: the hash, or null for none.
 * `undefined` means the request is refused and nothing changes: not a hash, or
 * its remote id is already someone else's (another player's registration, a
 * remote playing for another player, or a player's own id).
 */
export function registration(sockets: Sock[], playerId: string, hash: unknown): string | null | undefined {
  if (hash === null || hash === undefined) return null;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return undefined;
  const id = remoteIdOf(hash);
  for (const s of sockets) {
    if (isPlayer(s)) {
      if (s.att.id === id) return undefined;
      if (s.att.id !== playerId && s.att.remoteHash && remoteIdOf(s.att.remoteHash) === id) return undefined;
    } else if (isRemote(s) && s.att.id === id && s.att.owner !== playerId) return undefined;
  }
  return hash;
}

/**
 * The player a remote plays for, given the hash of the key it presented, or
 * null when the room doesn't take it. `orphanedAt` carries over when the
 * remote reconnects while its player is away.
 */
export function remoteOwner(sockets: Sock[], remoteId: string, hash: string): { owner: string; orphanedAt?: number } | null {
  if (!HASH_RE.test(hash) || remoteIdOf(hash) !== remoteId) return null;
  const player = sockets.find((s) => isPlayer(s) && s.att.remoteHash === hash);
  if (player) return { owner: player.att.id };
  const earlier = sockets.find((s) => isRemote(s) && s.att.id === remoteId && s.att.keyHash === hash && s.att.owner);
  if (earlier) return { owner: earlier.att.owner!, ...(earlier.att.orphanedAt !== undefined ? { orphanedAt: earlier.att.orphanedAt } : {}) };
  return null;
}

/**
 * Look over the room's remotes: which sockets to close (their registration is
 * gone, their player stayed away, or they never sent a key) and which
 * attachments to update (a player went missing or came back).
 */
export function reviewRemotes<T extends Sock>(sockets: T[], now: number): { close: T[]; update: { sock: T; att: Attachment }[] } {
  const close: T[] = [];
  const update: { sock: T; att: Attachment }[] = [];
  for (const s of sockets) {
    const a = s.att;
    if (a.role !== "remote") continue;
    if (a.pending) {
      if (now - a.joinedAt > JOIN_DEADLINE_MS) close.push(s);
      continue;
    }
    // The player's socket, once it has said what its remote key is.
    const owners = sockets.filter((p) => isPlayer(p) && p.att.id === a.owner && p.att.joined);
    if (owners.length) {
      if (!a.keyHash || !owners.some((p) => p.att.remoteHash === a.keyHash)) close.push(s);
      else if (a.orphanedAt !== undefined) {
        const { orphanedAt: _gone, ...rest } = a;
        update.push({ sock: s, att: rest });
      }
    } else if (a.orphanedAt === undefined) update.push({ sock: s, att: { ...a, orphanedAt: now } });
    else if (now - a.orphanedAt > REMOTE_GRACE_MS) close.push(s);
  }
  return { close, update };
}
