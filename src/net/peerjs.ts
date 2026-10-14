import Peer, { type DataConnection, type PeerError, type PeerOptions } from "peerjs";
import { verifyPlayerKey } from "./identityKey";
import { CLIENT_BROADCASTS, isEnvelope, type Envelope, type Msg, type Target } from "./protocol";
import { Emitter, type Transport, type TransportEvents } from "./transport";

const HEARTBEAT_MS = 3_000;
const DEAD_AFTER_MS = 10_000;
const JOIN_TIMEOUT_MS = 12_000;
/** First connect: give up after this many failed rounds. */
const MAX_ATTEMPTS = 8;
/**
 * After losing the host, keep trying for this long. A host that crashed (no
 * clean close) keeps its id registered until the signaling server times it
 * out (~60s on the PeerJS cloud), so joins hang until then.
 */
const MIGRATION_DEADLINE_MS = 120_000;
/** Shakes are cosmetic; forward at most this often per player. */
const SHAKE_MIN_INTERVAL_MS = 40;
const KEEPALIVE = "ping";

class FatalError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ClaimResult = "host" | "taken";
type JoinResult = "joined" | "no-host" | "timeout";

/**
 * WebRTC data channels via PeerJS, in a star around the host.
 * The host registers the well-known id `dice-<room>-host`; everyone else
 * connects to it. When the host disappears, players try to claim the id in
 * join order (see `successionDelay`), and the rest reconnect to the winner.
 */
export class PeerJsTransport implements Transport {
  readonly kind = "peerjs";
  isHost = false;
  /** Set by the room: how long to wait before trying to claim host, by join order. */
  successionDelay: () => number = () => 0;

  private events = new Emitter<TransportEvents>();
  private hostPeer: Peer | null = null;
  private clientPeer: Peer | null = null;
  private hostConn: DataConnection | null = null;
  private conns = new Map<string, DataConnection>();
  private lastSeen = new Map<DataConnection, number>();
  private lastShake = new Map<string, number>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private establishing = false;
  private readonly hostPeerId: string;

  constructor(
    roomId: string,
    private readonly selfId: string,
    private readonly key: string,
    private readonly options: PeerOptions,
  ) {
    this.hostPeerId = `dice-${roomId}-host`;
  }

  on<K extends keyof TransportEvents>(event: K, cb: TransportEvents[K]) {
    this.events.on(event, cb);
  }

  async connect() {
    this.events.emit("status", { kind: "connecting" });
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    await this.establish(null);
  }

  /**
   * Claim host, or join whoever holds it. `deadline` is null on first connect,
   * where a WebRTC timeout means this network can't do peer-to-peer and we say
   * so; during a migration a timeout usually means a crashed host's id hasn't
   * expired yet, so we keep going until the deadline.
   */
  private async establish(deadline: number | null) {
    if (this.establishing) return;
    this.establishing = true;
    try {
      for (let attempt = 0; !this.closed; attempt++) {
        try {
          if ((await this.claimHost()) === "host") return this.becameConnected(true);
          const joined = await this.joinHost();
          if (joined === "joined") return this.becameConnected(false);
          if (joined === "timeout" && deadline === null) {
            throw new FatalError("Couldn't open a peer-to-peer connection to the host. Try the relay link.");
          }
          // "no-host" (it left between our claim and join) or a migration timeout: try again.
        } catch (err) {
          const outOfTime = deadline === null ? attempt >= MAX_ATTEMPTS : Date.now() > deadline;
          if (err instanceof FatalError || outOfTime) {
            this.events.emit("status", { kind: "failed", reason: (err as Error).message });
            throw err;
          }
        }
        if (deadline !== null && Date.now() > deadline) {
          const err = new FatalError("Lost the host and couldn't find a new one.");
          this.events.emit("status", { kind: "failed", reason: err.message });
          throw err;
        }
        await sleep(Math.min(4_000, 250 * 2 ** attempt));
      }
    } finally {
      this.establishing = false;
    }
  }

  private becameConnected(isHost: boolean) {
    this.isHost = isHost;
    this.events.emit("status", { kind: "connected" });
    this.events.emit("host-change", isHost);
    if (isHost) this.events.emit("peers", [this.selfId, ...this.conns.keys()]);
  }

  private claimHost(): Promise<ClaimResult> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(this.hostPeerId, this.options);
      peer.on("open", () => {
        this.hostPeer = peer;
        this.clientPeer?.destroy();
        this.clientPeer = null;
        peer.on("connection", (conn) => this.acceptConnection(conn));
        // Losing the signaling server doesn't drop existing data channels; just re-register.
        peer.on("disconnected", () => !this.closed && !peer.destroyed && peer.reconnect());
        resolve("host");
      });
      peer.on("error", (err: PeerError<string>) => {
        if (this.hostPeer === peer) {
          // While we were away someone else took over the host id: step down and join them.
          if (err.type === "unavailable-id") this.stepDown();
          return;
        }
        peer.destroy();
        if (err.type === "unavailable-id") resolve("taken");
        else reject(new Error(`Signaling error: ${err.type}`));
      });
    });
  }

  private stepDown() {
    if (this.closed || !this.hostPeer) return;
    const old = this.hostPeer;
    this.hostPeer = null;
    this.isHost = false;
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
    old.destroy();
    this.events.emit("status", { kind: "reconnecting" });
    void this.establish(Date.now() + MIGRATION_DEADLINE_MS).catch(() => {});
  }

  private ensureClientPeer(): Promise<Peer> {
    if (this.clientPeer?.open) return Promise.resolve(this.clientPeer);
    this.clientPeer?.destroy();
    return new Promise((resolve, reject) => {
      const peer = new Peer(`${this.hostPeerId.slice(0, -5)}-${this.selfId}`, this.options);
      this.clientPeer = peer;
      peer.on("open", () => resolve(peer));
      peer.on("error", (err: PeerError<string>) => {
        if (!peer.open) reject(new Error(`Signaling error: ${err.type}`));
      });
      peer.on("disconnected", () => !this.closed && !peer.destroyed && peer.reconnect());
    });
  }

  private async joinHost(): Promise<JoinResult> {
    const peer = await this.ensureClientPeer();
    return new Promise((resolve) => {
      const conn = peer.connect(this.hostPeerId, {
        reliable: true,
        serialization: "json",
        metadata: { playerId: this.selfId, key: this.key },
      });
      let settled = false;
      const finish = (r: JoinResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off("error", onError);
        resolve(r);
      };
      const timer = setTimeout(() => {
        conn.close();
        finish("timeout");
      }, JOIN_TIMEOUT_MS);
      const onError = (err: PeerError<string>) => {
        if (err.type === "peer-unavailable") finish("no-host");
      };
      peer.on("error", onError);
      conn.on("open", () => {
        this.hostConn = conn;
        this.lastSeen.set(conn, Date.now());
        conn.on("data", (data) => {
          this.lastSeen.set(conn, Date.now());
          if (isEnvelope(data)) this.events.emit("message", data);
        });
        finish("joined");
      });
      conn.on("close", () => {
        if (this.hostConn === conn) this.onHostLost();
        else finish("no-host");
      });
    });
  }

  private onHostLost() {
    this.hostConn = null;
    this.lastSeen.clear();
    if (this.closed) return;
    this.events.emit("status", { kind: "reconnecting" });
    const deadline = Date.now() + MIGRATION_DEADLINE_MS;
    void (async () => {
      await sleep(this.successionDelay());
      await this.establish(deadline).catch(() => {}); // status already reported
    })();
  }

  private acceptConnection(conn: DataConnection) {
    const meta = conn.metadata as { playerId?: unknown; key?: unknown } | undefined;
    const playerId = meta?.playerId;
    let verified = false;
    const ready = typeof playerId === "string" && playerId !== this.selfId ? verifyPlayerKey(playerId, meta?.key) : Promise.resolve(false);
    void ready.then((ok) => {
      verified = ok;
      if (!ok) conn.close();
      else if (conn.open) this.admit(playerId as string, conn);
    });
    conn.on("open", () => verified && this.admit(playerId as string, conn));
    conn.on("data", (data) => {
      if (!verified) return;
      this.lastSeen.set(conn, Date.now());
      if (!isEnvelope(data)) return;
      const id = playerId as string;
      // Never trust the sender's claimed identity.
      const env: Envelope = { ...data, from: id };
      if (env.to === "all") {
        if (!CLIENT_BROADCASTS.has(env.msg.t)) return;
        const now = Date.now();
        if (env.msg.t === "shake" && now - (this.lastShake.get(id) ?? 0) < SHAKE_MIN_INTERVAL_MS) return;
        this.lastShake.set(id, now);
        this.forward(env, id);
      }
      this.events.emit("message", env);
    });
    conn.on("close", () => {
      this.lastSeen.delete(conn);
      const id = playerId as string;
      if (this.conns.get(id) !== conn) return;
      this.conns.delete(id);
      this.events.emit("peers", [this.selfId, ...this.conns.keys()]);
    });
  }

  private admit(playerId: string, conn: DataConnection) {
    if (this.conns.get(playerId) === conn) return;
    const previous = this.conns.get(playerId);
    // Register the new connection first, so closing the old one isn't seen as a departure.
    this.conns.set(playerId, conn);
    this.lastSeen.set(conn, Date.now());
    previous?.close();
    this.events.emit("peers", [this.selfId, ...this.conns.keys()]);
  }

  private forward(env: Envelope, except: string) {
    for (const [id, conn] of this.conns) if (id !== except && conn.open) conn.send(env);
  }

  /** Keepalive both ways; data channels can take a long time to notice a vanished peer. */
  private beat() {
    const now = Date.now();
    const all = this.isHost ? [...this.conns.values()] : this.hostConn ? [this.hostConn] : [];
    for (const conn of all) {
      if (now - (this.lastSeen.get(conn) ?? now) > DEAD_AFTER_MS) {
        conn.close();
        continue;
      }
      if (conn.open) conn.send(KEEPALIVE);
    }
  }

  send(msg: Msg, to: Target) {
    const env: Envelope = { from: this.selfId, to, msg };
    if (this.isHost) {
      if (to === "all") this.forward(env, this.selfId);
    } else if (this.hostConn?.open) {
      this.hostConn.send(env);
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.hostPeer?.destroy();
    this.clientPeer?.destroy();
  }
}
