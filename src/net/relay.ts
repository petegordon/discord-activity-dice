import { isEnvelope, SERVER_ID, type Msg, type Role, type ServerMsg, type Target } from "./protocol";
import { Emitter, type Transport, type TransportEvents } from "./transport";

/** Also how the relay spots a dead host: see STALE_MS in the Worker. */
const PING_MS = 5_000;
const MAX_BACKOFF_MS = 8_000;
/** The relay closes a remote whose key no player has registered with this code (worker/src/remotes.ts). */
const CLOSE_NOT_LINKED = 4003;
/** After this many tries in a row that never opened, ask for a new ticket (at most once per TICKET_REFRESH_MIN_MS). */
const UNOPENED_BEFORE_REFRESH = 2;
const TICKET_REFRESH_MIN_MS = 30_000;

export type RelayOptions = {
  /** Remotes are never host and aren't players; see SHAKER-REMOTE.md. */
  role?: Role;
  /** Required for players in Discord rooms (worker/src/roomTicket.ts). */
  ticket?: string;
  /** Tickets expire. When the relay stops letting us in, this gets a new one (undefined if it can't). */
  refreshTicket?: () => Promise<string | undefined>;
  /** A House Tandem session (web sign-in); the relay checks it and credits achievements to that account. */
  ht?: string;
};

/**
 * WebSocket transport through a Cloudflare Durable Object (worker/src/index.ts).
 * A relay that says `server: true` is itself the host (it runs the game); an
 * older relay makes the earliest player connection host.
 *
 * The socket's address carries only what the relay needs to route it. The
 * House Tandem session and a remote's key go in the first message instead
 * (ServerMsg "join"), so they stay out of addresses and request logs.
 */
export class RelayTransport implements Transport {
  readonly kind = "relay";
  isHost = false;
  /** The relay runs the game; no player is ever host. */
  serverHosted = false;
  private ws: WebSocket | null = null;
  private hostId: string | null = null;
  private events = new Emitter<TransportEvents>();
  private closed = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private connectedOnce = false;
  /** True until the first peers message on the current socket. */
  private fresh = true;
  private ticket: string | undefined;
  /** Tries in a row that closed without opening. */
  private unopened = 0;
  private lastTicketRefresh = -Infinity;
  /** Times in a row the relay turned this remote away. */
  private refusals = 0;
  /** Player only: the hash of our current remote link's key, kept so a reconnect registers it again. */
  private remoteHash: string | null = null;

  constructor(
    private readonly roomId: string,
    private readonly selfId: string,
    private readonly key: string,
    private readonly apiBase: string,
    private readonly options: RelayOptions = {},
  ) {
    this.ticket = options.ticket;
  }

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
    if (this.options.role === "remote") base.searchParams.set("role", "remote");
    else base.searchParams.set("key", this.key);
    if (this.ticket) base.searchParams.set("ticket", this.ticket);
    return base.toString();
  }

  /** The first message on every socket. */
  private join(): ServerMsg {
    if (this.options.role === "remote") return { t: "join", key: this.key };
    return { t: "join", ...(this.options.ht ? { ht: this.options.ht } : {}), ...(this.remoteHash ? { remote: this.remoteHash } : {}) };
  }

  private open(resolve?: () => void, reject?: (e: Error) => void) {
    const ws = new WebSocket(this.url());
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.unopened = 0;
      this.fresh = true;
      ws.send(JSON.stringify({ to: "server", msg: this.join() }));
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
      const d = data as { type?: string; ids?: unknown; remotes?: unknown; env?: unknown; server?: unknown };
      if (d.type === "peers" && Array.isArray(d.ids)) {
        const strings = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : []);
        this.serverHosted = d.server === true;
        this.refusals = 0;
        this.onPeers(strings(d.ids), strings(d.remotes));
        if (!this.connectedOnce) {
          this.connectedOnce = true;
          resolve?.();
        }
        this.events.emit("status", { kind: "connected" });
      } else if (d.type === "env" && isEnvelope(d.env)) {
        this.events.emit("message", d.env);
      }
    };

    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      if (!opened) this.unopened++;
      if (!opened && !this.connectedOnce && this.attempt >= 2) {
        reject?.(new Error("Could not reach the relay server"));
        this.events.emit("status", { kind: "failed", reason: "Could not reach the relay server." });
        return;
      }
      let delay: number;
      if (ev?.code === CLOSE_NOT_LINKED) {
        // No player has this remote's key registered (any more). Keep asking, slowly: the link may come back.
        this.events.emit("status", { kind: "unlinked" });
        delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.refusals++);
      } else {
        this.events.emit("status", { kind: "reconnecting" });
        delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++);
      }
      setTimeout(() => void this.reopen(resolve, reject), delay);
    };
  }

  /** Reconnect, first getting a new ticket when the relay keeps refusing the one we have. */
  private async reopen(resolve?: () => void, reject?: (e: Error) => void) {
    const refresh = this.options.refreshTicket;
    if (refresh && !this.closed && this.unopened >= UNOPENED_BEFORE_REFRESH && Date.now() - this.lastTicketRefresh >= TICKET_REFRESH_MIN_MS) {
      this.lastTicketRefresh = Date.now();
      try {
        this.ticket = (await refresh()) ?? this.ticket;
      } catch {
        // keep the old one; the next round tries again
      }
    }
    if (!this.closed) this.open(resolve, reject);
  }

  /** `ids` are players in connection order (the first is host); `remotes` are shaker remotes. */
  private onPeers(ids: string[], remotes: string[]) {
    const hostId = this.serverHosted ? SERVER_ID : (ids[0] ?? null);
    const isHost = !this.serverHosted && hostId === this.selfId;
    // After a reconnect the host may well be unchanged, but it may have dropped
    // us meanwhile, so re-announce ourselves either way.
    const changed = hostId !== this.hostId || this.fresh;
    this.fresh = false;
    this.hostId = hostId;
    this.isHost = isHost;
    if (changed) this.events.emit("host-change", isHost);
    if (isHost) this.events.emit("peers", [...ids, ...remotes]);
  }

  send(msg: Msg, to: Target) {
    if (to === "host" && this.isHost) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ to, msg }));
  }

  /** A message for the relay itself (never relayed). False if the socket isn't open. */
  toServer(msg: ServerMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ to: "server", msg }));
    return true;
  }

  /**
   * Tell the relay which remote may play for us: the hash of the key in our
   * remote link, or null for none. Only a remote presenting that key gets in.
   */
  registerRemote(keyHash: string | null) {
    this.remoteHash = keyHash;
    this.toServer({ t: "remote-key", ...(keyHash ? { hash: keyHash } : {}) });
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
