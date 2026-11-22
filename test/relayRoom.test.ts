import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyHash, newIdentity } from "../src/net/identityKey";
import { MESSAGE_BURST } from "../worker/src/limits";
import { JOIN_DEADLINE_MS, MAX_WAITING, REMOTE_GRACE_MS } from "../worker/src/remotes";
import { discordRoom, roomTicket, TICKET_TTL_MS } from "../worker/src/roomTicket";
import { driver, fakeCtx, FakeResponse, FakeSocket, stubRuntime } from "./relayFakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

const T0 = 1_800_000_000_000;

/**
 * The Worker is loaded by a path the type checker doesn't follow: it is written
 * against the Workers runtime types (worker/tsconfig.json), the tests against the DOM's.
 */
const WORKER = "../worker/src/index";
type Room = { fetch(req: Request): Promise<unknown>; webSocketMessage(ws: never, data: string): Promise<void>; webSocketClose(ws: never, code: number): Promise<void>; alarm?(): Promise<void> };
type WorkerModule = { RelayRoom: new (ctx: never, env: never) => Room; default: { fetch(req: never, env: never): Promise<unknown> } };
const loadWorker = async () => (await import(/* @vite-ignore */ WORKER)) as WorkerModule;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  stubRuntime();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Ht = { verifySession: (t: string) => Promise<{ userId: number; loginId?: number; name: string; avatar: null } | null>; recordPlay: (...a: unknown[]) => Promise<unknown> };

async function setup(opts: { roomName?: string; ht?: Partial<Ht> } = {}) {
  const { RelayRoom } = await loadWorker();
  const ctx = fakeCtx();
  const plays: unknown[][] = [];
  const sessions: string[] = [];
  const HT = {
    verifySession: async (t: string) => {
      sessions.push(t);
      return t === "good" ? { userId: 42, loginId: 7, name: "P", avatar: null } : null;
    },
    recordPlay: async (...a: unknown[]) => void plays.push(a),
    gameProfile: async () => ({ earned: [], stats: {} }),
    recordGame: async () => ({ newlyEarned: [] }),
    ...opts.ht,
  };
  const room = new RelayRoom(ctx as never, { HT } as never);
  await Promise.resolve();
  return { room, ctx, plays, sessions, ...driver(room, ctx, opts.roomName) };
}

/** A player at the table, by id, with a remote link: its key, the remote's id and the key's hash. */
async function link() {
  const { id, key } = await newIdentity();
  return { id, key, hash: await keyHash(key) };
}

const peersOf = (ws: FakeSocket) => ws.got.filter((m) => m.type === "peers").at(-1);
const lastState = (ws: FakeSocket) => ws.got.filter((m) => m.env?.msg.t === "state").at(-1)?.env?.msg as { players: { id: string; remoteId?: string }[] } | undefined;
const hello = { to: "host", msg: { t: "hello", player: { name: "P" } } };

describe("a remote joining a relay room", () => {
  it("is taken only with a key a player there registered, and then plays for that player", async () => {
    const { connect, say, toRoom } = await setup();
    const a = (await connect("a")) as FakeSocket;
    await toRoom(a, { t: "join" });
    await say(a, hello);
    const l = await link();
    await toRoom(a, { t: "remote-key", hash: l.hash });
    await say(a, { to: "host", msg: { t: "pair", remoteId: l.id } });

    const r = (await connect(l.id, "remote")) as FakeSocket;
    expect(r.sent).toEqual([]);
    expect(peersOf(a)?.remotes).toEqual([]);
    await toRoom(r, { t: "join", key: l.key });
    expect(r.closed).toBeNull();
    expect(peersOf(a)?.remotes).toEqual([l.id]);
    expect(peersOf(r)?.remotes).toEqual([l.id]);
    expect((r.deserializeAttachment() as { owner: string }).owner).toBe("a");
    expect(lastState(a)?.players[0]).toMatchObject({ id: "a", remoteId: l.id, remoteOnline: true });
  });

  it("with a key nobody registered is closed at once and is sent nothing", async () => {
    const { connect, say, toRoom } = await setup();
    const a = (await connect("a")) as FakeSocket;
    await toRoom(a, { t: "join" });
    await say(a, hello);
    const before = a.sent.length;
    const l = await link();

    const r = (await connect(l.id, "remote")) as FakeSocket;
    await toRoom(r, { t: "join", key: l.key });
    expect(r.closed?.code).toBe(4003);
    expect(r.sent).toEqual([]);
    // Nobody at the table heard of it either.
    expect(a.sent.length).toBe(before);

    // A key that is someone's, presented under another id.
    const other = await link();
    await toRoom(a, { t: "remote-key", hash: other.hash });
    const r2 = (await connect(l.id, "remote")) as FakeSocket;
    await toRoom(r2, { t: "join", key: other.key });
    expect(r2.closed?.code).toBe(4003);
    expect(r2.sent).toEqual([]);
  });

  it("that says anything but its key first, or nothing in time, is closed and is sent nothing", async () => {
    const { room, connect, say, toRoom } = await setup();
    const a = (await connect("a")) as FakeSocket;
    await toRoom(a, { t: "join" });
    await say(a, hello);
    const before = a.sent.length;

    const l = await link();
    await toRoom(a, { t: "remote-key", hash: l.hash });
    const chatty = (await connect(l.id, "remote")) as FakeSocket;
    await say(chatty, { to: "host", msg: { t: "remote-hello" } });
    expect(chatty.closed?.code).toBe(4003);
    expect(chatty.sent).toEqual([]);

    const quiet = (await connect(l.id, "remote")) as FakeSocket;
    vi.setSystemTime(T0 + JOIN_DEADLINE_MS + 1);
    await room.alarm!();
    expect(quiet.closed?.code).toBe(4002);
    expect(quiet.sent).toEqual([]);
    expect(a.sent.length).toBe(before);
  });

  it("waits with only a few others, and does not use up places at the table", async () => {
    const { connect } = await setup();
    await connect("a");
    for (let i = 0; i < MAX_WAITING; i++) expect(await connect(`r${i}`, "remote")).toBeInstanceOf(FakeSocket);
    expect(await connect("r-more", "remote")).toBe(429);
    // Players still get in, and those waiting are let go after the deadline.
    expect(await connect("b")).toBeInstanceOf(FakeSocket);
    vi.setSystemTime(T0 + JOIN_DEADLINE_MS + 1);
    expect(await connect("r-later", "remote")).toBeInstanceOf(FakeSocket);
  });

  it("a waiting remote can't take the place of the socket whose id it names", async () => {
    const { connect } = await setup();
    const a = (await connect("a")) as FakeSocket;
    await connect("a", "remote");
    expect(a.closed).toBeNull();
  });
});

describe("a remote's registration", () => {
  async function paired() {
    const s = await setup();
    const a = (await s.connect("a")) as FakeSocket;
    const l = await link();
    await s.toRoom(a, { t: "join", remote: l.hash });
    await s.say(a, hello);
    await s.say(a, { to: "host", msg: { t: "pair", remoteId: l.id } });
    const r = (await s.connect(l.id, "remote")) as FakeSocket;
    await s.toRoom(r, { t: "join", key: l.key });
    expect(r.closed).toBeNull();
    return { ...s, a, l, r };
  }

  it("goes with a new link: the old remote is closed and its key no longer works", async () => {
    const { connect, toRoom, a, l, r } = await paired();
    const next = await link();
    await toRoom(a, { t: "remote-key", hash: next.hash });
    expect(r.closed?.code).toBe(4003);
    const again = (await connect(l.id, "remote")) as FakeSocket;
    await toRoom(again, { t: "join", key: l.key });
    expect(again.closed?.code).toBe(4003);
    const fresh = (await connect(next.id, "remote")) as FakeSocket;
    await toRoom(fresh, { t: "join", key: next.key });
    expect(fresh.closed).toBeNull();
  });

  it("goes when the player unpairs", async () => {
    const { toRoom, a, r } = await paired();
    await toRoom(a, { t: "remote-key" });
    expect(r.closed?.code).toBe(4003);
  });

  it("outlasts a short drop of the player's connection, and goes when the player stays away", async () => {
    const { room, connect, toRoom, hangUp, a, l, r } = await paired();
    await hangUp(a);
    expect(r.closed).toBeNull();
    // Meanwhile the same remote may reconnect.
    const r2 = (await connect(l.id, "remote")) as FakeSocket;
    await toRoom(r2, { t: "join", key: l.key });
    expect(r2.closed).toBeNull();
    expect(r.closed?.code).toBe(4000);

    // The player comes back and says its key again: the remote stays.
    vi.setSystemTime(T0 + REMOTE_GRACE_MS - 1000);
    const back = (await connect("a")) as FakeSocket;
    await toRoom(back, { t: "join", remote: l.hash });
    vi.setSystemTime(T0 + REMOTE_GRACE_MS * 3);
    await room.alarm!();
    expect(r2.closed).toBeNull();

    // The player leaves for good.
    await hangUp(back);
    vi.setSystemTime(T0 + REMOTE_GRACE_MS * 4 + 1);
    await room.alarm!();
    expect(r2.closed?.code).toBe(4003);
    const late = (await connect(l.id, "remote")) as FakeSocket;
    await toRoom(late, { t: "join", key: l.key });
    expect(late.closed?.code).toBe(4003);
  });

  it("is each player's own: nobody pairs a remote whose key they didn't register", async () => {
    const { connect, say, toRoom, a, l, r } = await paired();
    const b = (await connect("b")) as FakeSocket;
    await toRoom(b, { t: "join" });
    await say(b, hello);

    // b asks for a's remote without a registration, then with one made up to match its id.
    await say(b, { to: "host", msg: { t: "pair", remoteId: l.id } });
    await toRoom(b, { t: "remote-key", hash: l.id + "0".repeat(48) });
    await say(b, { to: "host", msg: { t: "pair", remoteId: l.id } });
    const players = lastState(a)!.players;
    expect(players.find((p) => p.id === "a")?.remoteId).toBe(l.id);
    expect(players.find((p) => p.id === "b")?.remoteId).toBeUndefined();
    expect(r.closed).toBeNull();
    expect((b.deserializeAttachment() as { remoteHash?: string }).remoteHash).toBeUndefined();

    // b's own link works for b.
    const mine = await link();
    await toRoom(b, { t: "remote-key", hash: mine.hash });
    await say(b, { to: "host", msg: { t: "pair", remoteId: mine.id } });
    expect(lastState(a)!.players.find((p) => p.id === "b")?.remoteId).toBe(mine.id);
  });
});

describe("a House Tandem session on a relay socket", () => {
  const playtime = { to: "host", msg: { t: "playtime", s: 30 } };

  it("arrives in the first message; until the account service confirms it the socket is a guest", async () => {
    let confirm: (() => void) | undefined;
    const { connect, say, toRoom, plays, sessions } = await setup({
      ht: {
        verifySession: (t) =>
          new Promise((resolve) => {
            confirm = () => resolve(t === "good" ? { userId: 42, loginId: 7, name: "P", avatar: null } : null);
          }),
      },
    });
    void sessions;
    const a = (await connect("a")) as FakeSocket;
    await say(a, hello);
    await say(a, playtime);
    expect(plays).toEqual([]);

    const joining = toRoom(a, { t: "join", ht: "good" });
    await Promise.resolve();
    await say(a, playtime);
    expect(plays).toEqual([]);
    confirm!();
    await joining;
    await say(a, playtime);
    expect(plays).toEqual([["42", "dice", 30, 7]]);
  });

  it("is read once per socket; a session the service doesn't know leaves a guest who can still play", async () => {
    const { connect, say, toRoom, plays, sessions } = await setup();
    const a = (await connect("a")) as FakeSocket;
    await toRoom(a, { t: "join", ht: "stale" });
    await toRoom(a, { t: "join", ht: "good" });
    expect(sessions).toEqual(["stale"]);
    await say(a, hello);
    await say(a, playtime);
    expect(plays).toEqual([]);
    expect(lastState(a)?.players.map((p) => p.id)).toEqual(["a"]);
  });

  it("is not asked for in a Discord room (the ticket says who the player is), nor from a remote", async () => {
    const { connect, toRoom, sessions } = await setup({ roomName: "d" + "0".repeat(30) });
    const a = (await connect("a", "player", { "x-ht-user": "9" })) as FakeSocket;
    await toRoom(a, { t: "join", ht: "good" });
    const g = (await connect("g")) as FakeSocket;
    await toRoom(g, { t: "join", ht: "good" });
    expect(sessions).toEqual([]);
    expect((a.deserializeAttachment() as { userId: string }).userId).toBe("9");
    expect((g.deserializeAttachment() as { userId?: string }).userId).toBeUndefined();
  });
});

describe("message limits per socket", () => {
  it("drops what is over the limit, and closes a socket that keeps going", async () => {
    const { connect, say, toRoom } = await setup();
    const a = (await connect("a")) as FakeSocket;
    const b = (await connect("b")) as FakeSocket;
    await toRoom(a, { t: "join" });
    await say(a, hello);
    const shake = { to: "all", msg: { t: "shake", intensity: 0.5 } };
    // Two messages are already spent; the rest of the allowance, then as much again unheard.
    for (let i = 0; i < MESSAGE_BURST * 2 - 2; i++) await say(a, shake);
    expect(a.closed).toBeNull();
    for (let i = 0; i < 5; i++) await say(a, shake);
    expect(a.closed?.code).toBe(4008);
    // The other player is unaffected.
    await say(b, hello);
    expect(b.closed).toBeNull();
  });

  it("refills with time, so steady play is never limited", async () => {
    const { connect, say } = await setup();
    const a = (await connect("a")) as FakeSocket;
    const b = (await connect("b")) as FakeSocket;
    const heard = () => b.got.filter((m) => m.env?.msg.t === "shake").length;
    // 20 messages a second for a minute.
    for (let i = 0; i < 1200; i++) {
      vi.setSystemTime(T0 + i * 50);
      await say(a, { to: "all", msg: { t: "shake", intensity: 0.5 } });
    }
    expect(a.closed).toBeNull();
    expect(heard()).toBeGreaterThan(1000);
  });

  it("ignores a message over the size limit", async () => {
    const { connect, say } = await setup();
    const a = (await connect("a")) as FakeSocket;
    const before = a.sent.length;
    await say(a, JSON.stringify({ to: "host", msg: { t: "hello", player: { name: "x".repeat(70_000) } } }));
    expect(a.sent.length).toBe(before);
    expect(a.closed).toBeNull();
  });
});

describe("the Worker in front of the room", () => {
  const SECRET = "s3cret";

  async function worker(env: Record<string, unknown> = {}) {
    const mod = (await loadWorker()).default;
    const reached: Request[] = [];
    const full = {
      DISCORD_CLIENT_ID: "123",
      DISCORD_CLIENT_SECRET: SECRET,
      RELAY: { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => (reached.push(r), new FakeResponse(null, { status: 101 })) }) },
      ASSETS: { fetch: async () => new FakeResponse("", { status: 200 }) },
      ...env,
    };
    const call = (url: string, init: RequestInit = {}) =>
      mod.fetch(new Request(url, { ...init, headers: { "cf-connecting-ip": "203.0.113.5", ...(init.headers as Record<string, string>) } }) as never, full as never) as unknown as Promise<FakeResponse>;
    return { call, reached };
  }
  const ws = { Upgrade: "websocket" };

  it("limits token exchanges and new room connections per address, and only when the bindings exist", async () => {
    const seen: string[] = [];
    const limiter = (allow: number) => ({
      limit: async ({ key }: { key: string }) => {
        seen.push(key);
        return { success: allow-- > 0 };
      },
    });
    const { id, key } = await newIdentity();
    const limited = await worker({ TOKEN_RATE: limiter(0), ROOM_RATE: limiter(1) });
    expect((await limited.call("https://x/api/token", { method: "POST", body: "{}" })).status).toBe(429);
    expect((await limited.call(`https://x/api/relay/ROOM?id=${id}&key=${key}`, { headers: ws })).status).toBe(101);
    expect((await limited.call(`https://x/api/relay/ROOM?id=${id}&key=${key}`, { headers: ws })).status).toBe(429);
    expect(limited.reached).toHaveLength(1);
    expect(seen).toEqual(["203.0.113.5", "203.0.113.5", "203.0.113.5"]);

    const open = await worker();
    expect((await open.call("https://x/api/token", { method: "POST", body: "{}" })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await open.call(`https://x/api/relay/ROOM?id=${id}&key=${key}`, { headers: ws })).status).toBe(101);
  });

  it("passes a remote on without a key in the address, and still asks players for theirs", async () => {
    const { id, key } = await newIdentity();
    const { call, reached } = await worker();
    expect((await call(`https://x/api/relay/ROOM?id=${id}&role=remote`, { headers: ws })).status).toBe(101);
    expect((await call(`https://x/api/relay/ROOM?id=${id}`, { headers: ws })).status).toBe(403);
    expect((await call(`https://x/api/relay/ROOM?id=${id}&key=${key}`, { headers: ws })).status).toBe(101);
    expect(reached).toHaveLength(2);
  });

  it("takes a ticket for a Discord room until it expires, and names the account only from the ticket", async () => {
    const { id, key } = await newIdentity();
    const room = await discordRoom(SECRET, "inst");
    const { call, reached } = await worker();
    const url = (ticket: string, extra = "") => `https://x/api/relay/${room}?id=${id}&key=${key}&ticket=${ticket}${extra}`;

    const good = await roomTicket(SECRET, room, id, "42", 7);
    expect((await call(url(good, "&ht=tok"), { headers: { ...ws, "x-ht-user": "1" } })).status).toBe(101);
    expect(reached[0].headers.get("x-ht-user")).toBe("42");
    expect(reached[0].headers.get("x-ht-login")).toBe("7");

    const old = await roomTicket(SECRET, room, id, "42", 7, Date.now() - 1000);
    const res = await call(url(old), { headers: ws });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "ticket expired" });
    vi.setSystemTime(T0 + TICKET_TTL_MS + 1000);
    expect((await call(url(good), { headers: ws })).status).toBe(403);
    expect((await call(url(""), { headers: ws })).status).toBe(403);
    expect(reached).toHaveLength(1);
  });

  describe("token exchange", () => {
    /** Discord, as the Worker sees it. `instance`: what the activity-instance call answers. */
    function discord(instance: () => { status: number; users?: string[] } | "down") {
      const asked: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init: { headers?: Record<string, string> } = {}) => {
        asked.push(url);
        const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
        if (url.endsWith("/oauth2/token")) return reply(200, { access_token: "at" });
        if (url.endsWith("/users/@me")) return reply(200, { id: "555", username: "p" });
        if (url.includes("/activity-instances/")) {
          expect(init.headers?.authorization).toBe("Bot bot-token");
          const r = instance();
          if (r === "down") throw new Error("network");
          return reply(r.status, { users: r.users });
        }
        throw new Error("unexpected " + url);
      });
      return asked;
    }
    const exchange = async (env: Record<string, unknown>) => {
      const { call } = await worker(env);
      const pending = call("https://x/api/token", { method: "POST", body: JSON.stringify({ code: "c", instanceId: "i-1", playerId: "abcd" }) });
      await vi.runAllTimersAsync();
      const res = await pending;
      return { status: res.status, body: (await res.json()) as { ticket?: string; room?: string; retry?: boolean; access_token?: string } };
    };
    const BOT = { DISCORD_BOT_TOKEN: "bot-token" };

    it("with the bot token set, gives a ticket only to a user Discord lists in that instance", async () => {
      const asked = discord(() => ({ status: 200, users: ["111", "555"] }));
      const { status, body } = await exchange(BOT);
      expect(status).toBe(200);
      expect(body.room).toBe(await discordRoom(SECRET, "i-1"));
      expect(body.ticket).toBeTruthy();
      expect(asked.some((u) => u.endsWith("/applications/123/activity-instances/i-1"))).toBe(true);
    });

    it("refuses when the user isn't in the instance, or there is no such instance, after asking twice", async () => {
      for (const answer of [{ status: 200, users: ["111"] }, { status: 404 }]) {
        const asked = discord(() => answer);
        const { status, body } = await exchange(BOT);
        expect(status).toBe(403);
        expect(body.ticket).toBeUndefined();
        expect(body.access_token).toBeUndefined();
        expect(asked.filter((u) => u.includes("/activity-instances/"))).toHaveLength(2);
      }
    });

    it("takes a user who shows up in the instance on the second ask", async () => {
      let n = 0;
      discord(() => ({ status: 200, users: n++ ? ["555"] : [] }));
      expect((await exchange(BOT)).status).toBe(200);
    });

    it("refuses with a retryable error when Discord can't be reached or is busy, and plainly on any other answer", async () => {
      for (const answer of ["down", { status: 503 }, { status: 429 }] as const) {
        discord(() => answer);
        const { status, body } = await exchange(BOT);
        expect(status).toBe(503);
        expect(body.retry).toBe(true);
        expect(body.ticket).toBeUndefined();
      }
      discord(() => ({ status: 401 }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await exchange(BOT)).status).toBe(403);
      warn.mockRestore();
    });

    it("without the bot token, issues the ticket unchecked and says so in the log", async () => {
      const asked = discord(() => ({ status: 404 }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { status, body } = await exchange({});
      expect(status).toBe(200);
      expect(body.ticket).toBeTruthy();
      expect(asked.some((u) => u.includes("/activity-instances/"))).toBe(false);
      expect(warn.mock.calls.flat().join(" ")).toContain("DISCORD_BOT_TOKEN");
      warn.mockRestore();
    });
  });

  it("a web room's socket is a guest whatever the address says", async () => {
    const { id, key } = await newIdentity();
    const { call, reached } = await worker({ HT: { verifySession: async () => ({ userId: 42, name: "P", avatar: null }) } });
    expect((await call(`https://x/api/relay/ROOM?id=${id}&key=${key}&ht=good`, { headers: { ...ws, "x-ht-user": "1" } })).status).toBe(101);
    expect(reached[0].headers.get("x-ht-user")).toBeNull();
  });
});
