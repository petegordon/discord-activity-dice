import type { PeerOptions } from "peerjs";
import { apiBase, debug, peerServer } from "../platform/env";

async function iceServers(): Promise<RTCIceServer[]> {
  const fallback: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  try {
    const res = await fetch(`${apiBase}/ice`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(body.iceServers) && body.iceServers.length ? body.iceServers : fallback;
  } catch {
    return fallback;
  }
}

export async function peerOptions(): Promise<PeerOptions> {
  const options: PeerOptions = { debug: debug ? 2 : 0, config: { iceServers: await iceServers() } };
  if (peerServer.host) {
    options.host = peerServer.host;
    options.port = peerServer.port ?? 443;
    options.path = peerServer.path ?? "/";
    options.secure = options.port === 443;
  }
  return options;
}
