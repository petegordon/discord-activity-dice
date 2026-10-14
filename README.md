# 7, 11, Doubles

A multiplayer two-dice game with 3D dice that you **shake and throw with your phone**. It runs as a **Discord Activity** or standalone at **https://dice.jimandi.love**.

- Roll **7** or **11** for **+1**. Roll **doubles** for **+2**. Hit and you roll again; miss and the dice pass on.
- First to the target (5, 10 or 21) wins.

Built with Three.js, cannon-es, the DeviceMotion API, PeerJS (WebRTC) and a Cloudflare Worker with a Durable Object relay. See [PLAN.md](PLAN.md) for the full design.

## How to play

1. Open the site. It creates a room and puts its code in the URL. Use **Copy invite** to share it.
2. The first player in the room is the host. The host picks the target and presses **Start game**.
3. On your turn, **press and hold the cup**:
   - **On a phone:** shake it, then flick it forward or let go to throw. On iPhone, tap **Enable shake to roll** first.
   - **With a mouse or without motion:** wiggle, then flick upward.
   - **Quick roll** is always there as an alternative.

## Development

```bash
npm install
npm test              # unit tests (Vitest)
npm run typecheck     # app + worker
npm run build         # type-check + Vite build to dist/
npm run preview       # build, then serve app + Worker + Durable Object at http://127.0.0.1:8787
```

`npm run dev` starts Vite with hot reload. It proxies `/api` to `wrangler dev` on :8787, so run `npx wrangler dev` alongside it when you need the relay or `/api/*`.

### End-to-end test

With `npm run preview` running:

```bash
node scripts/e2e.mjs http://127.0.0.1:8787 relay 3    # or: peerjs 3
```

This drives several headless Chrome players through a full match. It includes a real flick gesture and a host disconnect partway through. It checks that every player saw identical rolls and scores, and saves screenshots to `scripts/out/`.

### Choosing a transport

| URL | Transport |
|---|---|
| `?room=ABC123` | PeerJS / WebRTC (standalone default) |
| `?room=ABC123&t=relay` | WebSocket relay via Durable Object (Discord default) |

Everyone in a room must use the same transport. Invite links carry the choice. If WebRTC can't connect, the error banner links to the relay version of the room.

Add `&debug` to expose `window.dice` and turn on PeerJS logging.

## Deploying to Cloudflare

The Worker serves the static build, `/api/*` and the relay. `wrangler.jsonc` binds it to the custom domain `dice.jimandi.love`, so the `jimandi.love` zone must be on the same Cloudflare account.

```bash
npx wrangler login
npm run deploy
```

Optional secrets:

```bash
npx wrangler secret put DISCORD_CLIENT_SECRET   # required for Discord
npx wrangler secret put TURN_KEY_ID             # Cloudflare Realtime TURN, improves WebRTC behind strict NATs
npx wrangler secret put TURN_KEY_API_TOKEN
```

## Discord Activity setup

1. Create an application at https://discord.com/developers/applications.
2. Under **Activities → Settings**, enable Activities.
3. Under **Activities → URL Mappings**, add:

   | Prefix | Target |
   |---|---|
   | `/` | `dice.jimandi.love` |
   | `/peerjs` | `0.peerjs.com` (only needed if you force `t=peerjs`) |

4. Under **OAuth2**, add the redirect `https://127.0.0.1` (the Embedded App SDK requires one, but it isn't used).
5. Put the public application ID in two places:
   - `wrangler.jsonc` → `vars.DISCORD_CLIENT_ID`
   - a `.env` file containing `VITE_DISCORD_CLIENT_ID=<id>` (read at build time)
6. Set the secret with `npx wrangler secret put DISCORD_CLIENT_SECRET`, then run `npm run deploy`.
7. Launch the Activity from a voice channel. Everyone in the same Activity instance joins the same table automatically.

## Project layout

```
src/
  main.ts                 boot: identity, transport, wiring, render loop
  ui.ts, style.css        DOM overlay (lobby, scores, callouts, cup)
  audio.ts                synthesised rattle/impact sounds
  game/                   rules, pure game reducer, host authority
  dice/                   face math, physics sim + recording, roll planning, playback
  input/                  device-motion shake/flick detection, pointer fallback, throw normalisation
  net/                    protocol, transports (PeerJS, relay), room coordination
  platform/               environment, identity/rooms, Discord SDK
  render/                 Three.js table and dice
worker/src/index.ts       Worker: assets, /api/token, /api/ice, RelayRoom Durable Object
test/                     Vitest unit tests
scripts/e2e.mjs           Playwright multi-player smoke test
```
