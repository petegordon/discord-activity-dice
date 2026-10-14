/**
 * Player ids are derived from a per-session secret: id = first 16 hex chars of
 * SHA-256(key). The id is public (it's in every state message); the key is
 * only ever sent to the relay or the host, which check it. Without the key,
 * nobody can connect as someone else or kick them by reusing their id.
 *
 * Shared by the browser and the Worker (WebCrypto exists in both).
 */
export const KEY_RE = /^[0-9a-f]{32}$/;

export async function playerIdFromKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyPlayerKey(id: string, key: unknown): Promise<boolean> {
  return typeof key === "string" && KEY_RE.test(key) && (await playerIdFromKey(key)) === id;
}

export async function newIdentity(): Promise<{ id: string; key: string }> {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return { id: await playerIdFromKey(key), key };
}
