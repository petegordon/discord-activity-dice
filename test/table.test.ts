import { describe, expect, it } from "vitest";
import type { PlanFn } from "../src/game/host";
import type { Faces } from "../src/game/rules";
import type { Msg } from "../src/net/protocol";
import { loginIdOf } from "../worker/src/peers";
import { readRoomTicket, roomTicket, TICKET_TTL_MS } from "../worker/src/roomTicket";
import { MIN_PLAYTIME_GAP_MS, RECONNECT_GRACE_MS, TableServer, type Conn, type HouseTandem, type Saved } from "../worker/src/table";

const throwMsg = (source: "button" | "motion" = "button"): Msg => ({ t: "throw", input: { dir: [0, 1], speed: 0.5, spin: 0.5, source } });

function setup(faces: Faces[] = [], opts: { ht?: boolean; profile?: { earned: string[]; stats: Record<string, unknown> }; recordPlay?: HouseTandem["recordPlay"] } = {}) {
  const now = { t: 1_000 };
  const sent: Msg[] = [];
  let saved: Saved | undefined;
  const records: { userId: string; delta: unknown; earned: string[]; loginId: number | null | undefined }[] = [];
  const pending: Promise<unknown>[] = [];
  const plays: { userId: string | number; game: string; seconds: number; loginId?: number | null }[] = [];
  const logs: string[] = [];
  const stored = new Map<string, Set<string>>();
  const ht: HouseTandem = {
    resolveDiscord: async () => ({ userId: 1, name: "x", avatar: null }),
    verifySession: async () => null,
    gameProfile: async () => opts.profile ?? { earned: [], stats: {} },
    recordGame: async (userId, _game, delta, earned, loginId) => {
      records.push({ userId, delta, earned, loginId });
      const have = stored.get(userId) ?? new Set(opts.profile?.earned ?? []);
      stored.set(userId, have);
      const newlyEarned = earned.filter((id) => !have.has(id));
      for (const id of newlyEarned) have.add(id);
      return { newlyEarned };
    },
    recordPlay: async (userId, game, seconds, loginId) => {
      plays.push({ userId, game, seconds, loginId });
      if (opts.recordPlay) return opts.recordPlay(userId, game, seconds, loginId);
      return { seconds, sessions: 1, firstPlayed: null, lastPlayed: null, added: seconds };
    },
  };
  const plan: PlanFn = (rollId, shooter) => ({ rollId, shooter, faces: faces.shift() ?? [1, 2], bodies: [] as never, frameCount: 1 });
  const table = new TableServer({
    plan,
    now: () => now.t,
    broadcast: (msgs) => sent.push(...msgs),
    save: (s) => (saved = JSON.parse(JSON.stringify(s))),
    ht: opts.ht === false ? undefined : ht,
    wait: (p) => pending.push(p),
    log: (m) => logs.push(m),
  });
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  return { table, now, sent, records, plays, logs, settle, saved: () => saved };
}

const A: Conn = { id: "a", role: "player", userId: "11", loginId: 5 };
/** Signed in through an account service from before logins: no login id. */
const OLD: Conn = { id: "o", role: "player", userId: "33" };
const B: Conn = { id: "b", role: "player" }; // guest
const hello = (name: string): Msg => ({ t: "hello", player: { name } });

describe("TableServer (the relay room is the host)", () => {
  it("only the earliest player starts; rolls are picked here and broadcast", () => {
    const { table, sent, now } = setup([[1, 2]]);
    table.connected([A, B]);
    table.handle(A, hello("Ann"), false);
    now.t += 5;
    table.handle(B, hello("Bob"), false);
    table.handle(B, { t: "start", target: 10 }, false);
    expect(table.authority.game.phase).toBe("lobby");
    table.handle(A, { t: "start", target: 5 }, false);
    expect(table.authority.game).toMatchObject({ phase: "awaitingThrow", target: 5, shooterId: "a" });
    table.handle(B, throwMsg(), false); // not B's turn
    expect(sent.filter((m) => m.t === "roll")).toHaveLength(0);
    table.handle(A, throwMsg(), false);
    const rolls = sent.filter((m) => m.t === "roll");
    expect(rolls).toHaveLength(1);
    expect(table.authority.game.shooterId).toBe("b"); // a missed with 1+2
  });

  it("credits signed-in players and toasts only what was new; guests earn nothing", async () => {
    const { table, sent, records, settle } = setup([[1, 1], [1, 1], [1, 2], [3, 4]]);
    table.connected([A, B]);
    table.handle(A, hello("Ann"), false);
    table.handle(B, hello("Bob"), false);
    table.handle(A, { t: "start", target: 10 }, false);
    table.handle(A, throwMsg(), false); // snake eyes
    await settle();
    const toast = sent.filter((m): m is Extract<Msg, { t: "achievement" }> => m.t === "achievement");
    expect(toast).toHaveLength(1);
    expect(toast[0].playerId).toBe("a");
    expect(toast[0].ids).toEqual(expect.arrayContaining(["first_roll", "seeing_double", "snake_eyes"]));
    table.handle(A, throwMsg(), false); // snake eyes again: nothing new
    await settle();
    expect(sent.filter((m) => m.t === "achievement")).toHaveLength(1);
    table.handle(A, throwMsg(), false); // miss → b
    table.handle(B, throwMsg(), false); // guest b rolls a 7
    await settle();
    expect(records.every((r) => r.userId === "11")).toBe(true);
    expect(records.every((r) => r.loginId === 5)).toBe(true); // under the login that signed in
    expect(records[0].delta).toMatchObject({ add: { rolls: 1 }, or: { doubles: 1 } });
  });

  it("a shaker remote throws for its paired player and counts as a phone roll", async () => {
    const { table, records, settle } = setup([[1, 2]]);
    table.connected([A]);
    table.handle(A, hello("Ann"), false);
    table.handle(A, { t: "pair", remoteId: "0123456789abcdef" }, false);
    table.handle(A, { t: "start", target: 10 }, false);
    table.handle({ id: "0123456789abcdef", role: "remote" }, throwMsg("motion"), true);
    await settle();
    expect(records[0]).toMatchObject({ userId: "11", loginId: 5, delta: { add: { rolls: 1, shakerRolls: 1 } } });
  });

  it("a player with no login id (older account service) is still credited, with null for the login", async () => {
    const { table, sent, records, plays, settle } = setup([[1, 1]]);
    table.connected([OLD]);
    table.handle(OLD, hello("Old"), false);
    table.handle(OLD, { t: "start", target: 10 }, false);
    table.handle(OLD, throwMsg(), false);
    table.handle(OLD, { t: "playtime", s: 60 } as Msg, false);
    await settle();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ userId: "33", loginId: null });
    expect(sent.some((m) => m.t === "achievement")).toBe(true);
    expect(plays).toEqual([{ userId: "33", game: "dice", seconds: 60, loginId: null }]);
  });

  it("the login is the socket's: a reconnect under another login moves it, and a message can't set it", async () => {
    const { table, records, plays, settle } = setup([[1, 2], [1, 2]]);
    table.connected([A]);
    table.handle(A, hello("Ann"), false);
    table.handle(A, { t: "start", target: 10 }, false);
    table.handle(A, { ...throwMsg(), loginId: 99, userId: "77" } as never, false);
    table.handle(A, { t: "playtime", s: 30, loginId: 99 } as never, false);
    const again: Conn = { ...A, loginId: 6 };
    table.connected([again]);
    table.handle(again, throwMsg(), false);
    table.connected([{ id: "a", role: "player", userId: "11" }]); // and then with none
    expect(table.logins.has("a")).toBe(false);
    await settle();
    expect(records.map((r) => [r.userId, r.loginId])).toEqual([
      ["11", 5],
      ["11", 6],
    ]);
    expect(plays).toEqual([{ userId: "11", game: "dice", seconds: 30, loginId: 5 }]);
  });

  it("lifetime achievements use the account's saved stats", async () => {
    const { table, sent, settle } = setup([[3, 4]], { profile: { earned: ["first_roll"], stats: { rolls: 999 } } });
    table.connected([A]);
    table.handle(A, hello("Ann"), false);
    table.handle(A, { t: "start", target: 10 }, false);
    table.handle(A, throwMsg(), false);
    await settle();
    const ids = sent.filter((m): m is Extract<Msg, { t: "achievement" }> => m.t === "achievement").flatMap((m) => m.ids);
    expect(ids).toEqual(expect.arrayContaining(["thousand_rolls", "lucky_seven"]));
    expect(ids).not.toContain("first_roll");
  });

  it("without the account service it still plays, and saves nothing", async () => {
    const { table, sent, settle } = setup([[1, 1]], { ht: false });
    table.connected([A]);
    table.handle(A, hello("Ann"), false);
    table.handle(A, { t: "start", target: 10 }, false);
    table.handle(A, throwMsg(), false);
    await settle();
    expect(sent.some((m) => m.t === "roll")).toBe(true);
    expect(sent.some((m) => m.t === "achievement")).toBe(false);
  });

  it("drops a player who stays away past the grace period; survives a restore", () => {
    const { table, now, saved } = setup();
    table.connected([A, B]);
    table.handle(A, hello("Ann"), false);
    table.handle(B, hello("Bob"), false);
    table.connected([A]);
    expect(table.nextPruneAt()).toBe(now.t + RECONNECT_GRACE_MS);
    now.t += RECONNECT_GRACE_MS - 1;
    table.prune();
    expect(table.authority.players.map((p) => p.id)).toEqual(["a", "b"]);
    now.t += 1;
    table.prune();
    expect(table.authority.players.map((p) => p.id)).toEqual(["a"]);

    const again = setup();
    again.table.restore(saved());
    expect(again.table.authority.players.map((p) => p.id)).toEqual(["a"]);
    expect(again.table.accounts.get("a")).toBe("11");
    expect(again.table.logins.get("a")).toBe(5);

    // A room saved before logins were tracked still loads; its players just have no login yet.
    const { logins: _logins, ...older } = saved()!;
    const old = setup();
    old.table.restore(older);
    expect(old.table.accounts.get("a")).toBe("11");
    expect(old.table.logins.size).toBe(0);
  });
});

describe("room tickets carry the account", () => {
  const room = "d" + "0".repeat(30);

  it("binds the House Tandem user id; a swapped id fails; a ticket with no account is a guest", async () => {
    const t = await roomTicket("s3cret", room, "abcd", "42");
    expect(t).toMatch(/^[0-9]+.42..[0-9a-f]{32}$/);
    expect(await readRoomTicket("s3cret", room, "abcd", t)).toEqual({ ok: true, userId: "42" });
    expect((await readRoomTicket("s3cret", room, "abcd", t.replace(".42.", ".43."))).ok).toBe(false);
    expect((await readRoomTicket("s3cret", room, "other", t)).ok).toBe(false);
    const guest = await roomTicket("s3cret", room, "abcd");
    expect(await readRoomTicket("s3cret", room, "abcd", guest)).toEqual({ ok: true });
    expect((await readRoomTicket("s3cret", room, "abcd", guest.replace("..", ".42."))).ok).toBe(false); // nor an account added to one
  });

  it("binds the login id too; a swapped, dropped or added login fails", async () => {
    const t = await roomTicket("s3cret", room, "abcd", "42", 7);
    expect(t).toMatch(/^[0-9]+.42.7.[0-9a-f]{32}$/);
    expect(await readRoomTicket("s3cret", room, "abcd", t)).toEqual({ ok: true, userId: "42", loginId: 7 });
    expect((await readRoomTicket("s3cret", room, "abcd", t.replace(".42.7.", ".42.8."))).ok).toBe(false);
    expect((await readRoomTicket("s3cret", room, "abcd", t.replace(".42.7.", ".43.7."))).ok).toBe(false);
    expect((await readRoomTicket("s3cret", room, "abcd", t.replace(".42.7.", ".42.."))).ok).toBe(false);
    const plain = await roomTicket("s3cret", room, "abcd", "42", null, 5_000_000);
    expect(await roomTicket("s3cret", room, "abcd", "42", undefined, 5_000_000)).toBe(plain);
    expect((await readRoomTicket("s3cret", room, "abcd", plain.replace(".42..", ".42.7."), 0)).ok).toBe(false);
  });

  it("a ticket stops working after 12 hours, and its date can't be moved", async () => {
    const issued = 1_700_000_000_000;
    const t = await roomTicket("s3cret", room, "abcd", "42", 7, issued + TICKET_TTL_MS);
    expect(TICKET_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(await readRoomTicket("s3cret", room, "abcd", t, issued)).toEqual({ ok: true, userId: "42", loginId: 7 });
    expect((await readRoomTicket("s3cret", room, "abcd", t, issued + TICKET_TTL_MS - 1000)).ok).toBe(true);
    expect(await readRoomTicket("s3cret", room, "abcd", t, issued + TICKET_TTL_MS)).toEqual({ ok: false, expired: true });
    const exp = Number(t.split(".")[0]);
    const later = t.replace(String(exp), String(exp + 3600));
    expect(await readRoomTicket("s3cret", room, "abcd", later, issued + TICKET_TTL_MS)).toEqual({ ok: false });
    // A ticket issued now runs out 12 hours from now.
    const fresh = await roomTicket("s3cret", room, "abcd");
    expect((await readRoomTicket("s3cret", room, "abcd", fresh)).ok).toBe(true);
    expect((await readRoomTicket("s3cret", room, "abcd", fresh, Date.now() + TICKET_TTL_MS + 1000)).expired).toBe(true);
  });

  it("tickets in the form used before they carried a date are not taken", async () => {
    for (const old of ["0".repeat(32), "42." + "0".repeat(32), "42.7." + "0".repeat(32), "", undefined, 7]) {
      expect(await readRoomTicket("s3cret", room, "abcd", old)).toEqual({ ok: false });
    }
  });

  it("reads a login id only from an integer (an older service sends none)", () => {
    expect(loginIdOf(7)).toBe(7);
    expect(loginIdOf("7")).toBe(7);
    for (const v of [undefined, null, "", "x", "7x", 1.5, -1, Number.NaN, {}, true]) expect(loginIdOf(v)).toBeNull();
  });
});

describe("time in game (housetandem-web #37)", () => {
  const playtime = (s: unknown): Msg => ({ t: "playtime", s }) as Msg;

  it("credits the socket's verified account, clamped to 1..600 whole seconds", async () => {
    const { table, plays, sent, saved, settle, now } = setup();
    table.connected([A, B]);
    table.handle(A, hello("Ann"), false);
    const before = { sent: sent.length, saved: JSON.stringify(saved()) };
    table.handle(A, playtime(61.9), false);
    now.t += 60_000;
    table.handle(A, playtime(5_000), false);
    await settle();
    expect(plays).toEqual([
      { userId: "11", game: "dice", seconds: 61, loginId: 5 },
      { userId: "11", game: "dice", seconds: 600, loginId: 5 },
    ]);
    // Bookkeeping only: nothing broadcast, the game isn't touched.
    expect(sent.length).toBe(before.sent);
    expect(JSON.stringify(saved())).toBe(before.saved);
  });

  it("passes on one report per account per 20 s, whichever connection sends it", async () => {
    const { table, plays, settle, now } = setup();
    const A2: Conn = { id: "a2", role: "player", userId: "11", loginId: 5 }; // the same account in another tab
    table.connected([A, A2, OLD]);
    for (let i = 0; i < 500; i++) table.handle(i % 2 ? A : A2, playtime(600), false);
    table.handle(OLD, playtime(60), false); // someone else is not held back
    await settle();
    expect(plays.map((p) => p.userId)).toEqual(["11", "33"]);
    now.t += MIN_PLAYTIME_GAP_MS - 1;
    table.handle(A, playtime(60), false);
    now.t += 1;
    table.handle(A2, playtime(60), false);
    await settle();
    expect(plays.filter((p) => p.userId === "11")).toHaveLength(2);
  });

  it("ignores guests, remotes, junk and missing deltas", async () => {
    const { table, plays, settle } = setup();
    table.connected([A, B]);
    table.handle(B, playtime(60), false); // guest
    table.handle({ id: "r", role: "remote", userId: "11" }, playtime(60), true); // a remote, even one claiming an account
    table.handle(A, playtime(60), true); // flagged as a remote by the relay
    for (const s of [0, 0.5, -10, Number.NaN, "60x", null, undefined]) table.handle(A, playtime(s), false);
    await settle();
    expect(plays).toEqual([]);
  });

  it("does nothing without the account service", () => {
    const { table } = setup([], { ht: false });
    table.connected([A]);
    expect(() => table.handle(A, playtime(60), false)).not.toThrow();
  });

  it("a rejected or throwing recordPlay (account service not deployed yet) never breaks the game", async () => {
    const rejecting = setup([[1, 2]], { recordPlay: async () => Promise.reject(new Error("no such method")) });
    rejecting.table.connected([A]);
    rejecting.table.handle(A, hello("Ann"), false);
    rejecting.table.handle(A, playtime(60), false);
    await expect(rejecting.settle()).resolves.toBeUndefined();
    expect(rejecting.logs).toContain("recordPlay failed");
    rejecting.table.handle(A, { t: "start", target: 5 }, false);
    expect(rejecting.table.authority.game.phase).toBe("awaitingThrow");

    const throwing = setup([], {
      recordPlay: () => {
        throw new Error("sync throw");
      },
    });
    throwing.table.connected([A]);
    expect(() => throwing.table.handle(A, playtime(60), false)).not.toThrow();
    await throwing.settle();
    expect(throwing.logs).toContain("recordPlay failed");
  });
});

describe("a remote asking for the table", () => {
  const R: Conn = { id: "r", role: "remote" };

  it("is answered alone: nothing is broadcast or saved, however often it asks", () => {
    const now = { t: 1_000 };
    const all: Msg[] = [];
    const direct: { to: string; msgs: Msg[] }[] = [];
    let saves = 0;
    const table = new TableServer({
      plan: (rollId, shooter) => ({ rollId, shooter, faces: [1, 2], bodies: [] as never, frameCount: 1 }),
      now: () => now.t,
      broadcast: (msgs) => all.push(...msgs),
      send: (to, msgs) => direct.push({ to, msgs }),
      save: () => saves++,
    });
    table.connected([A, R]);
    table.handle(A, hello("Ann"), false);
    const before = { all: all.length, saves };
    for (let i = 0; i < 200; i++) table.handle(R, { t: "remote-hello" }, true);
    expect(all.length).toBe(before.all);
    expect(saves).toBe(before.saves);
    expect(direct).toHaveLength(200);
    expect(direct[0]).toMatchObject({ to: "r", msgs: [{ t: "state" }] });
    // A player's own messages still reach everyone and are saved.
    table.handle(A, { t: "start", target: 5 }, false);
    expect(all.length).toBeGreaterThan(before.all);
    expect(saves).toBeGreaterThan(before.saves);
  });

  it("a table with nobody at it and nobody expected back is empty", () => {
    const { table, now } = setup();
    expect(table.empty(0)).toBe(true);
    table.connected([A]);
    table.handle(A, hello("Ann"), false);
    expect(table.empty(1)).toBe(false);
    table.connected([]); // Ann's connection dropped: her place is held
    expect(table.empty(0)).toBe(false);
    now.t += RECONNECT_GRACE_MS;
    table.prune();
    expect(table.empty(0)).toBe(true);
  });
});
