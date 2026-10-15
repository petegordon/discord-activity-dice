import { KEY_RE } from "../net/identityKey";
import type { TransportKind } from "../net/transport";
import { inDiscord } from "../platform/env";

/**
 * Where phones open the remote. Inside Discord, location.origin is the
 * Activity proxy (*.discordsays.com), which a phone browser can't use.
 */
export function publicOrigin(): string {
  const configured = import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined;
  if (inDiscord) return configured || "https://dice.housetandem.com";
  return location.origin;
}

/**
 * The remote's key goes in the fragment, which browsers never send to a
 * server, so it stays out of request logs and link previews.
 */
export function remoteLink(room: string, transport: TransportKind, key: string, origin = publicOrigin()): string {
  const url = new URL("/remote", origin);
  url.searchParams.set("room", room);
  url.searchParams.set("t", transport);
  url.hash = `k=${key}`;
  return url.toString();
}

export type RemoteParams = { room: string; transport: TransportKind; key: string | null };

export function parseRemoteLink(href: string): RemoteParams | null {
  const url = new URL(href);
  const room = (url.searchParams.get("room") ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  if (!room) return null;
  const transport: TransportKind = url.searchParams.get("t") === "peerjs" ? "peerjs" : "relay";
  const key = new URLSearchParams(url.hash.slice(1)).get("k");
  return { room, transport, key: key && KEY_RE.test(key) ? key : null };
}
