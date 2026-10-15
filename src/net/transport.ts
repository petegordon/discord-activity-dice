import type { Envelope, Msg, Target } from "./protocol";

export type TransportKind = "peerjs" | "relay";

export type TransportEvents = {
  /** An envelope from another player. Never echoes our own sends. */
  message: (env: Envelope) => void;
  /** Host only: everyone currently connected: players (including self) and shaker remotes. */
  peers: (playerIds: string[]) => void;
  /** Our host role changed, or we (re)connected to a new host. */
  "host-change": (isHost: boolean) => void;
  status: (status: TransportStatus) => void;
};

export type TransportStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting" }
  | { kind: "failed"; reason: string };

/**
 * A room-scoped message bus with exactly one host. Targets:
 * - "host": delivered to the host only (ignored if we are the host — callers handle locally)
 * - "all":  delivered to every other player
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly isHost: boolean;
  connect(): Promise<void>;
  send(msg: Msg, to: Target): void;
  on<K extends keyof TransportEvents>(event: K, cb: TransportEvents[K]): void;
  close(): void;
}

export class Emitter<E extends { [K in keyof E]: (...args: never[]) => void }> {
  private handlers: { [K in keyof E]?: E[K][] } = {};

  on<K extends keyof E>(event: K, cb: E[K]) {
    (this.handlers[event] ??= []).push(cb);
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>) {
    for (const cb of this.handlers[event] ?? []) (cb as (...a: Parameters<E[K]>) => void)(...args);
  }
}
