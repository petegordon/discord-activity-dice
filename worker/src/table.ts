import {
  applyDelta,
  emptyLifetime,
  evaluateMatchEnd,
  evaluateRoll,
  lifetimeEarned,
  mergeDeltas,
  newTrack,
  resetMatch,
  toLifetime,
  trackDeficits,
  type Delta,
  type Lifetime,
  type Outcome,
  type Track,
} from "../../src/achievements/evaluate";
import { HostAuthority, type PlanFn } from "../../src/game/host";
import { createGame, type GameState } from "../../src/game/sevenElevenDoubles";
import { SERVER_ID, type Msg, type Player } from "../../src/net/protocol";

/** How long a player who disconnects has to come back before being dropped. Matches the client's. */
export const RECONNECT_GRACE_MS = 8_000;
export const GAME = "dice";

/** The House Tandem account service, bound over RPC (see wrangler.jsonc `services`). */
export interface HouseTandem {
  resolveDiscord(p: { discordId: string; name: string; avatar: string | null }): Promise<{ userId: string | number; name: string; avatar: string | null }>;
  verifySession(token: string): Promise<{ userId: string | number; name: string; avatar: string | null } | null>;
  gameProfile(userId: string, game: string): Promise<{ earned: string[]; stats: Record<string, unknown> }>;
  recordGame(userId: string, game: string, delta: Delta, earned: string[]): Promise<{ newlyEarned: string[] }>;
}

/** One connected socket. `userId` is set by the Worker after it verified a sign-in. */
export type Conn = { id: string; role: "player" | "remote"; userId?: string };

/** What survives the Durable Object being evicted. */
export type Saved = {
  players: Player[];
  game: GameState;
  accounts: Record<string, string>;
  missingSince: Record<string, number>;
};

export type TableDeps = {
  plan: PlanFn;
  broadcast: (msgs: Msg[]) => void;
  save: (s: Saved) => void;
  ht?: HouseTandem;
  now?: () => number;
  /** Keep the object alive for background work (ctx.waitUntil). */
  wait?: (p: Promise<unknown>) => void;
  log?: (msg: string, err?: unknown) => void;
};

type Account = {
  /** Stats saved on the account when this session first saw them; null until loaded (or if loading failed). */
  base: Lifetime | null;
  /** Everything credited this session, as one running delta. */
  session: Lifetime;
  earned: Set<string>;
  loading: Promise<void>;
};

/**
 * The game, run by the relay's Durable Object for relay rooms: it picks the
 * dice, keeps score and credits achievements to signed-in players. Players'
 * browsers only send requests and animate what it broadcasts.
 */
export class TableServer {
  readonly authority: HostAuthority;
  /** player id → House Tandem user id, for signed-in players. */
  readonly accounts = new Map<string, string>();
  private missingSince = new Map<string, number>();
  private tracks = new Map<string, Track>();
  private byUser = new Map<string, Account>();
  private readonly now: () => number;

  constructor(private readonly deps: TableDeps) {
    this.now = deps.now ?? Date.now;
    this.authority = new HostAuthority({ selfId: SERVER_ID, plan: deps.plan, now: this.now });
  }

  restore(saved: Saved | undefined) {
    if (!saved || !saved.game) return;
    this.authority.restore(saved.players ?? [], saved.game);
    this.accounts.clear();
    for (const [k, v] of Object.entries(saved.accounts ?? {})) this.accounts.set(k, v);
    this.missingSince = new Map(Object.entries(saved.missingSince ?? {}));
  }

  snapshot(): Saved {
    return {
      players: this.authority.players,
      game: this.authority.game,
      accounts: Object.fromEntries(this.accounts),
      missingSince: Object.fromEntries(this.missingSince),
    };
  }

  /** Everyone connected right now (players and remotes). */
  connected(conns: Conn[]) {
    for (const c of conns) if (c.role === "player" && c.userId) this.accounts.set(c.id, c.userId);
    const present = new Set(conns.map((c) => c.id));
    const msgs = this.authority.remotesOnline(present);
    const t = this.now();
    for (const p of this.authority.players) {
      if (present.has(p.id)) this.missingSince.delete(p.id);
      else if (!this.missingSince.has(p.id)) this.missingSince.set(p.id, t);
    }
    this.out(msgs, true);
  }

  /** Drop players who stayed away longer than the grace period. */
  prune() {
    const t = this.now();
    const gone = [...this.missingSince].filter(([, since]) => t - since >= RECONNECT_GRACE_MS).map(([id]) => id);
    if (!gone.length) return;
    for (const id of gone) {
      this.missingSince.delete(id);
      this.accounts.delete(id);
      this.tracks.delete(id);
    }
    const keep = new Set(this.authority.players.map((p) => p.id).filter((id) => !gone.includes(id)));
    this.out(this.authority.prune(keep), true);
  }

  /** When the next prune is due, if anyone is missing. */
  nextPruneAt(): number | null {
    const times = [...this.missingSince.values()];
    return times.length ? Math.min(...times) + RECONNECT_GRACE_MS : null;
  }

  /** A request addressed to the host. */
  handle(conn: Conn, msg: Msg, remote: boolean) {
    const prev = this.authority.game;
    const msgs = this.authority.handle(conn.id, msg, remote);
    if (!msgs.length) return;
    const next = this.authority.game;
    if (prev.phase !== "awaitingThrow" && next.phase === "awaitingThrow") resetMatch(this.tracks);
    this.out(msgs, true);
    for (const m of msgs) {
      if (m.t === "roll") this.onRoll(m.plan.shooter, prev, m.game, remote && msg.t === "throw");
    }
  }

  private out(msgs: Msg[], save: boolean) {
    if (msgs.length) this.deps.broadcast(msgs);
    if (save) this.deps.save(this.snapshot());
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) this.tracks.set(id, (t = newTrack()));
    return t;
  }

  private onRoll(shooter: string, prev: GameState, next: GameState, viaRemote: boolean) {
    const record = next.lastRoll;
    if (!record) return;
    for (const id of next.turnOrder) this.track(id);
    const outcomes = new Map<string, Outcome>([[shooter, evaluateRoll(record, next, this.track(shooter), viaRemote)]]);
    trackDeficits(next, this.tracks);
    if (prev.phase === "awaitingThrow" && next.phase === "matchOver") {
      for (const [id, o] of evaluateMatchEnd(next, this.tracks, this.accounts)) {
        const had = outcomes.get(id);
        outcomes.set(id, had ? { earned: [...had.earned, ...o.earned], delta: mergeDeltas(had.delta, o.delta) } : o);
      }
    }
    for (const [id, o] of outcomes) {
      const userId = this.accounts.get(id);
      if (userId) this.credit(id, userId, o);
    }
  }

  private account(userId: string): Account {
    let a = this.byUser.get(userId);
    if (a) return a;
    const fresh: Account = { base: null, session: emptyLifetime(), earned: new Set(), loading: Promise.resolve() };
    if (this.deps.ht) {
      fresh.loading = this.deps.ht
        .gameProfile(userId, GAME)
        .then((p) => {
          fresh.base = toLifetime(p.stats);
          for (const id of p.earned ?? []) fresh.earned.add(id);
        })
        .catch((e) => this.deps.log?.("gameProfile failed", e));
    }
    this.byUser.set(userId, fresh);
    return fresh;
  }

  /** Save one player's progress; toast whatever was new. Runs in the background. */
  private credit(playerId: string, userId: string, o: Outcome) {
    const ht = this.deps.ht;
    if (!ht) return;
    const acc = this.account(userId);
    acc.session = applyDelta(acc.session, o.delta);
    const work = (async () => {
      await acc.loading;
      const earned = new Set(o.earned);
      if (acc.base) for (const id of lifetimeEarned(combine(acc.base, acc.session))) earned.add(id);
      const claim = [...earned].filter((id) => !acc.earned.has(id));
      for (const id of claim) acc.earned.add(id);
      try {
        const res = await ht.recordGame(userId, GAME, o.delta, claim);
        const fresh = (res?.newlyEarned ?? []).filter((x) => typeof x === "string");
        if (fresh.length) this.deps.broadcast([{ t: "achievement", playerId, ids: fresh }]);
      } catch (e) {
        for (const id of claim) acc.earned.delete(id);
        this.deps.log?.("recordGame failed", e);
      }
    })();
    this.deps.wait?.(work);
  }
}

/** Stored stats plus this session's, merged the way the account service merges them. */
export function combine(base: Lifetime, session: Lifetime): Lifetime {
  return applyDelta(base, {
    add: { rolls: session.rolls, matches: session.matches, wins: session.wins, shakerRolls: session.shakerRolls },
    or: { doubles: session.doubles },
    max: { bestStreak: session.bestStreak },
    union: { partners: session.partners },
  });
}

export function emptySaved(): Saved {
  return { players: [], game: createGame(), accounts: {}, missingSince: {} };
}
