import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanFn } from "../src/game/host";
import { addPlayer, createGame, startMatch } from "../src/game/sevenElevenDoubles";
import type { Envelope, Msg, Target } from "../src/net/protocol";
import { RelayTransport } from "../src/net/relay";
import { RECONNECT_GRACE_MS, Room } from "../src/net/room";
import { Emitter, type Transport, type TransportEvents } from "../src/net/transport";

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
const self = (id: string) => ({ id, key: "k", name: id.toUpperCase() });

function hostRoom(now: { t: number }) {
  const t = new FakeTransport();
  const room = new Room(t, self("h"), plan, () => now.t);
  t.events.emit("host-change", true);
  return { t, room };
}

const env = (from: string, msg: Msg, to: Target = "host"): Envelope => ({ from, to, msg });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Room as host", () => {
  it("adds players on hello and broadcasts state", () => {
    const now = { t: 0 };
    const { t, room } = hostRoom(now);
    t.events.emit("message", env("a", { t: "hello", player: { name: "Alice" } }));
    expect(room.players.map((p) => p.id)).toEqual(["h", "a"]);
    expect(t.sent.at(-1)?.msg.t).toBe("state");
  });

  it("keeps a briefly disconnected player, and drops one who stays away", () => {
    const now = { t: 0 };
    const { t, room } = hostRoom(now);
    t.events.emit("message", env("a", { t: "hello", player: { name: "A" } }));
    t.events.emit("message", env("b", { t: "hello", player: { name: "B" } }));
    t.events.emit("peers", ["h", "a", "b"]);

    t.events.emit("peers", ["h", "b"]); // a drops
    now.t += RECONNECT_GRACE_MS - 1000;
    room.prune();
    expect(room.players.map((p) => p.id)).toContain("a");
    t.events.emit("peers", ["h", "a", "b"]); // a is back
    now.t += 5000;
    room.prune();
    expect(room.players.map((p) => p.id)).toContain("a");

    t.events.emit("peers", ["h", "a"]); // b drops for good
    now.t += RECONNECT_GRACE_MS;
    room.prune();
    expect(room.players.map((p) => p.id)).toEqual(["h", "a"]);
  });

  it("clamps shake intensity from the shooter and ignores everyone else's", () => {
    const now = { t: 0 };
    const { t, room } = hostRoom(now);
    t.events.emit("message", env("a", { t: "hello", player: { name: "A" } }));
    room.start(10); // h shoots first
    const shakes: number[] = [];
    room.on("shake", (_f, i) => shakes.push(i));
    t.events.emit("message", env("h", { t: "shake", intensity: 1e6 }, "all"));
    t.events.emit("message", env("a", { t: "shake", intensity: 0.5 }, "all"));
    expect(shakes).toEqual([1]);
  });
});

describe("Room host migration", () => {
  it("drops the old host and gives everyone else the grace period", () => {
    const now = { t: 1000 };
    const t = new FakeTransport();
    const room = new Room(t, self("b"), plan, () => now.t);
    t.events.emit("host-change", false);
    expect(t.sent[0]).toMatchObject({ msg: { t: "hello" }, to: "host" });

    // Last state from the old host "a": a, b, c in a match.
    let game = ["a", "b", "c"].reduce(addPlayer, createGame());
    game = startMatch(game);
    const players = ["a", "b", "c"].map((id, i) => ({ id, name: id, color: "#fff", joinedAt: i }));
    t.events.emit("message", env("a", { t: "state", players, game, hostId: "a" }, "all"));

    t.events.emit("host-change", true);
    expect(room.isHost).toBe(true);
    expect(room.players.map((p) => p.id)).toEqual(["b", "c"]);
    expect(room.game.shooterId).toBe("b"); // a was shooting; dice passed on

    t.events.emit("peers", ["b"]); // c hasn't reconnected yet
    now.t += RECONNECT_GRACE_MS - 1;
    room.prune();
    expect(room.players.map((p) => p.id)).toEqual(["b", "c"]);
    now.t += 2;
    room.prune();
    expect(room.players.map((p) => p.id)).toEqual(["b"]);
  });
});

describe("RelayTransport", () => {
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    constructor(public url: string) {
      FakeSocket.instances.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {}
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    peers(ids: string[]) {
      this.onmessage?.({ data: JSON.stringify({ type: "peers", ids }) });
    }
    drop() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  it("re-announces itself to an unchanged host after reconnecting", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { href: "https://dice.example/" });
    const relay = new RelayTransport("ROOM", "b", "key", "/api");
    const changes: boolean[] = [];
    relay.on("host-change", (isHost) => changes.push(isHost));
    const connected = relay.connect();
    const first = FakeSocket.instances.at(-1)!;
    expect(first.url).toContain("key=key");
    first.open();
    first.peers(["a", "b"]);
    await connected;
    expect(changes).toEqual([false]);

    first.peers(["a", "b", "c"]); // same host, same socket: no re-announce
    expect(changes).toEqual([false]);

    first.drop();
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    second.open();
    second.peers(["a", "b"]);
    expect(changes).toEqual([false, false]);
    relay.close();
    vi.unstubAllGlobals();
  });
});
