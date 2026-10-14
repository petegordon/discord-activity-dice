import { HostAuthority, type PlanFn } from "../game/host";
import { createGame, type GameState } from "../game/sevenElevenDoubles";
import type { Envelope, Msg, Player, RollPlan, ThrowInput } from "./protocol";
import { Emitter, type Transport, type TransportStatus } from "./transport";

/** After a host migration, how long players get to reconnect before being dropped. */
const RECONNECT_GRACE_MS = 8_000;
/** Spacing between successive players' attempts to claim host. */
const SUCCESSION_STEP_MS = 1_500;

export type RoomEvents = {
  state: (players: Player[], game: GameState) => void;
  roll: (plan: RollPlan, game: GameState) => void;
  shake: (from: string, intensity: number) => void;
  status: (status: TransportStatus) => void;
  role: (isHost: boolean) => void;
};

export type Self = { id: string; name: string; avatarUrl?: string };

/**
 * Glues a transport to the game. Whoever is host runs a HostAuthority and
 * broadcasts its results; everyone (host included) renders from the same
 * "state" and "roll" messages.
 */
export class Room {
  players: Player[] = [];
  game: GameState = createGame();
  hostId: string | null = null;
  private authority: HostAuthority | null = null;
  private events = new Emitter<RoomEvents>();
  private connected = new Set<string>();
  private graceUntil = 0;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly transport: Transport,
    readonly self: Self,
    private readonly plan: PlanFn,
  ) {
    transport.on("message", (env) => this.onMessage(env));
    transport.on("host-change", (isHost) => this.onHostChange(isHost));
    transport.on("peers", (ids) => this.onPeers(ids));
    transport.on("status", (s) => this.events.emit("status", s));
    if ("successionDelay" in transport) {
      (transport as { successionDelay: () => number }).successionDelay = () => this.successionDelay();
    }
  }

  get isHost() {
    return this.authority !== null;
  }

  get transportKind() {
    return this.transport.kind;
  }

  on<K extends keyof RoomEvents>(event: K, cb: RoomEvents[K]) {
    this.events.on(event, cb);
  }

  join() {
    return this.transport.connect();
  }

  leave() {
    clearTimeout(this.graceTimer);
    this.transport.close();
  }

  start(target: number) {
    if (this.authority) this.broadcast(this.authority.start(target));
  }

  rematch() {
    if (this.authority) this.broadcast(this.authority.rematch());
  }

  throwDice(input: ThrowInput) {
    if (this.authority) this.broadcast(this.authority.throw(this.self.id, input));
    else this.transport.send({ t: "throw", input }, "host");
  }

  shake(intensity: number) {
    this.transport.send({ t: "shake", intensity }, "all");
  }

  /** Send to everyone else and apply locally, in that order. */
  private broadcast(msgs: Msg[]) {
    for (const msg of msgs) {
      this.transport.send(msg, "all");
      this.apply(msg);
    }
  }

  private apply(msg: Msg) {
    if (msg.t === "state") {
      this.players = msg.players;
      this.game = msg.game;
      this.hostId = msg.hostId;
      this.events.emit("state", msg.players, msg.game);
    } else if (msg.t === "roll") {
      this.game = msg.game;
      this.events.emit("roll", msg.plan, msg.game);
    }
  }

  private onMessage(env: Envelope) {
    const { msg } = env;
    if (msg.t === "shake") {
      if (env.from === this.game.shooterId) this.events.emit("shake", env.from, Number(msg.intensity) || 0);
      return;
    }
    if (env.to === "host") {
      if (this.authority) this.broadcast(this.authority.handle(env.from, msg));
      return;
    }
    // Only the host broadcasts state and rolls (transports enforce this too).
    if (!this.authority) this.apply(msg);
  }

  private onHostChange(isHost: boolean) {
    if (isHost) {
      const authority = new HostAuthority({ selfId: this.self.id, plan: this.plan });
      const previousHost = this.hostId;
      if (this.players.length) {
        authority.restore(this.players, this.game);
        if (previousHost && previousHost !== this.self.id) authority.leave(previousHost);
        // Give everyone a moment to find the new host before dropping them.
        this.graceUntil = Date.now() + RECONNECT_GRACE_MS;
        clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => this.prune(), RECONNECT_GRACE_MS + 50);
      }
      this.authority = authority;
      this.broadcast(authority.join(this.self.id, { name: this.self.name, avatarUrl: this.self.avatarUrl }));
    } else {
      this.authority = null;
      clearTimeout(this.graceTimer);
      this.transport.send({ t: "hello", player: { name: this.self.name, avatarUrl: this.self.avatarUrl } }, "host");
    }
    this.events.emit("role", isHost);
  }

  private onPeers(ids: string[]) {
    this.connected = new Set(ids);
    if (Date.now() >= this.graceUntil) this.prune();
  }

  private prune() {
    if (!this.authority) return;
    const present = new Set(this.connected);
    present.add(this.self.id);
    this.broadcast(this.authority.prune(present));
    // Late hellos from players who missed the grace window are re-added by join().
  }

  /** PeerJS migration: claim host in join order, skipping the host that left. */
  private successionDelay(): number {
    const order = this.players
      .filter((p) => p.id !== this.hostId)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => p.id);
    const rank = order.indexOf(this.self.id);
    return (rank === -1 ? order.length : rank) * SUCCESSION_STEP_MS;
  }
}
