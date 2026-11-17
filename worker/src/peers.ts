export type Attachment = { id: string; joinedAt: number; lastShake?: number; role?: "player" | "remote"; userId?: string; loginId?: number };

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
