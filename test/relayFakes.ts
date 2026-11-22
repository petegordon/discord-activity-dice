import { vi } from "vitest";

/**
 * Stand-ins for the Workers runtime, enough to run the relay room's Durable
 * Object (worker/src/index.ts) in a test. A test file using them starts with:
 *
 *   vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
 */
export class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  tags: string[] = [];
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private att: unknown = null;
  serializeAttachment(a: unknown) {
    this.att = JSON.parse(JSON.stringify(a));
  }
  deserializeAttachment() {
    return this.att;
  }
  send(d: string) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.closed = { code, reason };
  }
  /** Everything the room sent this socket, parsed. */
  get got(): { type: string; ids?: string[]; remotes?: string[]; accounts?: Record<string, string>; env?: { from: string; msg: { t: string } & Record<string, unknown> } }[] {
    return this.sent.map((d) => JSON.parse(d));
  }
}

export class FakeResponse {
  status: number;
  webSocket?: FakeSocket;
  constructor(
    private body: string | null = null,
    init: { status?: number; webSocket?: FakeSocket } = {},
  ) {
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  async json() {
    return JSON.parse(this.body ?? "null");
  }
}

export function fakeCtx() {
  const sockets: FakeSocket[] = [];
  const stored = new Map<string, unknown>();
  return {
    sockets,
    acceptWebSocket(ws: FakeSocket, tags: string[]) {
      ws.tags = tags;
      sockets.push(ws);
    },
    getWebSockets(tag?: string) {
      return sockets.filter((ws) => ws.readyState !== 3 && (!tag || ws.tags.includes(tag)));
    },
    setWebSocketAutoResponse() {},
    /** Every socket here is taken to have just pinged. */
    getWebSocketAutoResponseTimestamp: () => new Date(),
    blockConcurrencyWhile(fn: () => Promise<void>) {
      void fn();
    },
    waitUntil() {},
    storage: {
      get: async (k: string) => stored.get(k),
      put: async (k: string, v: unknown) => void stored.set(k, v),
      setAlarm: async () => {},
      deleteAll: async () => stored.clear(),
    },
  };
}

/** Put the runtime's globals in place. Undo with vi.unstubAllGlobals(). */
export function stubRuntime() {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    },
  );
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
  vi.stubGlobal("Response", FakeResponse);
}

type RoomLike = {
  fetch(req: Request): Promise<unknown>;
  webSocketMessage(ws: never, data: string): Promise<void>;
  webSocketClose(ws: never, code: number): Promise<void>;
};

/** Drive a room the way the Worker and the runtime do. */
export function driver(room: RoomLike, ctx: ReturnType<typeof fakeCtx>, roomName = "ROOM") {
  return {
    /** Open a socket; returns the room's end of it, or the refusal's status. */
    async connect(id: string, role: "player" | "remote" = "player", headers: Record<string, string> = {}): Promise<FakeSocket | number> {
      const before = ctx.sockets.length;
      const res = (await room.fetch(new Request(`https://x/api/relay/${roomName}?id=${id}${role === "remote" ? "&role=remote" : ""}`, { headers }))) as FakeResponse;
      return res.status === 101 && ctx.sockets.length > before ? ctx.sockets.at(-1)! : res.status;
    },
    say: (ws: FakeSocket, body: unknown) => room.webSocketMessage(ws as never, typeof body === "string" ? body : JSON.stringify(body)),
    toRoom: (ws: FakeSocket, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify({ to: "server", msg })),
    /** The client went away. */
    async hangUp(ws: FakeSocket) {
      await room.webSocketClose(ws as never, 1000);
      ws.readyState = 3;
    },
  };
}
