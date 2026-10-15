import type { Self } from "../net/room";
import { apiBase, DISCORD_CLIENT_ID, peerServer } from "./env";
import { newIdentity } from "../net/identityKey";
import { sanitizeRoom } from "./identity";

export type DiscordSession = {
  self: Self;
  roomId: string;
  /** Opens a URL in the system browser, after Discord's own confirmation. */
  openExternal: (url: string) => Promise<void>;
  mobile: boolean;
};

/**
 * Embedded App SDK handshake: ready → authorize → token exchange on our
 * Worker → authenticate. The SDK is loaded lazily so the standalone build
 * doesn't pay for it.
 */
export async function startDiscord(): Promise<DiscordSession> {
  if (!DISCORD_CLIENT_ID) throw new Error("VITE_DISCORD_CLIENT_ID is not set for this build.");
  const { DiscordSDK, patchUrlMappings } = await import("@discord/embedded-app-sdk");

  // Route PeerJS signaling through the Activity proxy (URL mapping /peerjs → the signaling host).
  patchUrlMappings([{ prefix: "/peerjs", target: peerServer.host ?? "0.peerjs.com" }]);

  const sdk = new DiscordSDK(DISCORD_CLIENT_ID);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });

  // A fresh id per session, so the same user on two devices doesn't collide.
  const identity = await newIdentity();
  const res = await fetch(`${apiBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, instanceId: sdk.instanceId, playerId: identity.id }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  // `room` and `ticket` admit us to this instance's relay room (worker/src/roomTicket.ts).
  const { access_token, room, ticket } = (await res.json()) as { access_token: string; room?: string; ticket?: string };
  const { user } = await sdk.commands.authenticate({ access_token });

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;

  return {
    self: { ...identity, name: user.global_name || user.username, avatarUrl, ticket },
    roomId: room ?? sanitizeRoom(sdk.instanceId),
    openExternal: async (url) => {
      await sdk.commands.openExternalLink({ url });
    },
    mobile: String(sdk.platform) === "mobile",
  };
}
