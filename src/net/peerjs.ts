import Peer, { type DataConnection, type PeerError, type PeerOptions } from "peerjs";
import { CLIENT_BROADCASTS, isEnvelope, type Envelope, type Msg, type Target } from "./protocol";
import { Emitter, type Transport, type TransportEvents } from "./transport";

const HEARTBEAT_MS = 3_000;
const DEAD_AFTER_MS = 10_000;
const JOIN_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 8;
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
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private readonly hostPeerId: string;

  constructor(
    roomId: string,
    private readonly selfId: string,
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
    await this.establish();
  }

  private async establish() {
    for (let attempt = 0; !this.closed; attempt++) {
      try {
        if ((await this.claimHost()) === "host") return this.becameConnected(true);
        const joined = await this.joinHost();
        if (joined === "joined") return this.becameConnected(false);
        if (joined === "timeout") throw new FatalError("Couldn't open a peer-to-peer connection to the host. Try the relay link.");
        // "no-host": the host left between our claim and join. Try again.
      } catch (err) {
        if (err instanceof FatalError || attempt >= MAX_ATTEMPTS) {
          this.events.emit("status", { kind: "failed", reason: (err as Error).message });
          throw err;
        }
      }
      await sleep(Math.min(4_000, 250 * 2 ** attempt));
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
        if (this.hostPeer === peer) return; // errors after we became host are non-fatal
        peer.destroy();
        if (err.type === "unavailable-id") resolve("taken");
        else reject(new Error(`Signaling error: ${err.type}`));
      });
    });
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
        metadata: { playerId: this.selfId },
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
    void (async () => {
      await sleep(this.successionDelay());
      try {
        await this.establish();
      } catch {
        // status already reported
      }
    })();
  }

  private acceptConnection(conn: DataConnection) {
    const playerId = (conn.metadata as { playerId?: unknown } | undefined)?.playerId;
    if (typeof playerId !== "string" || !playerId || playerId === this.selfId) {
      conn.close();
      return;
    }
    conn.on("open", () => {
      this.conns.get(playerId)?.close();
      this.conns.set(playerId, conn);
      this.lastSeen.set(conn, Date.now());
      this.events.emit("peers", [this.selfId, ...this.conns.keys()]);
    });
    conn.on("data", (data) => {
      this.lastSeen.set(conn, Date.now());
      if (!isEnvelope(data)) return;
      // Never trust the sender's claimed identity.
      const env: Envelope = { ...data, from: playerId };
      if (env.to === "all") {
        if (!CLIENT_BROADCASTS.has(env.msg.t)) return;
        this.forward(env, playerId);
      }
      this.events.emit("message", env);
    });
    conn.on("close", () => {
      this.lastSeen.delete(conn);
      if (this.conns.get(playerId) !== conn) return;
      this.conns.delete(playerId);
      this.events.emit("peers", [this.selfId, ...this.conns.keys()]);
    });
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
