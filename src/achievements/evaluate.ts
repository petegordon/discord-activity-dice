import type { GameState, RollRecord } from "../game/sevenElevenDoubles";

/**
 * Pure achievement rules. The relay room (worker/src/table.ts) calls these
 * after every roll and at the end of every match, with the game state before
 * and after, and sends the result to the House Tandem account service.
 */

/** Lifetime dice stats as stored on the account. */
export type Lifetime = {
  rolls: number;
  matches: number;
  wins: number;
  shakerRolls: number;
  /** Bit (face - 1) set once that double has been rolled. 63 = all six. */
  doubles: number;
  bestStreak: number;
  /** House Tandem user ids played a match with. */
  partners: string[];
};

/** How a change is merged into the stored stats (see the account service's recordGame). */
export type Delta = {
  add?: Record<string, number>;
  max?: Record<string, number>;
  or?: Record<string, number>;
  union?: Record<string, string[]>;
};

/** What the room remembers about one player between rolls (not saved). */
export type Track = {
  /** Turns in a row passed on without scoring. */
  coldTurns: number;
  /** The current turn has scored at least once. */
  turnHadHit: boolean;
  /** This match: passed the dice at least once. */
  passedThisMatch: boolean;
  /** This match: the most points behind the leader. */
  maxDeficit: number;
};

export type Outcome = { earned: string[]; delta: Delta };

export const ALL_DOUBLES = 0b111111;
const STREAKS: [number, string][] = [[3, "hot_hand"], [5, "on_fire"], [8, "unstoppable"]];
const PARTNER_CAP = 200;

export function emptyLifetime(): Lifetime {
  return { rolls: 0, matches: 0, wins: 0, shakerRolls: 0, doubles: 0, bestStreak: 0, partners: [] };
}

export function newTrack(): Track {
  return { coldTurns: 0, turnHadHit: false, passedThisMatch: false, maxDeficit: 0 };
}

/** Read stored stats defensively: anything missing or odd becomes zero. */
export function toLifetime(stats: Record<string, unknown> | null | undefined): Lifetime {
  const s = stats ?? {};
  const n = (k: string) => (typeof s[k] === "number" && Number.isFinite(s[k]) ? (s[k] as number) : 0);
  const partners = Array.isArray(s.partners) ? s.partners.filter((x): x is string => typeof x === "string") : [];
  return {
    rolls: n("rolls"),
    matches: n("matches"),
    wins: n("wins"),
    shakerRolls: n("shakerRolls"),
    doubles: n("doubles") & ALL_DOUBLES,
    bestStreak: n("bestStreak"),
    partners,
  };
}

/** Apply a delta locally, the same way the account service merges it. */
export function applyDelta(l: Lifetime, d: Delta): Lifetime {
  const out: Lifetime = { ...l, partners: [...l.partners] };
  const num = out as unknown as Record<string, number>;
  for (const [k, v] of Object.entries(d.add ?? {})) num[k] = (num[k] ?? 0) + v;
  for (const [k, v] of Object.entries(d.max ?? {})) num[k] = Math.max(num[k] ?? 0, v);
  for (const [k, v] of Object.entries(d.or ?? {})) num[k] = (num[k] ?? 0) | v;
  for (const [k, v] of Object.entries(d.union ?? {})) {
    if (k !== "partners") continue;
    const set = new Set(out.partners);
    for (const x of v) set.add(x);
    out.partners = [...set].slice(0, PARTNER_CAP);
  }
  return out;
}

/** Achievements that depend on lifetime totals. */
export function lifetimeEarned(l: Lifetime): string[] {
  const out: string[] = [];
  if ((l.doubles & ALL_DOUBLES) === ALL_DOUBLES) out.push("full_set");
  if (l.matches >= 25) out.push("regular");
  if (l.rolls >= 1000) out.push("thousand_rolls");
  if (l.partners.length >= 10) out.push("good_company");
  if (l.shakerRolls >= 25) out.push("shaker");
  return out;
}

/**
 * The shooter's achievements from one roll. Updates `track` in place.
 * `next` is the state after the roll.
 */
export function evaluateRoll(roll: RollRecord, next: GameState, track: Track, viaRemote: boolean): Outcome {
  const earned = ["first_roll"];
  const add: Record<string, number> = { rolls: 1 };
  const delta: Delta = { add };
  if (viaRemote) add.shakerRolls = 1;
  if (roll.hit === "seven") earned.push("lucky_seven");
  if (roll.hit === "eleven") earned.push("eleven_heaven");
  if (roll.hit === "doubles") {
    earned.push("seeing_double");
    if (roll.faces[0] === 1) earned.push("snake_eyes");
    if (roll.faces[0] === 6) earned.push("boxcars");
    delta.or = { doubles: 1 << (roll.faces[0] - 1) };
  }
  if (roll.hit) {
    const streak = next.streak;
    for (const [n, id] of STREAKS) if (streak >= n) earned.push(id);
    delta.max = { bestStreak: streak };
    track.turnHadHit = true;
    track.coldTurns = 0;
  } else {
    // A miss passes the dice: the end of this player's turn.
    if (!track.turnHadHit) track.coldTurns++;
    track.turnHadHit = false;
    track.passedThisMatch = true;
    if (track.coldTurns >= 5) earned.push("ice_cold");
  }
  return { earned, delta };
}

/** After every roll: how far each player is behind the leader. */
export function trackDeficits(next: GameState, tracks: Map<string, Track>) {
  const scores = next.turnOrder.map((id) => next.scores[id] ?? 0);
  const lead = Math.max(0, ...scores);
  for (const id of next.turnOrder) {
    const t = tracks.get(id);
    if (t) t.maxDeficit = Math.max(t.maxDeficit, lead - (next.scores[id] ?? 0));
  }
}

/** A new match starts: forget the last match's per-match tracking. */
export function resetMatch(tracks: Map<string, Track>) {
  for (const t of tracks.values()) {
    t.passedThisMatch = false;
    t.maxDeficit = 0;
    t.turnHadHit = false;
  }
}

/**
 * Everyone's achievements when a match ends. `userIds` maps player id → House
 * Tandem user id for signed-in players (Good Company counts only those).
 */
export function evaluateMatchEnd(next: GameState, tracks: Map<string, Track>, userIds: Map<string, string>): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  const players = next.turnOrder;
  const winner = next.winnerId;
  const signedIn = players.map((id) => userIds.get(id)).filter((u): u is string => !!u);
  for (const id of players) {
    const earned: string[] = [];
    const add: Record<string, number> = { matches: 1 };
    const delta: Delta = { add };
    if (players.length >= 4) earned.push("full_table");
    const me = userIds.get(id);
    const partners = signedIn.filter((u) => u !== me);
    if (partners.length) delta.union = { partners };
    if (id === winner) {
      add.wins = 1;
      earned.push("first_win");
      const mine = next.scores[id] ?? 0;
      const others = players.filter((p) => p !== id).map((p) => next.scores[p] ?? 0);
      const runnerUp = others.length ? Math.max(...others) : null;
      if (next.target === 21) earned.push("high_roller");
      if ((tracks.get(id)?.maxDeficit ?? 0) >= 5) earned.push("comeback");
      if (runnerUp !== null && runnerUp === mine - 1) earned.push("photo_finish");
      if (others.length >= 1 && others.every((s) => s === 0)) earned.push("shutout");
      if (tracks.get(id) && !tracks.get(id)!.passedThisMatch) earned.push("run_the_table");
    }
    out.set(id, { earned, delta });
  }
  return out;
}

/** Combine two deltas (a roll that also ends the match). */
export function mergeDeltas(a: Delta, b: Delta): Delta {
  const out: Delta = {};
  for (const kind of ["add", "max", "or"] as const) {
    const m: Record<string, number> = { ...(a[kind] ?? {}) };
    for (const [k, v] of Object.entries(b[kind] ?? {})) {
      m[k] = k in m ? (kind === "add" ? m[k] + v : kind === "max" ? Math.max(m[k], v) : m[k] | v) : v;
    }
    if (Object.keys(m).length) out[kind] = m;
  }
  const u: Record<string, string[]> = { ...(a.union ?? {}) };
  for (const [k, v] of Object.entries(b.union ?? {})) u[k] = [...new Set([...(u[k] ?? []), ...v])];
  if (Object.keys(u).length) out.union = u;
  return out;
}
