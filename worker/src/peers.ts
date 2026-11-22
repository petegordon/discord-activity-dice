export type Attachment = {
  id: string;
  joinedAt: number;
  lastShake?: number;
  role?: "player" | "remote";
  userId?: string;
  loginId?: number;
  /** Player: the room has read its first message (see ServerMsg "join" in src/net/protocol.ts). */
  joined?: boolean;
  /** Player: not a Discord room, so its first message may carry a House Tandem session. */
  web?: boolean;
  /** Player: the SHA-256 of the key in its current remote link (worker/src/remotes.ts). */
  remoteHash?: string;
  /** Remote: still to send its key; not part of the room yet. */
  pending?: boolean;
  /** Remote: the hash of the key it presented, and the player who registered it. */
  keyHash?: string;
  owner?: string;
  /** Remote: since when its player has had no connection. */
  orphanedAt?: number;
};

/**
 * Connection order decides the host: the earliest *player*. Shaker remotes
 * are listed separately and can never be host (see SHAKER-REMOTE.md).
 * Attachments from before roles existed count as players.
 */
export function splitPeers<T extends { att: Attachment }>(sockets: T[]): { players: T[]; remotes: T[] } {
  const ordered = [...sockets].sort((a, b) => a.att.joinedAt - b.att.joinedAt || a.att.id.localeCompare(b.att.id));
  return {
    players: ordered.filter((s) => s.att.role !== "remote"),
    remotes: ordered.filter((s) => s.att.role === "remote"),
  };
}

/** A login id from the account service: an integer, or null when there is none (an older service doesn't send it). */
export function loginIdOf(v: unknown): number | null {
  const n = typeof v === "string" && /^[0-9]{1,16}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}
