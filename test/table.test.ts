import { describe, expect, it } from "vitest";
import type { PlanFn } from "../src/game/host";
import type { Faces } from "../src/game/rules";
import type { Msg } from "../src/net/protocol";
import { readRoomTicket, roomTicket } from "../worker/src/roomTicket";
import { RECONNECT_GRACE_MS, TableServer, type Conn, type HouseTandem, type Saved } from "../worker/src/table";

const throwMsg = (source: "button" | "motion" = "button"): Msg => ({ t: "throw", input: { dir: [0, 1], speed: 0.5, spin: 0.5, source } });

function setup(faces: Faces[] = [], opts: { ht?: boolean; profile?: { earned: string[]; stats: Record<string, unknown> } } = {}) {
  const now = { t: 1_000 };
  const sent: Msg[] = [];
  let saved: Saved | undefined;
  const records: { userId: string; delta: unknown; earned: string[] }[] = [];
  const pending: Promise<unknown>[] = [];
  const stored = new Map<string, Set<string>>();
  const ht: HouseTandem = {
    resolveDiscord: async () => ({ userId: 1, name: "x", avatar: null }),
    verifySession: async () => null,
    gameProfile: async () => opts.profile ?? { earned: [], stats: {} },
    recordGame: async (userId, _game, delta, earned) => {
      records.push({ userId, delta, earned });
      const have = stored.get(userId) ?? new Set(opts.profile?.earned ?? []);
      stored.set(userId, have);
      const newlyEarned = earned.filter((id) => !have.has(id));
      for (const id of newlyEarned) have.add(id);
      return { newlyEarned };
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
  });
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  return { table, now, sent, records, settle, saved: () => saved };
}

const A: Conn = { id: "a", role: "player", userId: "11" };
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
    expect(records[0]).toMatchObject({ userId: "11", delta: { add: { rolls: 1, shakerRolls: 1 } } });
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
  });
});

describe("room tickets carry the account", () => {
  it("binds the House Tandem user id; a swapped id fails; old tickets are guests", async () => {
    const t = await roomTicket("s3cret", "d" + "0".repeat(30), "abcd", "42");
    expect(t).toMatch(/^42\.[0-9a-f]{32}$/);
    expect(await readRoomTicket("s3cret", "d" + "0".repeat(30), "abcd", t)).toEqual({ ok: true, userId: "42" });
    expect((await readRoomTicket("s3cret", "d" + "0".repeat(30), "abcd", t.replace(/^42/, "43"))).ok).toBe(false);
    expect((await readRoomTicket("s3cret", "d" + "0".repeat(30), "other", t)).ok).toBe(false);
    const old = await roomTicket("s3cret", "d" + "0".repeat(30), "abcd");
    expect(await readRoomTicket("s3cret", "d" + "0".repeat(30), "abcd", old)).toEqual({ ok: true });
  });
});
