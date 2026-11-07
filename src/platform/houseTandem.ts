/**
 * Sign in with a House Tandem account on the standalone web version
 * (dice.housetandem.com). Inside Discord the Activity signs players in itself.
 *
 * - "Sign in with Discord" goes through the House Tandem account service and
 *   comes back here with the session in the URL fragment (#ht_auth=…).
 * - A link from housetandem.com while signed in carries a one-time handoff
 *   code (?ht_code=…), swapped here for a session.
 *
 * The session goes to the relay with each connection; the relay checks it and
 * saves achievements to that account.
 */
export const HT_API: string = (import.meta.env.VITE_HT_API as string | undefined) || "https://tandemonium-api.pete-872.workers.dev";
const TOKEN_KEY = "dice.ht_token";

export type HtUser = { id: string; name: string; avatar?: string };
export type HtSession = { token: string; user: HtUser };

function claims(token: string): { exp?: number; sub?: unknown } | null {
  try {
    return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export function tokenValid(token: string | null | undefined): token is string {
  const c = token ? claims(token) : null;
  return !!c && typeof c.exp === "number" && c.exp > Date.now() / 1000 + 60;
}

function store(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable; the session lasts this page only
  }
}

function stored(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Back from Discord: take #ht_auth off the URL. */
export function takeRedirectToken(): string | null {
  if (!location.hash.includes("ht_auth=")) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("ht_auth");
  params.delete("ht_auth");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
  return tokenValid(token) ? token : null;
}

/** From housetandem.com: swap ?ht_code for a session, and take it off the URL. */
export async function redeemHandoff(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = new URL(location.href);
  const code = url.searchParams.get("ht_code");
  if (!code) return null;
  url.searchParams.delete("ht_code");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  try {
    const res = await fetchImpl(`${HT_API}/auth/handoff/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token?: string };
    return tokenValid(token) ? token : null;
  } catch {
    return null;
  }
}

/** The name and Discord picture for a session; null (and forgotten) if the account is gone. */
export async function fetchUser(token: string, fetchImpl: typeof fetch = fetch): Promise<HtUser | null> {
  try {
    const res = await fetchImpl(`${HT_API}/me`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      store(null);
      return null;
    }
    if (!res.ok) throw new Error(String(res.status));
    const { user } = (await res.json()) as {
      user?: { id: number | string; display_name?: string; avatar_url?: string; identities?: Record<string, { name?: string; avatar?: string }> };
    };
    if (!user) return null;
    const discord = user.identities?.discord;
    const avatar = discord?.avatar && /^https:\/\/cdn\.discordapp\.com\//.test(discord.avatar) ? discord.avatar : undefined;
    return { id: String(user.id), name: discord?.name || user.display_name || "Player", avatar };
  } catch {
    // Offline or the service is down: keep the session, show what the token says.
    const c = claims(token) as { sub?: unknown; name?: unknown } | null;
    return c ? { id: String(c.sub), name: typeof c.name === "string" ? c.name : "Player" } : null;
  }
}

/** The signed-in session on this device, from a fresh sign-in, a handoff, or storage. */
export async function webSession(): Promise<HtSession | null> {
  const token = takeRedirectToken() ?? (await redeemHandoff()) ?? stored();
  if (!tokenValid(token)) {
    store(null);
    return null;
  }
  store(token);
  const user = await fetchUser(token);
  return user ? { token, user } : null;
}

/** Go to Discord and come back to this table signed in. */
export async function beginSignIn(fetchImpl: typeof fetch = fetch): Promise<void> {
  const back = location.origin + location.pathname + location.search;
  const res = await fetchImpl(`${HT_API}/auth/discord/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "redirect", return_to: back }),
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!data.url) throw new Error(data.error || "Sign-in is unavailable right now");
  location.assign(data.url);
}

export function signOut() {
  store(null);
}
