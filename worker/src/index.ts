import { DurableObject } from "cloudflare:workers";
import { CLIENT_BROADCASTS } from "../../src/net/protocol";

export interface Env {
  RELAY: DurableObjectNamespace<RelayRoom>;
  ASSETS: Fetcher;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET?: string;
  /** Optional Cloudflare Realtime TURN key, for NAT traversal of the PeerJS transport. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SOCKETS_PER_ROOM = 32;
const STUN: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

type RTCIceServer = { urls: string | string[]; username?: string; credential?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/token" && req.method === "POST") return exchangeToken(req, env);
    if (url.pathname === "/api/ice" && req.method === "GET") return iceServers(env);

    const relay = url.pathname.match(/^\/api\/relay\/([^/]+)$/);
    if (relay) {
      const room = decodeURIComponent(relay[1]);
      const id = url.searchParams.get("id") ?? "";
      if (!ROOM_RE.test(room) || !ID_RE.test(id)) return json({ error: "bad room or id" }, 400);
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected websocket" }, 426);
      return env.RELAY.get(env.RELAY.idFromName(room)).fetch(req);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** Discord Embedded App SDK: swap the authorize() code for an access token. */
async function exchangeToken(req: Request, env: Env): Promise<Response> {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return json({ error: "Discord is not configured" }, 503);
  let code: unknown;
  try {
    code = ((await req.json()) as { code?: unknown }).code;
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (typeof code !== "string" || code.length > 512) return json({ error: "missing code" }, 400);

  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!res.ok) return json({ error: "token exchange failed" }, 502);
  const { access_token } = (await res.json()) as { access_token?: string };
  return access_token ? json({ access_token }) : json({ error: "token exchange failed" }, 502);
}

/** STUN always; short-lived TURN credentials too when a TURN key is configured. */
async function iceServers(env: Env): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: STUN });
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 60 * 60 }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { iceServers: RTCIceServer | RTCIceServer[] };
    const turn = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    return json({ iceServers: [...STUN, ...turn] });
  } catch {
    return json({ iceServers: STUN });
  }
}

type Attachment = { id: string; joinedAt: number };

/**
 * One instance per room. Relays envelopes between sockets and tells everyone
 * the connection order; the earliest connection is the host. Uses the
 * hibernation API so idle rooms cost nothing.
 */
export class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const id = new URL(req.url).searchParams.get("id")!;
    // A reconnecting player replaces their old socket.
    for (const ws of this.ctx.getWebSockets(id)) ws.close(4000, "replaced");
    if (this.sockets().length >= MAX_SOCKETS_PER_ROOM) return json({ error: "room full" }, 429);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [id]);
    const joinedAt = Math.max(Date.now(), ...this.sockets().map((s) => s.att.joinedAt + 1));
    server.serializeAttachment({ id, joinedAt } satisfies Attachment);
    this.broadcastPeers();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return;
    let parsed: { to?: unknown; msg?: { t?: unknown } };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const { to, msg } = parsed;
    if ((to !== "host" && to !== "all") || !msg || typeof msg.t !== "string") return;

    const sender = ws.deserializeAttachment() as Attachment;
    const ordered = this.sockets();
    const host = ordered[0];
    if (!host) return;
    const out = JSON.stringify({ type: "env", env: { from: sender.id, to, msg } });

    if (to === "host") {
      if (host.ws !== ws) host.ws.send(out);
      return;
    }
    if (host.ws !== ws && !CLIENT_BROADCASTS.has(msg.t)) return;
    for (const s of ordered) if (s.ws !== ws) s.ws.send(out);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    this.broadcastPeers(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.broadcastPeers(ws);
  }

  private sockets(exclude?: WebSocket) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as Attachment }))
      .filter((s) => s.att)
      .sort((a, b) => a.att.joinedAt - b.att.joinedAt || a.att.id.localeCompare(b.att.id));
  }

  private broadcastPeers(exclude?: WebSocket) {
    const sockets = this.sockets(exclude);
    const out = JSON.stringify({ type: "peers", ids: sockets.map((s) => s.att.id) });
    for (const s of sockets) s.ws.send(out);
  }
}
