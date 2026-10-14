# Discord Activity Dice — Plan & Specification

A lightweight multiplayer 3D dice roller that runs **as a Discord Activity** and **as a standalone web app** outside Discord. Players in the same room see the same dice tumble and land on the same faces, in real time.

**Stack:** Three.js (rendering) · cannon-es (physics) · PeerJS / WebRTC (peer-to-peer sync) · Cloudflare Pages + Workers (hosting, Discord OAuth token exchange, optional fallback relay) · Vite + TypeScript (build)

---

## 1. Goals & Non-Goals

### Goals
- Roll common polyhedral dice (d4, d6, d8, d10, d12, d20, d100) in a shared 3D scene.
- Every participant sees **the same animation and the same result**.
- Run inside a Discord voice channel as an Activity, *and* at a plain URL with a shareable room link.
- Zero or near-zero server cost: static hosting + peer-to-peer data.
- Mobile-friendly (Discord mobile clients host Activities too).

### Non-Goals (v1)
- Full rules engines for specific games (D&D, Yahtzee scoring, etc.) — a simple "dice roll game" mode only (see §6).
- Persistent accounts, history beyond the current session, or leaderboards.
- Anti-cheat beyond host-authoritative rolls.

---

## 2. Architecture Overview

```
                    ┌────────────────────────────────────┐
                    │      Cloudflare Pages (static)     │
                    │  index.html, JS bundle, assets     │
                    └───────────────┬────────────────────┘
                                    │
          ┌─────────────────────────┼──────────────────────────┐
          │                         │                          │
 ┌────────▼────────┐       ┌────────▼────────┐       ┌─────────▼────────┐
 │  Client (host)  │◄─────►│ Client (peer B) │◄─────►│ Client (peer C)  │
 │ Three.js + phys │ WebRTC│                 │       │                  │
 └────────┬────────┘ data  └─────────────────┘       └──────────────────┘
          │        channels (star topology via host)
          │
 ┌────────▼──────────────────────────┐   ┌────────────────────────────────┐
 │ PeerJS signaling server           │   │ Cloudflare Worker  /api/*      │
 │ (PeerJS cloud or self-hosted)     │   │  - POST /api/token  (Discord   │
 │ + STUN / TURN                     │   │    OAuth code → access_token)  │
 └───────────────────────────────────┘   │  - /api/relay  (Durable Object │
                                         │    WebSocket fallback, §4.4)   │
                                         └────────────────────────────────┘
```

### Topology: host-authoritative star
- The **first player** in a room becomes host. All other peers connect to the host's PeerJS ID.
- The host owns the **roll seed and final results**; peers render the same deterministic simulation.
- If the host leaves, the peer with the lowest join order is promoted (§4.3).

Star over full mesh: simpler state ownership, O(n) connections, fine for the expected room size (≤ 25 players, Discord Activity practical limit).

---

## 3. Running Modes

| Mode | Entry | Identity | Room ID |
|---|---|---|---|
| **Discord Activity** | Launched from a voice channel | Discord user (via Embedded App SDK + OAuth) | Derived from `instanceId` provided by the SDK |
| **Standalone web** | `https://<domain>/?room=<code>` | Guest name typed by player (stored in `localStorage`) | 6-char code in URL; generated if absent |

Detection: if the page is loaded with `frame_id` / `instance_id` query params (Discord injects these), initialize the Discord SDK; otherwise run standalone.

### 3.1 Discord Activity specifics
- Use `@discord/embedded-app-sdk`: `ready()` → `authorize()` (scopes: `identify`, `guilds`) → `POST /api/token` on our Worker → `authenticate()`.
- Discord Activities run inside an iframe behind Discord's proxy (`<app_id>.discordsays.com`). **All outbound network requests must go through URL Mappings** configured in the Developer Portal:
  - `/` → Cloudflare Pages domain
  - `/api` → Cloudflare Worker
  - `/peerjs` → PeerJS signaling host
- Use `patchUrlMappings()` from the SDK so libraries (PeerJS) that build absolute URLs are rewritten through the proxy.
- Room ID = `discordSdk.instanceId` so everyone in the same Activity instance lands in the same room automatically.
- Display names/avatars come from the authenticated user + `getInstanceConnectedParticipants()`.

---

## 4. Networking

### 4.1 Signaling & peer IDs
- PeerJS peer IDs are namespaced: `dice-<roomId>-host` for the host, random UUID for others.
- Join flow:
  1. Attempt to register as `dice-<roomId>-host`.
  2. If the ID is taken (`unavailable-id` error), register with a random ID and connect to the host ID.
- v1 uses the public PeerJS cloud server for standalone mode; a **self-hosted PeerJS server** (or Worker-based signaling) is a stretch goal and likely required for Discord (proxy mapping + reliability).

### 4.2 Message protocol (JSON over reliable data channel)

```ts
type Msg =
  | { t: "hello";    player: Player }                         // peer → host on connect
  | { t: "state";    players: Player[]; hostId: string;       // host → all, on any change
                     dice: DieSpec[]; history: RollResult[] }
  | { t: "roll_req"; dice: DieSpec[] }                         // peer → host
  | { t: "roll";     rollId: string; seed: number;             // host → all
                     roller: string; dice: DieSpec[];
                     initial: BodyInit[] }
  | { t: "result";   rollId: string; faces: number[] }         // host → all (authoritative)
  | { t: "chat";     from: string; text: string }              // optional
  | { t: "ping" } | { t: "pong" };

type Player   = { id: string; name: string; avatarUrl?: string; color: string; joinedAt: number };
type DieSpec  = { kind: "d4"|"d6"|"d8"|"d10"|"d12"|"d20"|"d100"; color?: string };
type BodyInit = { pos: [number,number,number]; quat: [number,number,number,number];
                  vel: [number,number,number]; angVel: [number,number,number] };
type RollResult = { rollId: string; roller: string; dice: DieSpec[]; faces: number[]; total: number; at: number };
```

### 4.3 Host migration
- Every `state` message includes the ordered player list.
- On host disconnect, each peer computes the next host (lowest `joinedAt`). That peer claims `dice-<roomId>-host`; others retry connecting to it with backoff (250 ms → 4 s).
- In-flight roll is discarded; last confirmed `history` is kept.

### 4.4 Fallback transport (risk mitigation)
WebRTC may be blocked or unreliable inside Discord's sandboxed iframe/proxy, or behind strict NATs. The network layer is written against a small interface so a second transport can be swapped in:

```ts
interface Transport {
  connect(roomId: string, self: Player): Promise<void>;
  send(msg: Msg, to?: string): void;
  onMessage(cb: (msg: Msg, from: string) => void): void;
  onPeerLeave(cb: (id: string) => void): void;
  close(): void;
}
```

- `PeerJsTransport` — default (WebRTC data channels).
- `RelayTransport` — WebSocket to a **Cloudflare Durable Object** per room (`/api/relay/<roomId>`). Same message protocol; the DO just broadcasts. Used automatically if WebRTC fails within ~5 s, or forced via `?transport=relay`.
- TURN: configure Cloudflare Calls TURN (or similar) credentials via the Worker for NAT traversal.

---

## 5. Dice Simulation & Sync

### 5.1 Determinism strategy
Physics engines are not bit-for-bit deterministic across devices, so we **don't rely on every client simulating identically**. Instead:

1. Host generates `seed` and initial body states (`BodyInit[]`) for each die.
2. Host runs the simulation **headlessly to rest** (fast-forward, fixed 1/120 s step, max ~6 s), reads the top faces → `faces[]`.
3. Host broadcasts `roll` (initial states) and `result` (faces) together.
4. Every client (including host) plays the simulation visually from the same initial states. When dice settle, if a client's landed face differs from the authoritative face, it **re-orients the die mesh** (rotate around the die's local axes so the correct face is up) — applied *before* the animation starts by pre-rotating the die's visual mesh relative to its physics body, so the correction is invisible.

> Technique: simulate once to find which face lands up, compute the rotation mapping that face → desired face, apply it to the mesh's local offset, then replay. This is the standard "predetermined result" trick used by most 3D dice rollers.

### 5.2 Physics
- **cannon-es**: dice as `ConvexPolyhedron` bodies, a ground plane, and four invisible walls forming a tray.
- Fixed timestep 1/60 for display, sleeping enabled, settle detection when all bodies sleep or after timeout.
- Face detection: for each die, find the face normal (in world space) with the greatest dot product against `+Y` (for d4, the vertex pointing up / face pointing down).

### 5.3 Rendering
- **Three.js** `WebGLRenderer`, perspective camera looking down at the tray at ~60°.
- Dice geometries generated procedurally (polyhedron + per-face UV for number textures drawn on a canvas atlas).
- Lighting: hemisphere + one directional light with soft shadows (disabled on low-end / mobile).
- Each player has a color; dice they roll are tinted with it.
- Resize-aware; `devicePixelRatio` capped at 2.

---

## 6. Game Features

### 6.1 Free Roll (v1 default)
- Dice tray picker: tap d4…d100 to add to your hand (max 10 dice), clear, roll.
- Shared result log: "**Alice** rolled 2d6 + 1d20 → 3, 5, 17 = **25**".
- Optional notation input: `2d6+1d20+3`.

### 6.2 "High Roller" mini-game (v1 stretch)
- Host starts a round; each player rolls once with the same dice set.
- Highest total wins the round; ties trigger a roll-off.
- Running scoreboard for the session.

### 6.3 Later ideas
- Yahtzee-style hold/reroll, Liar's Dice (private dice per player), custom dice skins, sound effects, haptics.

---

## 7. UI / UX

```
┌─────────────────────────────────────────────┐
│  Room: ABC123   👤 Alice  👤 Bob  👤 Cara    │  ← participants bar
├─────────────────────────────────────────────┤
│                                             │
│              [ 3D dice tray ]               │
│                                             │
├─────────────────────────────────────────────┤
│ d4 d6 d8 d10 d12 d20 d100 │ hand: 2d6 │ ROLL │  ← dice picker
├─────────────────────────────────────────────┤
│ Alice rolled 2d6 → 3 + 5 = 8                │  ← roll log
└─────────────────────────────────────────────┘
```

- Plain DOM overlay over the canvas (no UI framework needed for v1).
- Large touch targets; works in Discord's portrait mobile layout.
- Standalone mode: "Copy invite link" button.

---

## 8. Project Structure

```
discord-activity-dice/
├── PLAN.md                 ← this document
├── README.md
├── package.json            ← Vite + TypeScript
├── vite.config.ts
├── index.html
├── src/
│   ├── main.ts             ← boot: detect mode, init identity, transport, scene
│   ├── discord.ts          ← Embedded App SDK auth + participants
│   ├── identity.ts         ← Player creation (Discord or guest)
│   ├── net/
│   │   ├── protocol.ts     ← Msg types
│   │   ├── transport.ts    ← Transport interface
│   │   ├── peerjs.ts       ← PeerJsTransport
│   │   ├── relay.ts        ← RelayTransport (WebSocket)
│   │   └── room.ts         ← host election, migration, state sync
│   ├── dice/
│   │   ├── geometry.ts     ← polyhedra + face numbering
│   │   ├── textures.ts     ← canvas number atlases
│   │   ├── physics.ts      ← cannon-es world, tray, simulate-to-rest
│   │   └── roller.ts       ← predetermined-result roll orchestration
│   ├── scene.ts            ← Three.js renderer, camera, lights
│   ├── ui.ts               ← DOM overlay, picker, log
│   └── game/highroller.ts  ← mini-game logic
└── worker/
    ├── wrangler.toml
    └── src/index.ts        ← /api/token, /api/relay (Durable Object)
```

---

## 9. Configuration & Secrets

| Name | Where | Purpose |
|---|---|---|
| `VITE_DISCORD_CLIENT_ID` | Pages build env | Public client ID for SDK |
| `DISCORD_CLIENT_ID` | Worker var | OAuth token exchange |
| `DISCORD_CLIENT_SECRET` | Worker **secret** | OAuth token exchange — never shipped to client |
| `VITE_PEERJS_HOST` / `PORT` / `PATH` | Pages build env | Signaling server (defaults to PeerJS cloud) |
| `TURN_*` | Worker secret | Issue short-lived TURN credentials |

`.env*` files are git-ignored.

---

## 10. Milestones

| # | Milestone | Deliverable |
|---|---|---|
| **M0** | Scaffold | Vite + TS project, Cloudflare Pages deploy, README |
| **M1** | Single-player dice | Three.js scene + cannon-es tray, all dice types, face detection, roll log |
| **M2** | Predetermined results | Headless simulate-to-rest + mesh re-orientation, deterministic replay from `BodyInit[]` |
| **M3** | Standalone multiplayer | PeerJS transport, room codes, host election, shared rolls, invite link |
| **M4** | Discord Activity | Developer Portal app, Worker `/api/token`, SDK auth, URL mappings, `instanceId` rooms |
| **M5** | Resilience | Host migration, Durable Object relay fallback, TURN |
| **M6** | Game mode + polish | High Roller mode, sounds, mobile tuning, custom colors |

---

## 11. Testing

- **Unit (Vitest):** dice notation parser, face detection per die type, re-orientation math (for every die, every face → every target face), protocol encode/decode, host election ordering.
- **Integration:** two+ browser tabs locally (standalone mode) — verify identical final faces and log entries.
- **Discord:** test via Developer Portal Activity testing in a private server, desktop + mobile client.
- **Network:** forced `?transport=relay`, simulated host disconnect.

---

## 12. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| WebRTC blocked/limited inside Discord iframe proxy | `Transport` abstraction + Durable Object WebSocket relay fallback (§4.4) |
| Public PeerJS cloud unreliable or not mappable via Discord proxy | Self-host PeerJS server or Worker-based signaling |
| Physics divergence across devices | Host-authoritative results + mesh re-orientation (§5.1) |
| Mobile GPU performance | Shadow toggle, DPR cap, low-poly dice |
| Host leaves mid-roll | Discard in-flight roll, migrate host (§4.3) |

**Open questions**
1. Custom domain for Cloudflare Pages, or `*.pages.dev`?
2. Is the "High Roller" mini-game the desired game, or a different dice game (Yahtzee, Liar's Dice, Farkle)?
3. Should rolls be visible to everyone always, or support private/GM rolls?
