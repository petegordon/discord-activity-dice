/**
 * Sign in with a House Tandem account on the standalone web version
 * (dice.housetandem.com). Inside Discord the Activity signs players in itself.
 *
 * - "Sign in with Discord" goes through the House Tandem account service and
 *   comes back here with a single-use code (#ht_result=…), swapped for a session
 *   with a value only this tab holds.
 * - A link from housetandem.com while signed in carries a one-time handoff
 *   code (?ht_code=…), swapped here for a session.
 *
 * The session goes to the relay with each connection; the relay checks it and
 * saves achievements to that account.
 *
 * The session itself (storage, talking to the account service, the redirect, the
 * handoff code) is the shared @usersfirst/identity client, vendored in
 * src/vendor/identity (scripts/sync-identity.mjs). What stays here is this game's
 * side of it: a session within a minute of its end is not used, and the name and
 * picture shown are the Discord ones.
 */
import { IdentityClient, decodeToken, takeRedirect, type IdentityOptions, type IdentityUser } from "@usersfirst/identity/client";

export const HT_API: string = (import.meta.env.VITE_HT_API as string | undefined) || "https://tandemonium-api.pete-872.workers.dev";
/**
 * Where the session is kept. The token's key and value (the bare token) are what this
 * game has always stored, so a player signed in before the shared client stays signed in
 * (the client reads the token alone as a session); the user beside it is new and is
 * filled in on their next visit.
 */
const KEYS = { token: "dice.ht_token", user: "dice.ht_user" };
const UNAVAILABLE = "Sign-in is unavailable right now";

export type HtUser = { id: string; name: string; avatar?: string };
export type HtSession = { token: string; user: HtUser };
/** Stand-ins for the browser's own, for tests. */
export type HtEnv = Pick<IdentityOptions, "fetch" | "storage" | "tabStorage" | "location" | "history" | "now" | "confirmSwitch">;

export function tokenValid(token: string | null | undefined, now: number = Date.now()): token is string {
  const c = token ? decodeToken(token) : null;
  return !!c && typeof c.exp === "number" && c.exp > now / 1000 + 60;
}

/** What the table shows for an account: its Discord name and picture when it has them. */
function tableUser(u: IdentityUser): HtUser {
  const discord = u.identities?.discord;
  const avatar = discord?.avatar && /^https:\/\/cdn\.discordapp\.com\//.test(discord.avatar) ? discord.avatar : undefined;
  return { id: String(u.id), name: discord?.name || u.name || "Player", avatar };
}

export function createHouseTandem(env: HtEnv = {}) {
  // forgetOn401: a session the account service no longer takes is forgotten.
  const client = new IdentityClient({ apiBase: HT_API, keys: KEYS, forgetOn401: true, ...env });
  const loc = () => env.location ?? location;
  const hist = () => env.history ?? history;
  const valid = (token: string | null | undefined): token is string => tokenValid(token, env.now ? env.now() : Date.now());

  /** Re-read the session's account. Null (and forgotten) if the account is gone or the service no longer takes the session. */
  async function readUser(): Promise<HtUser | null> {
    const user = await client.refresh();
    if (!client.token) {
      client.signOut(); // (an account that is gone leaves its stored profile behind otherwise)
      return null;
    }
    if (!user && client.meStatus >= 200 && client.meStatus < 300) return null; // answered, with no account in it
    // No answer (offline, or the service is down): keep the session, show what it last knew.
    return client.user ? tableUser(client.user) : null;
  }

  /** The signed-in session on this device, from a fresh sign-in, a handoff, or storage. */
  async function webSession(): Promise<HtSession | null> {
    const back = await client.resume(); // #ht_result, back from Discord
    if (!back?.signedIn) await client.redeemHandoff(); // ?ht_code, from housetandem.com
    const token = client.token;
    if (!valid(token)) {
      client.signOut();
      return null;
    }
    const user = await readUser();
    return user ? { token, user } : null;
  }

  /** Go to Discord and come back to this table signed in. */
  async function beginSignIn(): Promise<void> {
    let data: Record<string, any>;
    try {
      data = await client.begin("discord", { mode: "redirect" });
    } catch (e) {
      // The service's own words when it gave some; otherwise ours.
      const err = e as { status?: number; message?: string };
      throw new Error(err.status && err.message && !/^Sign-in unavailable \(/.test(err.message) ? err.message : UNAVAILABLE);
    }
    if (!data.url) throw new Error(data.error || UNAVAILABLE);
    loc().assign(data.url);
  }

  return {
    client,
    /** An older redirect: take #ht_auth off the URL (webSession does this itself, and signs in). */
    takeRedirectToken: (): string | null => {
      const back = takeRedirect(loc(), hist());
      return back && valid(back.token) ? back.token : null;
    },
    /** From housetandem.com: swap ?ht_code for a session, and take it off the URL. */
    redeemHandoff: async (): Promise<string | null> => ((await client.redeemHandoff())?.signedIn ? client.token : null),
    /** Make `token` this device's session and read its account. */
    fetchUser: (token: string): Promise<HtUser | null> => {
      if (client.token !== token) {
        const c = decodeToken(token) ?? {};
        client.apply(token, { id: c.sub, name: typeof c.name === "string" ? c.name : undefined });
      }
      return readUser();
    },
    webSession,
    beginSignIn,
    signOut: () => client.signOut(),
  };
}

// The page's own session, made on first use (so importing this file touches nothing).
let page: ReturnType<typeof createHouseTandem> | undefined;
const ht = () => (page ??= createHouseTandem());

export const takeRedirectToken = (): string | null => ht().takeRedirectToken();
export const redeemHandoff = (): Promise<string | null> => ht().redeemHandoff();
export const fetchUser = (token: string): Promise<HtUser | null> => ht().fetchUser(token);
export const webSession = (): Promise<HtSession | null> => ht().webSession();
export const beginSignIn = (): Promise<void> => ht().beginSignIn();
export const signOut = (): void => ht().signOut();
