import { describe, expect, it } from "vitest";
import { classify, pointsFor, type Faces } from "../src/game/rules";
import {
  addPlayer,
  applyRoll,
  createGame,
  rematch,
  removePlayer,
  startMatch,
  HISTORY_LIMIT,
  type GameState,
} from "../src/game/sevenElevenDoubles";

const allFaces: Faces[] = [];
for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) allFaces.push([a, b]);

function game(ids: string[], target = 10): GameState {
  return startMatch(ids.reduce(addPlayer, createGame(target)));
}

describe("classify", () => {
  it("classifies all 36 combinations", () => {
    const counts = { seven: 0, eleven: 0, doubles: 0, miss: 0 };
    for (const f of allFaces) counts[classify(f) ?? "miss"]++;
    expect(counts).toEqual({ seven: 6, eleven: 2, doubles: 6, miss: 22 });
  });

  it("scores doubles as 2 and 7/11 as 1", () => {
    expect(pointsFor([3, 3])).toBe(2);
    expect(pointsFor([6, 6])).toBe(2);
    expect(pointsFor([3, 4])).toBe(1);
    expect(pointsFor([5, 6])).toBe(1);
    expect(pointsFor([1, 2])).toBe(0);
  });

  it("averages 20/36 points per roll", () => {
    expect(allFaces.reduce((s, f) => s + pointsFor(f), 0)).toBe(20);
  });
});

describe("applyRoll", () => {
  it("keeps the dice with the shooter on a hit", () => {
    let g = game(["a", "b"]);
    g = applyRoll(g, "r1", [3, 4]);
    expect(g.shooterId).toBe("a");
    expect(g.scores.a).toBe(1);
    expect(g.streak).toBe(1);
    g = applyRoll(g, "r2", [2, 2]);
    expect(g.scores.a).toBe(3);
    expect(g.streak).toBe(2);
    expect(g.lastRoll).toMatchObject({ hit: "doubles", points: 2, total: 4 });
  });

  it("passes the dice on a miss and wraps around", () => {
    let g = game(["a", "b", "c"]);
    g = applyRoll(g, "r1", [1, 2]);
    expect(g.shooterId).toBe("b");
    expect(g.streak).toBe(0);
    g = applyRoll(g, "r2", [1, 2]);
    g = applyRoll(g, "r3", [1, 2]);
    expect(g.shooterId).toBe("a");
  });

  it("ends the match mid-streak when the target is reached, even overshooting", () => {
    let g = game(["a", "b"], 5);
    g = applyRoll(g, "r1", [6, 6]); // 2
    g = applyRoll(g, "r2", [6, 6]); // 4
    g = applyRoll(g, "r3", [5, 5]); // 6
    expect(g.phase).toBe("matchOver");
    expect(g.winnerId).toBe("a");
    expect(g.scores.a).toBe(6);
    expect(applyRoll(g, "r4", [3, 4])).toBe(g);
  });

  it("caps history", () => {
    let g = game(["a"], 1000);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) g = applyRoll(g, `r${i}`, [1, 2]);
    expect(g.history).toHaveLength(HISTORY_LIMIT);
    expect(g.history[0].rollId).toBe(`r${HISTORY_LIMIT + 4}`);
  });

  it("ignores rolls outside a match", () => {
    const lobby = addPlayer(createGame(), "a");
    expect(applyRoll(lobby, "r", [3, 4])).toBe(lobby);
  });
});

describe("players joining and leaving", () => {
  it("adds late joiners at the end with 0 points", () => {
    let g = applyRoll(game(["a", "b"]), "r", [3, 4]);
    g = addPlayer(g, "c");
    expect(g.turnOrder).toEqual(["a", "b", "c"]);
    expect(g.scores.c).toBe(0);
    expect(addPlayer(g, "c")).toBe(g);
  });

  it("passes the dice to the next player when the shooter leaves", () => {
    let g = game(["a", "b", "c"]);
    g = applyRoll(g, "r", [1, 2]); // b shoots
    g = removePlayer(g, "b");
    expect(g.shooterId).toBe("c");
    g = removePlayer(g, "c");
    expect(g.shooterId).toBe("a");
  });

  it("resets to the lobby when everyone leaves", () => {
    let g = game(["a"]);
    g = removePlayer(g, "a");
    expect(g.phase).toBe("lobby");
    expect(g.turnOrder).toEqual([]);
  });

  it("rotates the first shooter on rematch and resets scores", () => {
    let g = game(["a", "b"], 5);
    g = applyRoll(g, "r1", [6, 6]);
    g = applyRoll(g, "r2", [6, 6]);
    g = applyRoll(g, "r3", [6, 6]);
    g = startMatch(rematch(g));
    expect(g.shooterId).toBe("b");
    expect(g.scores).toEqual({ a: 0, b: 0 });
    expect(g.winnerId).toBeNull();
  });
});

describe("rejoining", () => {
  it("restores a player's score when they come back mid-match", () => {
    let g = game(["a", "b"]);
    g = applyRoll(g, "r1", [3, 3]); // a: 2
    g = removePlayer(g, "a");
    expect(g.turnOrder).toEqual(["b"]);
    g = addPlayer(g, "a");
    expect(g.scores.a).toBe(2);
    expect(g.turnOrder).toEqual(["b", "a"]);
  });

  it("starts the next match without departed players' scores", () => {
    let g = game(["a", "b"]);
    g = applyRoll(g, "r1", [3, 3]);
    g = startMatch(rematch(removePlayer(g, "a")));
    expect(g.scores).toEqual({ b: 0 });
  });
});
