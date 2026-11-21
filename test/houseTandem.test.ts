import { describe, expect, it } from "vitest";
import { HT_API, createHouseTandem, tokenValid } from "../src/platform/houseTandem";

const NOW = 1_800_000_000_000; // ms
const TOKEN_KEY = "dice.ht_token";
const USER_KEY = "dice.ht_user";

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** An unsigned token with the claims the account service puts in (the server checks the signature, not this file). */
function jwt(claims: Record<string, unknown> = {}) {
  return `${b64({ alg: "HS256" })}.${b64({ sub: 7, name: "Tok", exp: NOW / 1000 + 3600, ...claims })}.sig`;
}

function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** A page address the client can read and rewrite (history.replaceState) or leave (location.assign). */
function page(href: string) {
  const u = new URL(href);
  const loc = {
    origin: u.origin,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
    assigned: null as string | null,
    assign(url: string) {
      loc.assigned = url;
    },
  };
  const history = {
    replaceState(_data: unknown, _unused: string, url: string) {
      const n = new URL(url, u.origin);
      loc.pathname = n.pathname;
      loc.search = n.search;
      loc.hash = n.hash;
    },
  };
  return { loc, history, url: () => loc.pathname + loc.search + loc.hash };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
type Answer = { status?: number; json?: unknown } | Error;

/** A fake account service: answers by path, and remembers what it was asked. */
function api(routes: Record<string, Answer | ((call: Call) => Answer)>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[url.replace(HT_API, "")];
    if (!route) throw new Error(`unexpected request: ${url}`);
    const answer = typeof route === "function" ? route(call) : route;
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const ME = {
  json: {
    user: {
      id: 7,
      display_name: "Account Name",
      avatar_url: "https://example.com/a.png",
      identities: { discord: { name: "DiscordName", avatar: "https://cdn.discordapp.com/avatars/1/a.png" } },
    },
  },
};

function setup(href: string, routes: Parameters<typeof api>[0], stored: Record<string, string> = {}) {
  const p = page(href);
  const s = storage(stored);
  const a = api(routes);
  const ht = createHouseTandem({ fetch: a.fetch, storage: s, tabStorage: storage(), location: p.loc as unknown as Location, history: p.history as unknown as History, now: () => NOW });
  return { ht, p, s, a };
}

describe("tokenValid", () => {
  it("takes a token with a minute or more left, and nothing else", () => {
    expect(tokenValid(jwt(), NOW)).toBe(true);
    expect(tokenValid(jwt({ exp: NOW / 1000 + 30 }), NOW)).toBe(false);
    expect(tokenValid(jwt({ exp: undefined }), NOW)).toBe(false);
    expect(tokenValid("not a token", NOW)).toBe(false);
    expect(tokenValid(null, NOW)).toBe(false);
  });
});

describe("back from Discord (#ht_auth)", () => {
  it("signs in, stores the session under the game's own key, and cleans the URL", async () => {
    const token = jwt();
    const { ht, p, s, a } = setup(`https://dice.example/?room=ABC#ht_auth=${token}&k=roomkey`, { "/me": ME });
    const session = await ht.webSession();
    expect(session).toEqual({ token, user: { id: "7", name: "DiscordName", avatar: "https://cdn.discordapp.com/avatars/1/a.png" } });
    expect(s.m.get(TOKEN_KEY)).toBe(token); // the bare token, as before
    expect(JSON.parse(s.m.get(USER_KEY)!).id).toBe(7);
    expect(p.url()).toBe("/?room=ABC#k=roomkey");
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0].headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("an expired token in the URL does not replace the stored session", async () => {
    const stored = jwt({ name: "Stored" });
    const { ht, p, s } = setup(`https://dice.example/#ht_auth=${jwt({ exp: NOW / 1000 - 10 })}`, { "/me": ME }, { [TOKEN_KEY]: stored });
    const session = await ht.webSession();
    expect(session?.token).toBe(stored);
    expect(s.m.get(TOKEN_KEY)).toBe(stored);
    expect(p.url()).toBe("/");
  });

  it("shows the account's own name, and no picture, when the picture is not Discord's", async () => {
    const me = { json: { user: { id: 7, display_name: "Account Name", avatar_url: "https://example.com/a.png", identities: { discord: { avatar: "https://evil.example/a.png" } } } } };
    const { ht } = setup(`https://dice.example/#ht_auth=${jwt()}`, { "/me": me });
    expect((await ht.webSession())?.user).toEqual({ id: "7", name: "Account Name", avatar: undefined });
  });
});

describe("from housetandem.com (?ht_code)", () => {
  it("swaps the code for a session and takes it off the URL", async () => {
    const token = jwt();
    const { ht, p, s, a } = setup("https://dice.example/?room=ABC&ht_code=id.secret", {
      "/auth/handoff/redeem": { json: { token, user: { id: 7, name: "Account Name", avatar: null, identities: {} } } },
      "/me": ME,
    });
    const session = await ht.webSession();
    expect(session?.token).toBe(token);
    expect(session?.user.name).toBe("DiscordName");
    expect(s.m.get(TOKEN_KEY)).toBe(token);
    expect(p.url()).toBe("/?room=ABC");
    expect(a.calls[0]).toMatchObject({ url: `${HT_API}/auth/handoff/redeem`, method: "POST", body: { code: "id.secret" } });
    expect(a.calls[0].headers.Authorization).toBeUndefined();
  });

  it("a code that has expired leaves the stored session alone", async () => {
    const stored = jwt();
    const { ht, p, s } = setup("https://dice.example/?ht_code=old.code", { "/auth/handoff/redeem": { status: 410, json: { error: "This sign-in link has expired" } }, "/me": ME }, { [TOKEN_KEY]: stored });
    expect((await ht.webSession())?.token).toBe(stored);
    expect(s.m.get(TOKEN_KEY)).toBe(stored);
    expect(p.url()).toBe("/");
  });

  it("a code that has expired, with nothing stored, is signed out", async () => {
    const { ht, s } = setup("https://dice.example/?ht_code=old.code", { "/auth/handoff/redeem": { status: 410 } });
    expect(await ht.webSession()).toBeNull();
    expect(s.m.size).toBe(0);
  });
});

describe("a stored session", () => {
  it("from before the shared client (the token alone) stays signed in", async () => {
    const stored = jwt();
    const { ht, s, a } = setup("https://dice.example/?room=ABC", { "/me": ME }, { [TOKEN_KEY]: stored });
    const session = await ht.webSession();
    expect(session).toEqual({ token: stored, user: { id: "7", name: "DiscordName", avatar: "https://cdn.discordapp.com/avatars/1/a.png" } });
    expect(s.m.get(TOKEN_KEY)).toBe(stored);
    expect(JSON.parse(s.m.get(USER_KEY)!).name).toBe("Account Name");
    expect(a.calls).toHaveLength(1);
  });

  it("survives a second visit", async () => {
    const stored = jwt();
    const first = setup("https://dice.example/", { "/me": ME }, { [TOKEN_KEY]: stored });
    await first.ht.webSession();
    const second = setup("https://dice.example/", { "/me": ME }, Object.fromEntries(first.s.m));
    expect((await second.ht.webSession())?.token).toBe(stored);
  });

  it("is kept when the account service cannot be reached, showing what the token says", async () => {
    const stored = jwt({ name: "Tok" });
    const { ht, s } = setup("https://dice.example/", { "/me": new Error("offline") }, { [TOKEN_KEY]: stored });
    expect(await ht.webSession()).toEqual({ token: stored, user: { id: "7", name: "Tok", avatar: undefined } });
    expect(s.m.get(TOKEN_KEY)).toBe(stored);
  });

  it("is kept when the account service is down (500)", async () => {
    const stored = jwt();
    const { ht, s } = setup("https://dice.example/", { "/me": { status: 500 } }, { [TOKEN_KEY]: stored });
    expect((await ht.webSession())?.token).toBe(stored);
    expect(s.m.get(TOKEN_KEY)).toBe(stored);
  });

  it("is forgotten when the service no longer takes it (401)", async () => {
    for (const json of [{ error: "Invalid token" }, { code: "account_gone" }]) {
      const { ht, s } = setup("https://dice.example/", { "/me": { status: 401, json } }, { [TOKEN_KEY]: jwt() });
      expect(await ht.webSession()).toBeNull();
      expect(s.m.size).toBe(0);
    }
  });

  it("is forgotten once it is past its date, without asking the service", async () => {
    const { ht, s, a } = setup("https://dice.example/", {}, { [TOKEN_KEY]: jwt({ exp: NOW / 1000 + 30 }) });
    expect(await ht.webSession()).toBeNull();
    expect(s.m.size).toBe(0);
    expect(a.calls).toHaveLength(0);
  });

  it("nothing stored: signed out, and nothing asked", async () => {
    const { ht, a } = setup("https://dice.example/", {});
    expect(await ht.webSession()).toBeNull();
    expect(a.calls).toHaveLength(0);
  });
});

describe("sign in and out", () => {
  it("asks for a Discord sign-in that comes back to this table, and goes there", async () => {
    const { ht, p, a } = setup("https://dice.example/?room=ABC#k=roomkey", { "/auth/discord/begin": { json: { url: "https://api.example/go/1" } } });
    await ht.beginSignIn();
    expect(a.calls[0]).toMatchObject({ method: "POST", body: { mode: "redirect", return_to: "https://dice.example/?room=ABC" } });
    expect(a.calls[0].headers.Authorization).toBeUndefined();
    expect(p.loc.assigned).toBe("https://api.example/go/1");
  });

  it("says why when sign-in cannot start, and stays on the page", async () => {
    const said = setup("https://dice.example/", { "/auth/discord/begin": { status: 503, json: { error: "Discord sign-in is switched off" } } });
    await expect(said.ht.beginSignIn()).rejects.toThrow("Discord sign-in is switched off");
    const silent = setup("https://dice.example/", { "/auth/discord/begin": { status: 500 } });
    await expect(silent.ht.beginSignIn()).rejects.toThrow("Sign-in is unavailable right now");
    const offline = setup("https://dice.example/", { "/auth/discord/begin": new Error("Failed to fetch") });
    await expect(offline.ht.beginSignIn()).rejects.toThrow("Sign-in is unavailable right now");
    const empty = setup("https://dice.example/", { "/auth/discord/begin": { json: {} } });
    await expect(empty.ht.beginSignIn()).rejects.toThrow("Sign-in is unavailable right now");
    expect(said.p.loc.assigned ?? silent.p.loc.assigned ?? offline.p.loc.assigned ?? empty.p.loc.assigned).toBeNull();
  });

  it("sign out forgets the session", async () => {
    const { ht, s } = setup("https://dice.example/", { "/me": ME }, { [TOKEN_KEY]: jwt() });
    expect(await ht.webSession()).not.toBeNull();
    ht.signOut();
    expect(s.m.size).toBe(0);
    expect(await ht.webSession()).toBeNull();
  });
});
