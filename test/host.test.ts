import { describe, expect, it } from "vitest";
import { HostAuthority, sanitizeName, type PlanFn } from "../src/game/host";
import type { Faces } from "../src/game/rules";
import type { Msg } from "../src/net/protocol";

function setup(faces: Faces[] = []) {
  let now = 1000;
  let id = 0;
  const plan: PlanFn = (rollId, shooter) => ({
    rollId,
    shooter,
    faces: faces.shift() ?? [1, 2],
    bodies: [] as never,
    frameCount: 120,
  });
  const host = new HostAuthority({ selfId: "a", plan, now: () => now, newId: () => `roll-${++id}` });
  return { host, advance: (ms: number) => (now += ms) };
}

const throwMsg: Msg = { t: "throw", input: { dir: [0, 1], speed: 0.5, spin: 0.5, source: "button" } };

describe("HostAuthority", () => {
  it("assigns distinct colors and increasing join order", () => {
    const { host } = setup();
    host.join("a", { name: "Alice" });
    host.join("b", { name: "Bob" });
    expect(new Set(host.players.map((p) => p.color)).size).toBe(2);
    expect(host.players[1].joinedAt).toBeGreaterThan(host.players[0].joinedAt);
  });

  it("updates rather than duplicates a rejoining player", () => {
    const { host } = setup();
    host.join("a", { name: "Alice" });
    host.join("a", { name: "Alicia" });
    expect(host.players).toHaveLength(1);
    expect(host.players[0].name).toBe("Alicia");
  });

  it("only accepts throws from the shooter, and not while dice are rolling", () => {
    const { host, advance } = setup([[3, 4], [1, 2]]);
    host.join("a", { name: "A" });
    host.join("b", { name: "B" });
    host.start(10);
    expect(host.handle("b", throwMsg)).toEqual([]);
    const [roll] = host.handle("a", throwMsg);
    expect(roll).toMatchObject({ t: "roll", plan: { faces: [3, 4], shooter: "a" } });
    expect(host.handle("a", throwMsg)).toEqual([]); // still rolling
    advance(5000);
    const [roll2] = host.handle("a", throwMsg);
    expect(roll2.t).toBe("roll");
    expect(host.game.shooterId).toBe("b");
  });

  it("does not send frameCount over the wire", () => {
    const { host } = setup();
    host.join("a", { name: "A" });
    host.start(10);
    const [roll] = host.handle("a", throwMsg);
    expect(roll.t === "roll" && "frameCount" in roll.plan).toBe(false);
  });

  it("rejects unknown targets", () => {
    const { host } = setup();
    host.join("a", {});
    host.start(999);
    expect(host.game.target).toBe(10);
  });

  it("prunes players who did not reconnect after a migration", () => {
    const { host } = setup();
    host.join("a", {});
    host.join("b", {});
    host.join("c", {});
    host.start(10);
    host.prune(new Set(["a", "c"]));
    expect(host.players.map((p) => p.id)).toEqual(["a", "c"]);
    expect(host.game.turnOrder).toEqual(["a", "c"]);
  });

  it("sanitizes names and avatars", () => {
    expect(sanitizeName("  \u0007Bob  ")).toBe("Bob");
    expect(sanitizeName("x".repeat(100))).toHaveLength(24);
    expect(sanitizeName(42)).toBe("Player");
    const { host } = setup();
    host.join("a", { name: "A", avatarUrl: "javascript:alert(1)" });
    expect(host.players[0].avatarUrl).toBeUndefined();
  });
});
