import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostAuthority, type PlanFn } from "../src/game/host";
import type { Envelope, Msg, Target } from "../src/net/protocol";
import { RelayTransport } from "../src/net/relay";
import { Room } from "../src/net/room";
import { Emitter, type Transport, type TransportEvents } from "../src/net/transport";
import { motionVerdict, type MotionEnv } from "../src/platform/capabilities";
import { splitPeers } from "../worker/src/peers";
import { DISCORD_ROOM_RE, discordRoom, roomTicket, verifyRoomTicket } from "../worker/src/roomTicket";

const R1 = "0123456789abcdef";
const R2 = "fedcba9876543210";
const throwMsg: Msg = { t: "throw", input: { dir: [0, 1], speed: 0.5, spin: 0.5, source: "motion" } };

function setupHost() {
  let now = 1000;
  let id = 0;
  const plan: PlanFn = (rollId, shooter) => ({ rollId, shooter, faces: [1, 2], bodies: [] as never, frameCount: 120 });
  const host = new HostAuthority({ selfId: "a", plan, now: () => now, newId: () => `roll-${++id}` });
  host.join("a", { name: "A" });
  host.join("b", { name: "B" });
  return { host, advance: (ms: number) => (now += ms) };
}

describe("HostAuthority pairing", () => {
  it("pairs a remote to a player and broadcasts it", () => {
    const { host } = setupHost();
    const [state] = host.handle("a", { t: "pair", remoteId: R1 });
    expect(state.t).toBe("state");
    expect(host.players[0]).toMatchObject({ remoteId: R1, remoteOnline: false });
  });

  it("rejects malformed remote ids, player ids, and pairing by non-players", () => {
    const { host } = setupHost();
    expect(host.handle("a", { t: "pair", remoteId: "nope" })).toEqual([]);
    expect(host.handle("a", { t: "pair", remoteId: "b" })).toEqual([]);
    expect(host.handle("zz", { t: "pair", remoteId: R1 })).toEqual([]);
  });

  it("throws for the paired player when it's their turn, and only then", () => {
    const { host, advance } = setupHost();
    host.handle("a", { t: "pair", remoteId: R1 });
    host.handle("b", { t: "pair", remoteId: R2 });
    host.start(10); // a shoots first
    expect(host.handle(R2, throwMsg, true)).toEqual([]); // b's remote, not b's turn
    const [roll] = host.handle(R1, throwMsg, true);
    expect(roll).toMatchObject({ t: "roll", plan: { shooter: "a" } });
    expect(roll.t === "roll" && roll.landsInMs).toBe(2000);
    advance(5000);
    expect(host.handle("c0ffee00c0ffee00", throwMsg, true)).toEqual([]); // unpaired remote
  });

  it("only lets remotes ask for state and throw", () => {
    const { host } = setupHost();
    host.handle("a", { t: "pair", remoteId: R1 });
    expect(host.handle(R1, { t: "hello", player: { name: "Sneaky" } }, true)).toEqual([]);
    expect(host.handle(R1, { t: "pair", remoteId: R2 }, true)).toEqual([]);
    expect(host.handle(R1, { t: "unpair" }, true)).toEqual([]);
    expect(host.players).toHaveLength(2);
    expect(host.handle(R1, { t: "remote-hello" }, true)[0].t).toBe("state");
  });

  it("re-pairing replaces the old remote, and a remote belongs to one player", () => {
    const { host } = setupHost();
    host.handle("a", { t: "pair", remoteId: R1 });
    host.handle("a", { t: "pair", remoteId: R2 });
    host.start(10);
    expect(host.handle(R1, throwMsg, true)).toEqual([]); // the old link is dead
    host.handle("b", { t: "pair", remoteId: R2 });
    expect(host.players.find((p) => p.id === "a")?.remoteId).toBeUndefined();
    expect(host.players.find((p) => p.id === "b")?.remoteId).toBe(R2);
  });

  it("unpairs, tracks online state, and keeps pairings across a migration", () => {
    const { host } = setupHost();
    host.handle("a", { t: "pair", remoteId: R1 });
    expect(host.remotesOnline(new Set(["a", "b", R1]))[0]?.t).toBe("state");
    expect(host.remotesOnline(new Set(["a", "b", R1]))).toEqual([]); // no change, no broadcast
    expect(host.players[0].remoteOnline).toBe(true);

    const next = new HostAuthority({ selfId: "b", plan: (() => {}) as never });
    next.restore(host.players, host.game);
    expect(next.players[0].remoteId).toBe(R1);

    host.handle("a", { t: "unpair" });
    expect(host.players[0].remoteId).toBeUndefined();
  });
});

class FakeTransport implements Transport {
  readonly kind = "relay";
  isHost = false;
  sent: { msg: Msg; to: Target }[] = [];
  events = new Emitter<TransportEvents>();
  on<K extends keyof TransportEvents>(e: K, cb: TransportEvents[K]) {
    this.events.on(e, cb);
  }
  connect() {
    return Promise.resolve();
  }
  send(msg: Msg, to: Target) {
    this.sent.push({ msg, to });
  }
  close() {}
}

const plan: PlanFn = (rollId, shooter) => ({ rollId, shooter, faces: [1, 2], bodies: [] as never, frameCount: 60 });
const env = (from: string, msg: Msg, to: Target = "host", remote?: boolean): Envelope => ({ from, to, msg, remote });

describe("Room with a shaker remote", () => {
  it("as host: pairs, accepts the shooter's remote's shakes and throws, and marks it online", () => {
    const t = new FakeTransport();
    const room = new Room(t, { id: "h", key: "k", name: "H" }, plan);
    t.events.emit("host-change", true);
    t.events.emit("message", env("a", { t: "hello", player: { name: "A" } }));
    room.pair(R1);
    t.events.emit("peers", ["h", "a", R1]);
    expect(room.players[0]).toMatchObject({ id: "h", remoteId: R1, remoteOnline: true });

    room.start(10); // h shoots first
    const shakes: string[] = [];
    room.on("shake", (from) => shakes.push(from));
    t.events.emit("message", env(R1, { t: "shake", intensity: 0.5 }, "all", true));
    t.events.emit("message", env(R2, { t: "shake", intensity: 0.5 }, "all", true));
    expect(shakes).toEqual([R1]);

    const rolls: string[] = [];
    room.on("roll", (p) => rolls.push(p.shooter));
    t.events.emit("message", env(R1, throwMsg, "host", true));
    expect(rolls).toEqual(["h"]);
  });

  it("ignores a hello from a remote, so it can never join as a player", () => {
    const t = new FakeTransport();
    const room = new Room(t, { id: "h", key: "k", name: "H" }, plan);
    t.events.emit("host-change", true);
    t.events.emit("message", env(R1, { t: "hello", player: { name: "X" } }, "host", true));
    expect(room.players.map((p) => p.id)).toEqual(["h"]);
  });

  it("as remote: never takes the host role, and asks the host for state", () => {
    const t = new FakeTransport();
    const room = new Room(t, { id: R1, key: "k", name: "remote" }, plan, Date.now, "remote");
    t.events.emit("host-change", true);
    expect(room.isHost).toBe(false);
    expect(t.sent).toEqual([{ msg: { t: "remote-hello" }, to: "host" }]);
    room.throwDice(throwMsg.t === "throw" ? throwMsg.input : (null as never));
    expect(t.sent.at(-1)).toMatchObject({ msg: { t: "throw" }, to: "host" });
  });
});

describe("RelayTransport roles", () => {
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    constructor(public url: string) {
      FakeSocket.instances.push(this);
    }
    send() {}
    close() {}
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { href: "https://dice.example/" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends role and ticket, and gives the host remotes as peers", async () => {
    const relay = new RelayTransport("ROOM", "h", "key", "/api", { ticket: "t1" });
    const peers: string[][] = [];
    relay.on("peers", (ids) => peers.push(ids));
    const done = relay.connect();
    const ws = FakeSocket.instances.at(-1)!;
    expect(ws.url).toContain("ticket=t1");
    expect(ws.url).not.toContain("role=");
    ws.readyState = 1;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: "peers", ids: ["h", "a"], remotes: [R1] }) });
    await done;
    expect(relay.isHost).toBe(true);
    expect(peers.at(-1)).toEqual(["h", "a", R1]);
    relay.close();

    const remote = new RelayTransport("ROOM", R1, "key", "/api", { role: "remote" });
    void remote.connect();
    expect(FakeSocket.instances.at(-1)!.url).toContain("role=remote");
    remote.close();
  });
});

describe("relay host election", () => {
  const sock = (id: string, joinedAt: number, role?: "player" | "remote") => ({ att: { id, joinedAt, role } });

  it("never makes a remote the host, even if it connected first", () => {
    const { players, remotes } = splitPeers([sock("b", 3), sock(R1, 1, "remote"), sock("a", 2, "player")]);
    expect(players.map((s) => s.att.id)).toEqual(["a", "b"]);
    expect(remotes.map((s) => s.att.id)).toEqual([R1]);
  });

  it("treats sockets from before roles existed as players", () => {
    expect(splitPeers([sock("a", 1)]).players).toHaveLength(1);
  });
});

describe("Discord room tickets", () => {
  it("derives a stable room that hides the instance id", async () => {
    const room = await discordRoom("secret", "i-123-gc-456-789");
    expect(room).toMatch(DISCORD_ROOM_RE);
    expect(room).not.toContain("123");
    expect(await discordRoom("secret", "i-123-gc-456-789")).toBe(room);
    expect(await discordRoom("other", "i-123-gc-456-789")).not.toBe(room);
  });

  it("binds a ticket to the room, the player and the secret", async () => {
    const room = await discordRoom("secret", "inst");
    const ticket = await roomTicket("secret", room, R1);
    expect(await verifyRoomTicket("secret", room, R1, ticket)).toBe(true);
    expect(await verifyRoomTicket("secret", room, R2, ticket)).toBe(false);
    expect(await verifyRoomTicket("other", room, R1, ticket)).toBe(false);
    expect(await verifyRoomTicket("secret", await discordRoom("secret", "x"), R1, ticket)).toBe(false);
    expect(await verifyRoomTicket("secret", room, R1, undefined)).toBe(false);
  });

  it("standalone room codes can't be mistaken for Discord rooms", () => {
    expect(DISCORD_ROOM_RE.test("ABC123")).toBe(false);
    expect(DISCORD_ROOM_RE.test("D0123456789ABCDEF0123456789ABCD")).toBe(false);
  });
});

describe("motionVerdict", () => {
  const phone: MotionEnv = {
    hasApi: true,
    hasRequestPermission: false,
    policyAllows: true,
    inDiscord: false,
    coarsePointer: true,
    touchPoints: 5,
    forceOff: false,
  };

  it("probes on an ordinary phone", () => expect(motionVerdict(phone)).toBe("probe"));
  it("asks on iOS", () => expect(motionVerdict({ ...phone, hasRequestPermission: true, policyAllows: null })).toBe("needs-permission"));
  it("is blocked when the frame's policy forbids it (Discord on Android)", () =>
    expect(motionVerdict({ ...phone, inDiscord: true, policyAllows: false })).toBe("blocked"));
  it("is blocked in Discord when the browser can't say (iOS)", () =>
    expect(motionVerdict({ ...phone, inDiscord: true, hasRequestPermission: true, policyAllows: null })).toBe("blocked"));
  it("works in Discord if Discord ever allows it", () => expect(motionVerdict({ ...phone, inDiscord: true })).toBe("probe"));
  it("is unavailable on a desktop", () =>
    expect(motionVerdict({ ...phone, coarsePointer: false, touchPoints: 0, hasRequestPermission: true })).toBe("unavailable"));
  it("is unavailable without the API, or with ?nomotion", () => {
    expect(motionVerdict({ ...phone, hasApi: false })).toBe("unavailable");
    expect(motionVerdict({ ...phone, forceOff: true })).toBe("unavailable");
  });
});

describe("remote links", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("put the key in the fragment and round-trip", async () => {
    vi.stubGlobal("location", { search: "", href: "https://dice.example/", origin: "https://dice.example" });
    const { remoteLink, parseRemoteLink } = await import("../src/remote/link");
    const key = "0123456789abcdef0123456789abcdef";
    const link = remoteLink("d0123456789abcdef0123456789abc", "relay", key, "https://dice.housetandem.com");
    expect(link).toBe(`https://dice.housetandem.com/remote?room=d0123456789abcdef0123456789abc&t=relay#k=${key}`);
    expect(parseRemoteLink(link)).toEqual({ room: "d0123456789abcdef0123456789abc", transport: "relay", key });
    expect(parseRemoteLink("https://x/remote?room=AB&t=peerjs#k=bad")).toEqual({ room: "AB", transport: "peerjs", key: null });
    expect(parseRemoteLink("https://x/remote")).toBeNull();
  });
});
