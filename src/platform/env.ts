const params = new URLSearchParams(location.search);

/** Discord launches Activities with frame_id / instance_id query params. */
export const inDiscord = params.has("frame_id") && params.has("instance_id");

/** Inside Discord every request must go through the activity proxy. */
export const apiBase = inDiscord ? "/.proxy/api" : "/api";

export const DISCORD_CLIENT_ID: string = import.meta.env.VITE_DISCORD_CLIENT_ID ?? "";

export type TransportChoice = "peerjs" | "relay";

/**
 * Every room defaults to the relay (our Cloudflare Durable Object). Direct
 * WebRTC links with no TURN server failed for phones on some networks, even on
 * the same Wi-Fi, so peer-to-peer is opt-in. Override with
 * ?t=relay or ?t=peerjs. Everyone in a room must use the same transport, so
 * invite links carry the choice.
 */
export function transportChoice(): TransportChoice {
  const t = params.get("t") ?? params.get("transport");
  if (t === "relay" || t === "peerjs") return t;
  return "relay";
}

export const peerServer = {
  host: import.meta.env.VITE_PEERJS_HOST as string | undefined,
  port: import.meta.env.VITE_PEERJS_PORT ? Number(import.meta.env.VITE_PEERJS_PORT) : undefined,
  path: import.meta.env.VITE_PEERJS_PATH as string | undefined,
};

export const debug = params.has("debug");
