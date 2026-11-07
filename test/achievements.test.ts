import { describe, expect, it } from "vitest";
import { ACHIEVEMENTS } from "../src/achievements/defs";
import {
  applyDelta,
  emptyLifetime,
  evaluateMatchEnd,
  evaluateRoll,
  lifetimeEarned,
  mergeDeltas,
  newTrack,
  toLifetime,
  trackDeficits,
  type Track,
} from "../src/achievements/evaluate";
import type { Faces } from "../src/game/rules";
import { addPlayer, applyRoll, createGame, startMatch, type GameState } from "../src/game/sevenElevenDoubles";

function game(players: string[], target = 10): GameState {
  let g = createGame(target);
  for (const p of players) g = addPlayer(g, p);
  return startMatch(g, target);
}
let n = 0;
const roll = (g: GameState, faces: Faces) => applyRoll(g, `r${++n}`, faces);

describe("achievement defs", () => {
  it("has the 22 signed-off achievements with unique ids", () => {
    expect(ACHIEVEMENTS).toHaveLength(22);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(22);
  });
});

describe("evaluateRoll", () => {
  it("firsts: roll, seven, eleven, doubles, snake eyes, boxcars", () => {
    const t = newTrack();
    const g = game(["a"]);
    const ids = (faces: Faces) => {
      const next = roll(g, faces);
      return evaluateRoll(next.lastRoll!, next, t, false).earned;
    };
    expect(ids([1, 2])).toEqual(["first_roll"]);
    expect(ids([3, 4])).toContain("lucky_seven");
    expect(ids([5, 6])).toContain("eleven_heaven");
    expect(ids([1, 1])).toEqual(expect.arrayContaining(["seeing_double", "snake_eyes"]));
    expect(ids([6, 6])).toEqual(expect.arrayContaining(["seeing_double", "boxcars"]));
  });

  it("streaks of 3, 5 and 8 hits in one turn", () => {
    const t = newTrack();
    let g = game(["a"], 21);
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      g = roll(g, [3, 4]);
      seen.push(...evaluateRoll(g.lastRoll!, g, t, false).earned);
    }
    expect(seen.filter((x) => x === "hot_hand").length).toBeGreaterThan(0);
    expect(seen).toContain("on_fire");
    expect(seen).toContain("unstoppable");
  });

  it("Ice Cold after 5 turns passed on without scoring; a hit resets it", () => {
    const t = newTrack();
    let g = game(["a", "b"]);
    const earned: string[] = [];
    for (let i = 0; i < 4; i++) {
      g = roll(g, [1, 2]); // a misses
      earned.push(...evaluateRoll(g.lastRoll!, g, t, false).earned);
      g = roll(g, [1, 2]); // b misses
    }
    expect(earned).not.toContain("ice_cold");
    g = roll(g, [1, 2]);
    expect(evaluateRoll(g.lastRoll!, g, t, false).earned).toContain("ice_cold");
    const t2 = newTrack();
    t2.coldTurns = 4;
    g = roll(game(["a", "b"]), [3, 4]);
    evaluateRoll(g.lastRoll!, g, t2, false);
    expect(t2.coldTurns).toBe(0);
  });

  it("counts rolls, phone rolls, doubles bits and best streak", () => {
    const g = roll(game(["a"]), [6, 6]);
    const { delta } = evaluateRoll(g.lastRoll!, g, newTrack(), true);
    expect(delta).toEqual({ add: { rolls: 1, shakerRolls: 1 }, or: { doubles: 32 }, max: { bestStreak: 1 } });
  });
});

describe("evaluateMatchEnd", () => {
  const tracks = (ids: string[]) => new Map<string, Track>(ids.map((id) => [id, newTrack()]));

  it("winner: First Win, High Roller, Shutout, Run the Table; everyone: matches and Full Table", () => {
    let g = game(["a", "b", "c", "d"], 21);
    const tr = tracks(["a", "b", "c", "d"]);
    while (g.phase !== "matchOver") g = roll(g, [6, 6]);
    const out = evaluateMatchEnd(g, tr, new Map([["a", "1"], ["b", "2"]]));
    expect(out.get("a")!.earned).toEqual(expect.arrayContaining(["first_win", "high_roller", "shutout", "run_the_table", "full_table"]));
    expect(out.get("a")!.delta.add).toEqual({ matches: 1, wins: 1 });
    expect(out.get("b")!.earned).toEqual(["full_table"]);
    expect(out.get("a")!.delta.union).toEqual({ partners: ["2"] });
    expect(out.get("c")!.delta.union).toEqual({ partners: ["1", "2"] });
  });

  it("Comeback after trailing by 5, Photo Finish one point behind; no Run the Table after passing", () => {
    // b gets to 6, a gets nothing, then a comes back to win 10 to 9.
    let g = game(["a", "b"], 10);
    const tr = tracks(["a", "b"]);
    const step = (faces: Faces) => {
      const shooter = g.shooterId!;
      g = roll(g, faces);
      evaluateRoll(g.lastRoll!, g, tr.get(shooter)!, false);
      trackDeficits(g, tr);
    };
    step([1, 2]); // a misses
    step([2, 2]); step([2, 2]); step([2, 2]); step([3, 4]); step([3, 4]); step([3, 4]); // b: 9
    step([1, 2]); // b misses
    step([5, 5]); step([5, 5]); step([5, 5]); step([5, 5]); step([5, 5]); // a: 10
    expect(g.phase).toBe("matchOver");
    expect(g.scores).toEqual({ a: 10, b: 9 });
    const out = evaluateMatchEnd(g, tr, new Map());
    expect(out.get("a")!.earned).toEqual(expect.arrayContaining(["first_win", "comeback", "photo_finish"]));
    expect(out.get("a")!.earned).not.toContain("run_the_table");
    expect(out.get("a")!.earned).not.toContain("shutout");
  });
});

describe("lifetime", () => {
  it("thresholds", () => {
    const l = { ...emptyLifetime(), doubles: 63, matches: 25, rolls: 1000, shakerRolls: 25, partners: Array.from({ length: 10 }, (_, i) => String(i)) };
    expect(lifetimeEarned(l).sort()).toEqual(["full_set", "good_company", "regular", "shaker", "thousand_rolls"]);
    expect(lifetimeEarned({ ...l, doubles: 31, matches: 24, rolls: 999, shakerRolls: 24, partners: ["1"] })).toEqual([]);
  });

  it("merges deltas like the account service", () => {
    let l = toLifetime({ rolls: 5, doubles: 1, bestStreak: 4, partners: ["1"], junk: "x" });
    l = applyDelta(l, mergeDeltas({ add: { rolls: 1 }, or: { doubles: 2 } }, { add: { rolls: 2, matches: 1 }, max: { bestStreak: 3 }, union: { partners: ["1", "2"] } }));
    expect(l).toMatchObject({ rolls: 8, matches: 1, doubles: 3, bestStreak: 4, partners: ["1", "2"] });
  });
});
