import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanFn } from "../src/game/host";
import type { Msg, Target } from "../src/net/protocol";
import { Room } from "../src/net/room";
import { Emitter, type Transport, type TransportEvents } from "../src/net/transport";
import { createPlaytime } from "../src/platform/playtime";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function clock() {
  const c = { t: 1_000_000, doc: { visibilityState: "visible" } };
  return c;
}

/** Advance both the fake timers and the helper's clock, 5 s at a time. */
function advance(c: { t: number }, ms: number) {
  for (let left = ms; left > 0; left -= 5000) {
    c.t += Math.min(5000, left);
    vi.advanceTimersByTime(Math.min(5000, left));
  }
}

describe("createPlaytime (port of Tandemonium js/playtime.js)", () => {
  it("reports whole-second deltas about once a minute while visible and signed in", () => {
    const c = clock();
    const sent: number[] = [];
    const pt = createPlaytime({ game: "dice", send: (s) => (sent.push(s), true), now: () => c.t, doc: c.doc, win: null });
    pt.start();
    advance(c, 60_000);
    expect(sent).toEqual([60]);
    advance(c, 60_000);
    expect(sent).toEqual([60, 60]);
    pt.stop();
  });

  it("counts nothing signed out, hidden, or idle", () => {
    const c = clock();
    const sent: number[] = [];
    let signedIn = false;
    const pt = createPlaytime({
      game: "dice",
      send: (s) => (sent.push(s), true),
      signedIn: () => signedIn,
      idleMs: 180_000,
      now: () => c.t,
      doc: c.doc,
      win: null,
    });
    pt.start();
    advance(c, 120_000);
    expect(pt.pending).toBe(0);
    signedIn = true;
    pt.noteActivity();
    advance(c, 300_000); // active for 3 minutes, then idle
    expect(sent.reduce((a, b) => a + b, 0) + pt.pending).toBeCloseTo(180, 0);
    pt.noteActivity();
    c.doc.visibilityState = "hidden";
    const before = sent.reduce((a, b) => a + b, 0) + pt.pending;
    advance(c, 60_000);
    expect(sent.reduce((a, b) => a + b, 0) + pt.pending).toBe(before);
    pt.stop();
  });

  it("keeps the seconds when send says it couldn't send", () => {
    const c = clock();
    let ok = false;
    const sent: number[] = [];
    const pt = createPlaytime({ game: "dice", send: (s) => (ok ? (sent.push(s), true) : false), now: () => c.t, doc: c.doc, win: null });
    pt.start();
    advance(c, 60_000);
    expect(sent).toEqual([]);
    expect(pt.pending).toBeCloseTo(60);
    ok = true;
    advance(c, 60_000);
    expect(sent).toEqual([120]);
    pt.stop();
  });
});

class FakeTransport implements Transport {
  readonly kind = "relay";
  isHost = false;
  serverHosted = true;
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

describe("Room.reportPlaytime", () => {
  it("sends { t: 'playtime', s } to the host only while connected to a server-hosted relay", () => {
    const t = new FakeTransport();
    const room = new Room(t, { id: "a", key: "k", name: "A" }, plan);
    expect(room.reportPlaytime(60)).toBe(false); // not connected yet
    t.events.emit("status", { kind: "connected" });
    expect(room.reportPlaytime(60)).toBe(true);
    expect(t.sent.at(-1)).toEqual({ msg: { t: "playtime", s: 60 }, to: "host" });
    t.events.emit("status", { kind: "reconnecting" });
    expect(room.reportPlaytime(60)).toBe(false);
    t.serverHosted = false; // a PeerJS-style host has no account service
    t.events.emit("status", { kind: "connected" });
    expect(room.reportPlaytime(60)).toBe(false);
  });
});
