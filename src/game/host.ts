import { normalizeThrow } from "../input/throw";
import { FRAME_DT } from "../dice/physics";
import type { Msg, Player, RollPlan, ThrowInput } from "../net/protocol";
import { TARGET_OPTIONS } from "./rules";
import {
  addPlayer,
  applyRoll,
  canThrow,
  createGame,
  rematch,
  removePlayer,
  startMatch,
  type GameState,
} from "./sevenElevenDoubles";

export const PLAYER_COLORS = ["#e63946", "#2a9d8f", "#f4a261", "#457b9d", "#9b5de5", "#f15bb5", "#00b4d8", "#80b918"];

/**
 * Throws are refused until the dice have landed on the host. Clients start
 * their animation later than the host does, so they always finish after this.
 */
const LANDING_SLACK_MS = 100;
const MAX_NAME = 24;
/** Ids are 16 hex chars (see identityKey.ts). */
const REMOTE_ID_RE = /^[0-9a-f]{16}$/;

export type PlanFn = (rollId: string, shooter: string, input: ThrowInput) => RollPlan & { frameCount: number };

export type HostDeps = {
  /** The host's own player id. */
  selfId: string;
  plan: PlanFn;
  now?: () => number;
  newId?: () => string;
};

export function sanitizeName(name: unknown): string {
  const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME) : "";
  return clean || "Player";
}

function sanitizeAvatar(url: unknown): string | undefined {
  return typeof url === "string" && /^https:\/\/cdn\.discordapp\.com\//.test(url) ? url : undefined;
}

/**
 * The authoritative game, run only by the current network host. Every method
 * returns the messages to broadcast; it never touches the network itself.
 */
export class HostAuthority {
  players: Player[] = [];
  game: GameState = createGame();
  private busyUntil = 0;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: HostDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** Take over from a previous host using the last state everyone agreed on. */
  restore(players: Player[], game: GameState) {
    this.players = players.map((p) => ({ ...p }));
    this.game = game;
    this.busyUntil = 0;
  }

  state(): Msg {
    return { t: "state", players: this.players, game: this.game, hostId: this.deps.selfId };
  }

  join(from: string, hello: { name?: unknown; avatarUrl?: unknown }): Msg[] {
    const existing = this.players.find((p) => p.id === from);
    const name = sanitizeName(hello.name);
    const avatarUrl = sanitizeAvatar(hello.avatarUrl);
    if (existing) {
      existing.name = name;
      existing.avatarUrl = avatarUrl;
    } else {
      const used = new Set(this.players.map((p) => p.color));
      const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.players.length % PLAYER_COLORS.length];
      const joinedAt = Math.max(this.now(), ...this.players.map((p) => p.joinedAt + 1));
      this.players.push({ id: from, name, avatarUrl, color, joinedAt });
      this.game = addPlayer(this.game, from);
    }
    return [this.state()];
  }

  leave(id: string): Msg[] {
    if (!this.players.some((p) => p.id === id)) return [];
    this.players = this.players.filter((p) => p.id !== id);
    this.game = removePlayer(this.game, id);
    return [this.state()];
  }

  /** Drop everyone not in `present` (used after a host migration). */
  prune(present: Set<string>): Msg[] {
    const gone = this.players.filter((p) => !present.has(p.id)).map((p) => p.id);
    return gone.length ? gone.flatMap((id) => this.leave(id)).slice(-1) : [];
  }

  start(target: number): Msg[] {
    if (this.game.phase === "awaitingThrow" || this.players.length === 0) return [];
    const t = (TARGET_OPTIONS as readonly number[]).includes(target) ? target : this.game.target;
    this.game = startMatch(this.game, t);
    return [this.state()];
  }

  rematch(): Msg[] {
    if (this.game.phase !== "matchOver") return [];
    this.game = rematch(this.game);
    return [this.state()];
  }

  throw(from: string, input: ThrowInput): Msg[] {
    if (!canThrow(this.game, from) || this.now() < this.busyUntil) return [];
    const rollId = this.newId();
    const { frameCount, ...plan } = this.deps.plan(rollId, from, normalizeThrow(input));
    this.game = applyRoll(this.game, rollId, plan.faces);
    const landsInMs = Math.round(frameCount * FRAME_DT * 1000);
    this.busyUntil = this.now() + landsInMs - LANDING_SLACK_MS;
    return [{ t: "roll", plan, game: this.game, landsInMs }];
  }

  /** Make `remoteId` the player's shaker remote. A remote belongs to one player at a time. */
  pair(from: string, remoteId: unknown): Msg[] {
    const player = this.players.find((p) => p.id === from);
    if (!player || typeof remoteId !== "string" || !REMOTE_ID_RE.test(remoteId)) return [];
    if (this.players.some((p) => p.id === remoteId)) return [];
    for (const p of this.players) {
      if (p.remoteId === remoteId) {
        delete p.remoteId;
        delete p.remoteOnline;
      }
    }
    player.remoteId = remoteId;
    player.remoteOnline = false;
    return [this.state()];
  }

  unpair(from: string): Msg[] {
    const player = this.players.find((p) => p.id === from);
    if (!player?.remoteId) return [];
    delete player.remoteId;
    delete player.remoteOnline;
    return [this.state()];
  }

  /** Called with everyone connected; updates the 📱 badges. */
  remotesOnline(connected: Set<string>): Msg[] {
    let changed = false;
    for (const p of this.players) {
      if (!p.remoteId) continue;
      const online = connected.has(p.remoteId);
      if (p.remoteOnline !== online) {
        p.remoteOnline = online;
        changed = true;
      }
    }
    return changed ? [this.state()] : [];
  }

  /**
   * Requests addressed to the host. Broadcast-only messages are ignored.
   * A shaker remote (`remote`, set by the transport) may only ask for the
   * state and throw for the player it's paired with.
   */
  handle(from: string, msg: Msg, remote = false): Msg[] {
    if (remote) {
      if (msg.t === "remote-hello") return [this.state()];
      if (msg.t !== "throw") return [];
      const owner = this.players.find((p) => p.remoteId === from);
      return owner ? this.throw(owner.id, msg.input) : [];
    }
    switch (msg.t) {
      case "hello":
        return this.join(from, msg.player ?? {});
      case "throw":
        return this.throw(from, msg.input);
      case "pair":
        return this.pair(from, msg.remoteId);
      case "unpair":
        return this.unpair(from);
      default:
        return [];
    }
  }
}
