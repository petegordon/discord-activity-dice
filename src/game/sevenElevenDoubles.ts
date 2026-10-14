import { classify, DEFAULT_TARGET, HIT_POINTS, type Faces, type HitKind } from "./rules";

export type RollRecord = {
  rollId: string;
  shooter: string;
  faces: Faces;
  total: number;
  hit: HitKind | null;
  points: number;
};

export type GamePhase = "lobby" | "awaitingThrow" | "matchOver";

export type GameState = {
  phase: GamePhase;
  shooterId: string | null;
  /** Player ids in turn order (join order). */
  turnOrder: string[];
  scores: Record<string, number>;
  target: number;
  /** Consecutive hits in the current turn. */
  streak: number;
  winnerId: string | null;
  lastRoll: RollRecord | null;
  /** Most recent first, capped at HISTORY_LIMIT. */
  history: RollRecord[];
  /** Index into turnOrder of the first shooter of the current match; rotates on rematch. */
  firstShooterIndex: number;
};

export const HISTORY_LIMIT = 20;

export function createGame(target = DEFAULT_TARGET): GameState {
  return {
    phase: "lobby",
    shooterId: null,
    turnOrder: [],
    scores: {},
    target,
    streak: 0,
    winnerId: null,
    lastRoll: null,
    history: [],
    firstShooterIndex: 0,
  };
}

export function addPlayer(state: GameState, id: string): GameState {
  if (state.turnOrder.includes(id)) return state;
  return {
    ...state,
    turnOrder: [...state.turnOrder, id],
    scores: { ...state.scores, [id]: state.scores[id] ?? 0 },
  };
}

export function removePlayer(state: GameState, id: string): GameState {
  const idx = state.turnOrder.indexOf(id);
  if (idx === -1) return state;
  const turnOrder = state.turnOrder.filter((p) => p !== id);
  // Scores are kept, so a player who drops out and rejoins mid-match gets theirs back.

  if (turnOrder.length === 0) {
    return { ...createGame(state.target), history: state.history };
  }

  let { shooterId, streak, phase } = state;
  if (shooterId === id) {
    // The player after the leaver now sits at the leaver's old index.
    shooterId = turnOrder[idx % turnOrder.length];
    streak = 0;
  }
  if (state.winnerId === id && phase === "matchOver") phase = "lobby";
  return {
    ...state,
    phase,
    turnOrder,
    shooterId,
    streak,
    firstShooterIndex: Math.min(state.firstShooterIndex, turnOrder.length - 1),
  };
}

export function startMatch(state: GameState, target = state.target): GameState {
  if (state.turnOrder.length === 0) return state;
  const scores = Object.fromEntries(state.turnOrder.map((id) => [id, 0]));
  const first = state.firstShooterIndex % state.turnOrder.length;
  return {
    ...state,
    phase: "awaitingThrow",
    target,
    scores,
    streak: 0,
    winnerId: null,
    lastRoll: null,
    shooterId: state.turnOrder[first],
  };
}

/** Back to the lobby with the next player as first shooter. */
export function rematch(state: GameState): GameState {
  const n = Math.max(state.turnOrder.length, 1);
  return {
    ...state,
    phase: "lobby",
    shooterId: null,
    streak: 0,
    winnerId: null,
    firstShooterIndex: (state.firstShooterIndex + 1) % n,
  };
}

export function nextShooter(state: GameState, current: string): string {
  const idx = state.turnOrder.indexOf(current);
  return state.turnOrder[(idx + 1) % state.turnOrder.length];
}

export function canThrow(state: GameState, playerId: string): boolean {
  return state.phase === "awaitingThrow" && state.shooterId === playerId;
}

export function applyRoll(state: GameState, rollId: string, faces: Faces): GameState {
  if (state.phase !== "awaitingThrow" || !state.shooterId) return state;
  const shooter = state.shooterId;
  const hit = classify(faces);
  const points = hit ? HIT_POINTS[hit] : 0;
  const record: RollRecord = { rollId, shooter, faces, total: faces[0] + faces[1], hit, points };
  const history = [record, ...state.history].slice(0, HISTORY_LIMIT);
  const score = (state.scores[shooter] ?? 0) + points;
  const scores = { ...state.scores, [shooter]: score };

  if (score >= state.target) {
    return { ...state, scores, history, lastRoll: record, phase: "matchOver", winnerId: shooter, streak: state.streak + 1 };
  }
  if (hit) {
    return { ...state, scores, history, lastRoll: record, streak: state.streak + 1 };
  }
  return { ...state, scores, history, lastRoll: record, streak: 0, shooterId: nextShooter(state, shooter) };
}
