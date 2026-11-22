import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeAvatar, type PlanFn } from "../src/game/host";
import { keyHash, playerIdFromKey } from "../src/net/identityKey";
import type { Envelope, Msg, Target } from "../src/net/protocol";
import { RelayTransport } from "../src/net/relay";
import { Room } from "../src/net/room";
import { Emitter, type Transport, type TransportEvents, type TransportStatus } from "../src/net/transport";
import { MESSAGE_BURST, MESSAGES_PER_SECOND, newBucket, take, withinLimit } from "../worker/src/limits";
import type { Attachment } from "../worker/src/peers";
import { registration, remoteOwner, REMOTE_GRACE_MS, reviewRemotes } from "../worker/src/remotes";

class Sock {
  static OPEN = 1;
  static all: Sock[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e?: { code?: number }) => void;
  constructor(public url: string) {
    Sock.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  peers(ids: string[], remotes: string[] = []) {
    this.onmessage?.({ data: JSON.stringify({ type: "peers", ids, remotes }) });
  }
  drop(code?: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get messages() {
    return this.sent.map((d) => JSON.parse(d));
  }
}
const last = () => Sock.all.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  Sock.all = [];
  vi.stubGlobal("WebSocket", Sock);
  vi.stubGlobal("location", { href: "https://game.example/" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("what a relay socket says first", () => {
  it("a player: its session and its remote key's hash, in a message; neither is in the address", async () => {
    const relay = new RelayTransport("ROOM", "a", "playerkey", "/api", { ht: "session-token" });
    void relay.connect();
    expect(last().url).toBe("wss://game.example/api/relay/ROOM?id=a&key=playerkey");
    last().open();
    expect(last().messages).toEqual([{ to: "server", msg: { t: "join", ht: "session-token" } }]);

    relay.registerRemote("f".repeat(64));
    expect(last().messages.at(-1)).toEqual({ to: "server", msg: { t: "remote-key", hash: "f".repeat(64) } });

    // A reconnect says both again.
    last().peers(["a"]);
    last().drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(Sock.all).toHaveLength(2);
    last().open();
    expect(last().messages).toEqual([{ to: "server", msg: { t: "join", ht: "session-token", remote: "f".repeat(64) } }]);

    relay.registerRemote(null);
    expect(last().messages.at(-1)).toEqual({ to: "server", msg: { t: "remote-key" } });
    relay.close();
  });

  it("a guest still says hello to the room, with nothing in it", () => {
    const relay = new RelayTransport("ROOM", "a", "playerkey", "/api");
    void relay.connect();
    last().open();
    expect(last().messages).toEqual([{ to: "server", msg: { t: "join" } }]);
    relay.close();
  });

  it("a remote: the key from its link, in a message and not in the address", () => {
    const relay = new RelayTransport("ROOM", "r1", "remotekey", "/api", { role: "remote" });
    void relay.connect();
    expect(last().url).toBe("wss://game.example/api/relay/ROOM?id=r1&role=remote");
    last().open();
    expect(last().messages).toEqual([{ to: "server", msg: { t: "join", key: "remotekey" } }]);
    relay.close();
  });
});

describe("a remote the relay turns away", () => {
  it("says it is not linked and keeps asking, more and more slowly, until the link works", async () => {
    const relay = new RelayTransport("ROOM", "r1", "remotekey", "/api", { role: "remote" });
    const seen: TransportStatus["kind"][] = [];
    relay.on("status", (s) => seen.push(s.kind));
    let joined = false;
    void relay.connect().then(() => (joined = true));

    last().open();
    last().drop(4003);
    expect(seen.at(-1)).toBe("unlinked");
    await vi.advanceTimersByTimeAsync(900);
    expect(Sock.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(Sock.all).toHaveLength(2);

    last().open();
    last().drop(4003);
    await vi.advanceTimersByTimeAsync(1900);
    expect(Sock.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(Sock.all).toHaveLength(3);

    // Never more often than every 8 s, however long it goes on.
    for (let i = 0; i < 6; i++) {
      last().open();
      last().drop(4003);
      await vi.advanceTimersByTimeAsync(8_000);
    }
    const count = Sock.all.length;
    last().open();
    last().drop(4003);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(Sock.all).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(200);

    // The player pairs it again: the next try gets in.
    last().open();
    last().peers(["a"], ["r1"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(joined).toBe(true);
    expect(seen.at(-1)).toBe("connected");
    relay.close();
  });
});

describe("a ticket the relay no longer takes", () => {
  it("is replaced through refreshTicket after two tries that never opened, and the new one is used", async () => {
    const asked: number[] = [];
    const relay = new RelayTransport("ROOM", "a", "playerkey", "/api", {
      ticket: "old",
      refreshTicket: async () => {
        asked.push(Date.now());
        return "new";
      },
    });
    void relay.connect();
    last().open();
    last().peers(["a"]);
    expect(last().url).toContain("ticket=old");

    last().drop(); // the connection goes
    await vi.advanceTimersByTimeAsync(500);
    last().drop(); // refused: never opened
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toHaveLength(0);
    expect(last().url).toContain("ticket=old");
    last().drop(); // refused again
    await vi.advanceTimersByTimeAsync(2000);
    expect(asked).toHaveLength(1);
    expect(last().url).toContain("ticket=new");
    last().open();
    last().peers(["a"]);
    relay.close();
  });

  it("is kept when no new one can be had, and a new one is asked for at most every 30 s", async () => {
    let calls = 0;
    const relay = new RelayTransport("ROOM", "a", "playerkey", "/api", {
      ticket: "old",
      refreshTicket: async () => {
        calls++;
        throw new Error("offline");
      },
    });
    void relay.connect();
    last().open();
    last().peers(["a"]);
    last().drop();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      last().drop();
    }
    expect(calls).toBe(1);
    expect(last().url).toContain("ticket=old");
    await vi.advanceTimersByTimeAsync(30_000);
    last().drop();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toBe(2);
    relay.close();
  });

  it("is also replaced on the first connection, before giving up", async () => {
    const relay = new RelayTransport("ROOM", "a", "playerkey", "/api", { ticket: "old", refreshTicket: async () => "new" });
    void relay.connect();
    last().drop();
    await vi.advanceTimersByTimeAsync(500);
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().url).toContain("ticket=new");
    relay.close();
  });
});

/** What a Room takes after the transport and the player. */
const roomArgs = (): [PlanFn] => [(rollId, shooter) => ({ rollId, shooter, faces: [1, 2], bodies: [] as never, frameCount: 60 })];

class FakeTransport implements Transport {
  readonly kind = "relay";
  isHost = false;
  sent: { msg: Msg; to: Target }[] = [];
  registered: (string | null)[] = [];
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
  registerRemote(hash: string | null) {
    this.registered.push(hash);
  }
  close() {}
}

describe("Room and the remote key", () => {
  it("registers the key's hash before asking to pair, and clears it on unpair", async () => {
    const t = new FakeTransport();
    const room = new Room(t, { id: "a", key: "k", name: "A" }, ...roomArgs());
    t.events.emit("host-change", false);
    const key = "0123456789abcdef0123456789abcdef";
    const hash = await keyHash(key);
    expect(hash.slice(0, 16)).toBe(await playerIdFromKey(key));
    room.pair(hash.slice(0, 16), hash);
    expect(t.registered).toEqual([hash]);
    expect(t.sent.at(-1)).toEqual({ msg: { t: "pair", remoteId: hash.slice(0, 16) }, to: "host" });
    room.unpair();
    expect(t.registered).toEqual([hash, null]);
  });
});

describe("player pictures in a state message", () => {
  it("are kept only when they are https URLs on Discord's CDN", () => {
    const t = new FakeTransport();
    const room = new Room(t, { id: "b", key: "k", name: "B" }, ...roomArgs());
    t.events.emit("host-change", false);
    const seen: (string | undefined)[][] = [];
    room.on("state", (players) => seen.push(players.map((p) => p.avatarUrl)));
    const urls = [
      "https://cdn.discordapp.com/avatars/1/abc.png?size=64",
      "http://cdn.discordapp.com/avatars/1/abc.png",
      "https://cdn.discordapp.com.example.net/a.png",
      "https://example.net/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      42,
      undefined,
    ];
    const players = urls.map((avatarUrl, i) => ({ id: `p${i}`, name: `P${i}`, color: "#fff", joinedAt: i, avatarUrl }));
    const env: Envelope = { from: "host", to: "all", msg: { t: "state", players, game: room.game, hostId: "host" } as never };
    t.events.emit("message", env);
    expect(seen).toEqual([[urls[0], undefined, undefined, undefined, undefined, undefined, undefined, undefined]]);
    expect(room.players.map((p) => p.avatarUrl)).toEqual(seen[0]);
    expect(room.players.every((p, i) => p.id === `p${i}`)).toBe(true);
    expect("avatarUrl" in room.players[1]).toBe(false);
    for (const u of urls.slice(1)) expect(sanitizeAvatar(u)).toBeUndefined();
  });

  it("a state without a player list is ignored", () => {
    const t = new FakeTransport();
    const room = new Room(t, { id: "b", key: "k", name: "B" }, ...roomArgs());
    t.events.emit("host-change", false);
    t.events.emit("message", { from: "host", to: "all", msg: { t: "state", players: "x", game: room.game, hostId: "host" } as never });
    expect(room.players).toEqual([]);
  });
});

describe("the per-socket message allowance", () => {
  it("takes a burst, drops what is over, and closes only a socket that stays over", () => {
    const b = newBucket(0);
    for (let i = 0; i < MESSAGE_BURST; i++) expect(take(b, 0)).toBe("ok");
    for (let i = 0; i < MESSAGE_BURST; i++) expect(take(b, 0)).toBe("drop");
    expect(take(b, 0)).toBe("close");
  });

  it("refills at the stated rate and never past the burst", () => {
    const b = newBucket(0);
    for (let i = 0; i < MESSAGE_BURST; i++) take(b, 0);
    expect(take(b, 0)).toBe("drop");
    // One second later: a second's worth is back (less the one that was dropped).
    for (let i = 0; i < MESSAGES_PER_SECOND - 1; i++) expect(take(b, 1000)).toBe("ok");
    expect(take(b, 1000)).toBe("drop");
    const rested = newBucket(0);
    for (let i = 0; i < MESSAGE_BURST; i++) expect(take(rested, 3_600_000)).toBe("ok");
    expect(take(rested, 3_600_000)).toBe("drop");
  });

  it("a rate-limit binding that is missing or fails is no limit", async () => {
    expect(await withinLimit(undefined, "k")).toBe(true);
    expect(await withinLimit({ limit: async () => ({ success: false }) }, "k")).toBe(false);
    expect(
      await withinLimit(
        {
          limit: async () => {
            throw new Error("binding");
          },
        },
        "k",
      ),
    ).toBe(true);
  });
});

describe("which remotes a room takes (worker/src/remotes.ts)", () => {
  const H = "a".repeat(64);
  const RID = H.slice(0, 16);
  const sock = (att: Partial<Attachment> & { id: string }) => ({ att: { joinedAt: 0, ...att } as Attachment });
  const player = (id: string, remoteHash?: string) => sock({ id, role: "player", joined: true, ...(remoteHash ? { remoteHash } : {}) });

  it("a registration must be a hash, and its remote id can't be anyone else's", () => {
    expect(registration([player("p1")], "p1", H)).toBe(H);
    expect(registration([player("p1", H)], "p1", null)).toBeNull();
    expect(registration([player("p1")], "p1", "abc")).toBeUndefined();
    expect(registration([player("p1")], "p1", RID + "Z".repeat(48))).toBeUndefined();
    // Another player already registered a key with that remote id.
    expect(registration([player("p1", H), player("p2")], "p2", RID + "0".repeat(48))).toBeUndefined();
    // A remote with that id is playing for another player.
    expect(registration([player("p2"), sock({ id: RID, role: "remote", owner: "p1", keyHash: H })], "p2", H)).toBeUndefined();
    // A player's own id is never a remote id.
    expect(registration([player("p1"), player(RID)], "p1", H)).toBeUndefined();
    // Registering the same key again is fine.
    expect(registration([player("p1", H)], "p1", H)).toBe(H);
  });

  it("a remote is owned by the player whose registration matches the whole hash", () => {
    expect(remoteOwner([player("p1", H)], RID, H)).toEqual({ owner: "p1" });
    expect(remoteOwner([player("p1", H)], "f".repeat(16), H)).toBeNull();
    expect(remoteOwner([player("p1", RID + "0".repeat(48))], RID, H)).toBeNull();
    expect(remoteOwner([player("p1")], RID, H)).toBeNull();
    // A remote still waiting to join doesn't vouch for another.
    expect(remoteOwner([sock({ id: RID, role: "remote", pending: true })], RID, H)).toBeNull();
    // One already here does, while its player is away.
    expect(remoteOwner([sock({ id: RID, role: "remote", owner: "p1", keyHash: H, orphanedAt: 5 })], RID, H)).toEqual({ owner: "p1", orphanedAt: 5 });
  });

  it("a remote stays while its player holds the registration, and for a while after the player drops", () => {
    const remote = sock({ id: RID, role: "remote", owner: "p1", keyHash: H });
    expect(reviewRemotes([player("p1", H), remote], 0)).toEqual({ close: [], update: [] });
    expect(reviewRemotes([player("p1"), remote], 0).close).toEqual([remote]);
    expect(reviewRemotes([player("p1", "b".repeat(64)), remote], 0).close).toEqual([remote]);

    // The player is gone, or back but hasn't said its first message yet.
    for (const others of [[], [sock({ id: "p1", role: "player" })]]) {
      const gone = reviewRemotes([...others, remote], 1000);
      expect(gone.close).toEqual([]);
      expect(gone.update).toEqual([{ sock: remote, att: { ...remote.att, orphanedAt: 1000 } }]);
    }
    const orphan = sock({ ...remote.att, orphanedAt: 1000 });
    expect(reviewRemotes([orphan], 1000 + REMOTE_GRACE_MS).close).toEqual([]);
    expect(reviewRemotes([orphan], 1001 + REMOTE_GRACE_MS).close).toEqual([orphan]);
    // Back in time, with the same key.
    expect(reviewRemotes([player("p1", H), orphan], 5000).update).toEqual([{ sock: orphan, att: remote.att }]);
  });
});
