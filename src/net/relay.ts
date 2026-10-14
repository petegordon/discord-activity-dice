import { isEnvelope, type Msg, type Target } from "./protocol";
import { Emitter, type Transport, type TransportEvents } from "./transport";

/** Also how the relay spots a dead host: see STALE_MS in the Worker. */
const PING_MS = 5_000;
const MAX_BACKOFF_MS = 8_000;

/**
 * WebSocket transport through a Cloudflare Durable Object (worker/src/index.ts).
 * The relay orders connections by arrival; the earliest one is host.
 */
export class RelayTransport implements Transport {
  readonly kind = "relay";
  isHost = false;
  private ws: WebSocket | null = null;
  private hostId: string | null = null;
  private events = new Emitter<TransportEvents>();
  private closed = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private connectedOnce = false;
  /** True until the first peers message on the current socket. */
  private fresh = true;

  constructor(
    private readonly roomId: string,
    private readonly selfId: string,
    private readonly key: string,
    private readonly apiBase: string,
  ) {}

  on<K extends keyof TransportEvents>(event: K, cb: TransportEvents[K]) {
    this.events.on(event, cb);
  }

  connect(): Promise<void> {
    this.events.emit("status", { kind: "connecting" });
    return new Promise((resolve, reject) => this.open(resolve, reject));
  }

  private url() {
    const base = new URL(`${this.apiBase}/relay/${encodeURIComponent(this.roomId)}`, location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.searchParams.set("id", this.selfId);
    base.searchParams.set("key", this.key);
    return base.toString();
  }

  private open(resolve?: () => void, reject?: (e: Error) => void) {
    const ws = new WebSocket(this.url());
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.fresh = true;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
    };

    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const d = data as { type?: string; ids?: unknown; env?: unknown };
      if (d.type === "peers" && Array.isArray(d.ids)) {
        this.onPeers(d.ids.filter((x): x is string => typeof x === "string"));
        if (!this.connectedOnce) {
          this.connectedOnce = true;
          resolve?.();
        }
        this.events.emit("status", { kind: "connected" });
      } else if (d.type === "env" && isEnvelope(d.env)) {
        this.events.emit("message", d.env);
      }
    };

    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      if (!opened && !this.connectedOnce && this.attempt >= 2) {
        reject?.(new Error("Could not reach the relay server"));
        this.events.emit("status", { kind: "failed", reason: "Could not reach the relay server." });
        return;
      }
      this.events.emit("status", { kind: "reconnecting" });
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++);
      setTimeout(() => !this.closed && this.open(resolve, reject), delay);
    };
  }

  private onPeers(ids: string[]) {
    const hostId = ids[0] ?? null;
    const isHost = hostId === this.selfId;
    // After a reconnect the host may well be unchanged, but it may have dropped
    // us meanwhile, so re-announce ourselves either way.
    const changed = hostId !== this.hostId || this.fresh;
    this.fresh = false;
    this.hostId = hostId;
    this.isHost = isHost;
    if (changed) this.events.emit("host-change", isHost);
    if (isHost) this.events.emit("peers", ids);
  }

  send(msg: Msg, to: Target) {
    if (to === "host" && this.isHost) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ to, msg }));
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
