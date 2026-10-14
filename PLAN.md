# Discord Activity Dice — Plan & Specification

A lightweight multiplayer **two-dice "7, 11, Doubles" game** with 3D dice. It runs **as a Discord Activity** and **as a standalone web app** at **https://dice.housetandem.com**. On mobile, players **physically shake and throw** the dice using device motion; every player sees the same dice tumble and land on the same faces in real time.

**Stack:** Three.js (rendering) · cannon-es (physics) · DeviceMotion API (shake & throw) · PeerJS / WebRTC (peer-to-peer sync) · Cloudflare Workers with static assets + a Durable Object (hosting, Discord OAuth token exchange, WebSocket relay) · Vite + TypeScript (build)

---

## 1. Goals & Non-Goals

### Goals
- A shared 3D table with **two six-sided dice (2d6)**.
- A turn-based **"7, 11, Doubles"** points race (§6).
- **Shake-and-throw with device motion** on phones; mouse/touch flick fallback everywhere else (§5).
- Every participant sees **the same animation and the same result**.
- Run inside a Discord voice channel as an Activity, *and* at `dice.housetandem.com` with a shareable room link.
- Zero or near-zero server cost: static hosting + peer-to-peer data.

### Non-Goals (v1)
- Dice other than d6, or more than two dice.
- Private / hidden rolls — all rolls are public.
- Betting, currency, persistent accounts, or cross-session leaderboards.
- Anti-cheat beyond host-authoritative results.

---

## 2. Architecture Overview

```
                    ┌────────────────────────────────────┐
                    │  Cloudflare Worker (static assets) │
                    │  https://dice.housetandem.com      │
                    └───────────────┬────────────────────┘
                                    │
          ┌─────────────────────────┼──────────────────────────┐
          │                         │                          │
 ┌────────▼────────┐       ┌────────▼────────┐       ┌─────────▼────────┐
 │  Client (host)  │◄─────►│ Client (shooter)│◄─────►│ Client (peer C)  │
 │ Three.js + phys │ WebRTC│ DeviceMotion    │       │                  │
 └────────┬────────┘ data  └─────────────────┘       └──────────────────┘
          │        channels (star topology via host)
          │
 ┌────────▼──────────────────────────┐   ┌────────────────────────────────────┐
 │ PeerJS signaling server           │   │ Cloudflare Worker                  │
 │ + STUN / TURN                     │   │ route: dice.housetandem.com/api/*  │
 └───────────────────────────────────┘   │  - POST /api/token  (Discord OAuth)│
                                         │  - /api/relay/:room (Durable Object│
                                         │    WebSocket fallback, §4.4)       │
                                         └────────────────────────────────────┘
```

### Topology: host-authoritative star
- The **first player** in a room becomes host. All other peers connect to the host's PeerJS ID.
- The host owns **game state, turn order, and final roll results**. The *shooter* (whoever's turn it is) supplies the throw from their device; the host turns it into the authoritative roll.
- If the host leaves, the peer with the lowest join order is promoted (§4.3).

Note: *host* (network authority) and *shooter* (current player's turn) are separate roles.

---

## 3. Running Modes

| Mode | Entry | Identity | Room ID |
|---|---|---|---|
| **Discord Activity** | Launched from a voice channel | Discord user (Embedded App SDK + OAuth) | `discordSdk.instanceId` |
| **Standalone web** | `https://dice.housetandem.com/?room=<code>` | Guest name typed by player (`localStorage`) | 6-char code in URL; generated if absent |

Detection: if Discord's `frame_id` / `instance_id` query params are present, initialize the Discord SDK; otherwise run standalone.

### 3.1 Domain & hosting
- A single Cloudflare Worker with static assets serves the app, `/api/*` and the relay Durable Object, on the custom domain **`dice.housetandem.com`** (the `housetandem.com` zone is on Cloudflare; `wrangler deploy` creates the DNS record). This replaced the original Pages + separate Worker idea: one deploy, one origin, and Durable Objects need a Worker anyway.
- The app and `/api/*` share one origin (no CORS, single Discord URL mapping target).
- HTTPS is required for DeviceMotion and WebRTC — provided by Cloudflare.

### 3.2 Discord Activity specifics
- `@discord/embedded-app-sdk`: `ready()` → `authorize()` (scope: `identify`) → `POST /api/token` → `authenticate()`.
- Activities run in an iframe behind Discord's proxy (`<app_id>.discordsays.com`); all outbound requests must use **URL Mappings** in the Developer Portal:
  - `/` → `dice.housetandem.com`
  - `/peerjs` → PeerJS signaling host
- Call `patchUrlMappings()` so PeerJS's absolute URLs are rewritten through the proxy.
- Display name and avatar come from the authenticated user. Room membership comes from the transport, not the SDK.
- **Inside Discord the relay transport is the default**, because WebRTC through the Activity sandbox isn't guaranteed. API calls use `/.proxy/api/...`.

---

## 4. Networking

### 4.1 Signaling & peer IDs
- Peer IDs: `dice-<roomId>-host` for the host, random UUID for others.
- Join: try to register as `dice-<roomId>-host`; on `unavailable-id`, register randomly and connect to the host ID.
- Standalone v1 may use the public PeerJS cloud; a **self-hosted PeerJS server** (or Worker-based signaling) is expected for Discord (proxy mapping + reliability).

### 4.2 Message protocol (JSON over reliable data channel)

```ts
type Msg =
  | { t: "hello";     player: Player }                                   // peer → host
  | { t: "state";     players: Player[]; hostId: string; game: GameState } // host → all
  | { t: "shake";     shooter: string; intensity: number;                // shooter → host → all (~15 Hz, unreliable ok)
                      tilt: [number, number] }
  | { t: "throw_req"; throw: ThrowInput }                                // shooter → host
  | { t: "roll";      rollId: string; shooter: string;                   // host → all
                      initial: [BodyInit, BodyInit]; faces: [number, number] }
  | { t: "ping" } | { t: "pong" };

type Player    = { id: string; name: string; avatarUrl?: string; color: string; joinedAt: number };
type ThrowInput = { dir: [number, number]; speed: number; spin: number; shakeEnergy: number; source: "motion" | "flick" | "button" };
type BodyInit  = { pos: [number,number,number]; quat: [number,number,number,number];
                   vel: [number,number,number]; angVel: [number,number,number] };
```

`GameState` is defined in §6.

### 4.3 Host migration
- Every `state` message includes the ordered player list.
- On host disconnect, each peer waits `rank × 1.5 s` (rank by `joinedAt`, measured from when *it* noticed the loss), then tries to claim `dice-<roomId>-host`; the signaling server guarantees only one succeeds and the rest reconnect to it. The earliest joiner is preferred, not guaranteed. The relay needs none of this: the Durable Object's oldest connection is host.
- A 3 s heartbeat with a 10 s timeout detects vanished peers faster than WebRTC does.
- The new host keeps the last agreed state, drops the old host, and gives everyone 8 s to reconnect before pruning them.
- The in-flight roll is discarded; last confirmed `GameState` is kept and the shooter rerolls.

### 4.4 Fallback transport
WebRTC may be blocked inside Discord's iframe/proxy or behind strict NATs. Networking is written against an interface:

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
- `RelayTransport` — WebSocket to a **Cloudflare Durable Object** per room (`/api/relay/<roomId>`), same protocol, simple broadcast. Chosen per room with `?t=relay` (default inside Discord). A room can't mix transports, so rather than falling back silently, a failed WebRTC join shows a link to the relay version of the room.
- TURN credentials (e.g. Cloudflare Calls TURN) issued short-lived by the Worker.

---

## 5. Device Motion: Shake & Throw

### 5.1 Interaction model
1. **It's your turn** → the two dice appear "in your hand" (a cup view at the bottom of your screen).
2. **Press and hold** the screen (or the big *SHAKE* area) and **shake the phone** → dice rattle in the cup, with sound and haptics. Everyone else sees the shooter's dice rattling in a small "hand" indicator at the table edge, driven by `shake` messages.
3. **Throw** — either:
   - **Flick throw:** a sharp forward flick of the phone (acceleration spike then deceleration) while holding, or
   - **Release throw:** lift your finger after shaking; the throw uses the motion of the last ~150 ms.
4. Dice fly onto the shared table with a velocity/spin derived from the gesture.

Holding the screen while shaking prevents accidental throws and gives iOS/Android a clean user gesture for audio and permissions.

### 5.2 Permissions & platform handling
- **iOS Safari / iOS WebViews:** `DeviceMotionEvent.requestPermission()` must be called from a user gesture. Show a one-time "Enable shake to roll" button on first turn; remember the choice for the session.
- **Android Chrome:** `devicemotion` events are available without a prompt on HTTPS.
- **Inside Discord:** the Activity iframe must be permitted accelerometer/gyroscope access by Discord's iframe `allow` policy. **This is unverified and is the #1 spike in M1** (§10). If motion events never arrive within 1 s of a gesture, fall back automatically to touch flick.
- Feature detect: `'DeviceMotionEvent' in window` and that events actually fire with non-null `accelerationIncludingGravity`.

### 5.3 Signal processing
- Listen to `devicemotion`; use `acceleration` (gravity removed) when available, else high-pass filter `accelerationIncludingGravity` (α ≈ 0.8).
- **Shake energy:** exponential moving average of `|a|` above a noise floor (~1.5 m/s²). Drives rattle animation, sound volume, and `shake.intensity` (0–1).
- **Throw detection:** peak `|a|` > ~15 m/s² followed by a drop below ~5 m/s² within 120 ms, while holding.
- **Throw vector:** integrate acceleration over the ~150 ms window before release/peak → device-frame velocity. Map device axes to the table: phone's −Z (away from the user, "forward") → table forward, device X → table sideways. Use `screen.orientation.angle` to correct for landscape.
- **Spin:** from `rotationRate` magnitude (gyroscope) during the throw window, or derived from shake energy if unavailable.
- **Clamping & normalization:** `speed` clamped to a playable range so dice always reach the table and never leave it; minimum throw strength enforced so a lazy drop still tumbles. Weak gestures (< threshold) are ignored and the dice stay in hand.

### 5.4 Fallbacks (desktop & no-motion devices)
- **Touch/mouse flick:** press on the dice in the cup, drag, release — direction and speed from the last ~100 ms of pointer movement. Wiggling the pointer while held = shake.
- **Roll button:** always available for accessibility; produces a randomized `ThrowInput` with `source: "button"`.

### 5.5 Feedback
- **Haptics:** `navigator.vibrate()` pulses scaled by shake energy (Android; no-op on iOS).
- **Audio:** dice-in-cup rattle loop while shaking, impact sounds keyed off physics collision velocity on the table (Web Audio, unlocked on first gesture).

### 5.6 Fairness
The gesture only shapes the **throw** (direction, speed, spin). The host adds seeded random jitter to initial position, orientation, and angular velocity, so the outcome can't be controlled by a practiced flick. The host computes the result (§7.1).

---

## 6. Game: "7, 11, Doubles"

A points race with two dice.

### 6.1 Rules
- Players take turns as the **shooter** in join order.
- Each roll:
  - **Hit**: a total of **7** or **11** → **+1 point**; **doubles** (both dice show the same face) → **+2 points**. Either way the shooter **rolls again**.
  - **Miss**: anything else → the turn ends and the dice pass to the next player.
- The hit types never overlap: 7 and 11 are odd and doubles always total an even number, so each roll is worth 0, 1 or 2 points.
- **Match end:** the first player to reach the target wins immediately, even mid-streak. The default target is **10 points**; the host can pick 5, 10 or 21 in the lobby.
- **Odds:** 7 is 6/36, 11 is 2/36 and doubles are 6/36, so a roll hits 14/36 ≈ **39%** of the time and is worth 20/36 ≈ 0.56 points on average. An average turn scores about 0.9 points, so each player needs roughly 11 turns to reach 10.
- Players joining mid-match go to the end of the turn order with 0 points.
- If the shooter disconnects, the dice pass to the next player. Solo play is allowed (practice), so a match continues with one player.
- If the winner leaves the match-over screen, the table returns to the lobby.
- After a match, the host can start a **rematch**: scores reset and the first shooter rotates.

### 6.2 State

```ts
type HitKind = "seven" | "eleven" | "doubles";

type GameState = {
  phase: "lobby" | "awaitingThrow" | "rolling" | "matchOver";
  shooterId: string | null;
  turnOrder: string[];             // player ids
  scores: Record<string, number>;
  target: number;                  // points to win (5 | 10 | 21)
  streak: number;                  // consecutive hits in the current turn
  winnerId: string | null;
  lastRoll: { rollId: string; shooter: string; faces: [number, number]; total: number;
              hit: HitKind | null } | null;
  history: NonNullable<GameState["lastRoll"]>[]; // last 20 rolls
};
```

The host runs a pure reducer `applyRoll(state, faces) → state`, which is easy to unit-test. `classify(faces) → HitKind | null` checks doubles first, then a total of 7 or 11; `HIT_POINTS = { seven: 1, eleven: 1, doubles: 2 }`.

### 6.3 Announcements
After each roll, a large callout appears on screen:
- **"SEVEN!"** or **"YO-LEVEN!"** (+1), **"DOUBLE 4s!"** (+2): points scored, roll again
- streak callouts such as **"3 IN A ROW!"**
- **"Miss — dice to Bob"**
- **"ALICE WINS!"** with confetti at match end

---

## 7. Dice Simulation & Sync

### 7.1 Predetermined-result strategy
Physics engines aren't bit-for-bit deterministic across devices, so clients don't rely on identical simulation:

1. Shooter sends `throw_req` with their `ThrowInput`.
2. Host validates/clamps it, adds seeded jitter, and builds `BodyInit` for both dice.
3. Host picks the result faces with a CSPRNG (`crypto.getRandomValues`) — fair 1/6 per die independent of physics.
4. Host broadcasts `roll` with initial states + faces.
5. Each client simulates from the initial states **headlessly to rest** (fast-forward), sees which face lands up, and pre-rotates each die's *visual mesh* relative to its physics body so the authoritative face ends up on top. Then it plays the real-time animation. The correction is invisible because it's applied before the first frame.

Each client actually **records the whole simulation first** and then plays the recording back. That way the playback is exactly the run the correction was computed for, even if physics differs slightly between devices. Impacts recorded during the run drive the sounds. If a die rests cocked against a wall, the last few frames ease it flat. The host also re-plans a throw (up to 8 tries) if its own simulation ends cocked.

The shooter sees "Rolling…" for one round trip, then the same animation as everyone else. Scores and callouts are held back until the dice land.

### 7.2 Physics
- **cannon-es**: dice as `Box` bodies with slightly rounded visual meshes, ground plane, and walls forming a table with a back wall the dice bounce off.
- Fixed step 1/120 s; sleeping enabled; settled when both bodies sleep or after 6 s timeout (if cocked against a wall, nudge and re-settle).
- Face detection: local face normal with the greatest dot product against world `+Y`.

### 7.3 Rendering
- **Three.js** `WebGLRenderer`, perspective camera looking down the table at ~55°.
- Dice: rounded-cube geometry with pip textures (canvas-generated), tinted with the shooter's color.
- Green felt table, hemisphere + directional light, soft shadows (disabled on low-end mobile), `devicePixelRatio` capped at 2.
- Cup/hand view: overlay mini-scene at the bottom of the shooter's screen while shaking.

---

## 8. UI / UX

```
┌─────────────────────────────────────────────┐
│ 🎲 Room ABC123     Alice 3 · Bob 1 · Cara 0  │  ← players + scores, shooter highlighted
├─────────────────────────────────────────────┤
│   Bob is shooting · streak 2 · first to 10  │  ← phase banner
│                                             │
│              [ 3D dice table ]              │
│                                             │
├─────────────────────────────────────────────┤
│   ╭─────────────────────────────────╮       │
│   │  HOLD & SHAKE  — flick to throw │       │  ← shooter only: cup / shake zone
│   ╰─────────────────────────────────╯       │
├─────────────────────────────────────────────┤
│ Bob: 3 + 3 = 6 → DOUBLES! +2, roll again    │  ← roll log
└─────────────────────────────────────────────┘
```

- DOM overlay over the canvas, no UI framework for v1.
- Portrait-first for Discord mobile; landscape supported.
- Lobby screen: player list, target score picker (host), **Start** button, standalone "Copy invite link".
- Lock screen orientation is not possible in iframes — handle orientation via `screen.orientation.angle` (§5.3).

---

## 9. Project Structure

```
discord-activity-dice/
├── PLAN.md
├── README.md
├── package.json            ← Vite + TypeScript
├── vite.config.ts
├── index.html
├── src/
│   ├── main.ts             ← boot: detect mode, identity, transport, scene
│   ├── discord.ts          ← Embedded App SDK auth + participants
│   ├── identity.ts         ← Player (Discord or guest)
│   ├── net/
│   │   ├── protocol.ts     ← Msg types
│   │   ├── transport.ts    ← Transport interface
│   │   ├── peerjs.ts       ← PeerJsTransport
│   │   ├── relay.ts        ← RelayTransport (WebSocket)
│   │   └── room.ts         ← host election, migration, state sync
│   ├── input/
│   │   ├── motion.ts       ← DeviceMotion permission, filtering, shake energy, throw detection
│   │   ├── flick.ts        ← pointer flick fallback
│   │   └── throw.ts        ← ThrowInput normalization/clamping
│   ├── dice/
│   │   ├── mesh.ts         ← rounded d6 geometry + pip textures
│   │   ├── physics.ts      ← cannon-es world, table, simulate-to-rest
│   │   └── roller.ts       ← predetermined-result orchestration
│   ├── game/
│   │   └── sevenElevenDoubles.ts ← pure GameState reducer
│   ├── audio.ts            ← rattle + impact sounds, haptics
│   ├── scene.ts            ← renderer, camera, lights, table, cup view
│   └── ui.ts               ← DOM overlay, lobby, banners, log
└── worker/
    ├── src/index.ts        ← (config in wrangler.jsonc at the repo root)
    └── src/index.ts        ← /api/token, /api/relay (Durable Object)
```

---

## 10. Configuration & Secrets

| Name | Where | Purpose |
|---|---|---|
| `VITE_DISCORD_CLIENT_ID` | build env (`.env`) | Public client ID for SDK |
| `DISCORD_CLIENT_ID` | Worker var | OAuth token exchange |
| `DISCORD_CLIENT_SECRET` | Worker **secret** | OAuth token exchange — never shipped to client |
| `VITE_PEERJS_HOST` / `PORT` / `PATH` | build env (`.env`) | Signaling server (defaults to PeerJS cloud) |
| `TURN_*` | Worker secret | Short-lived TURN credentials |

`.env*` and `.dev.vars` are git-ignored.

---

## 11. Milestones

| # | Milestone | Deliverable |
|---|---|---|
| **M0** | Scaffold & deploy | Vite + TS project, Worker with static assets on `dice.housetandem.com` |
| **M1** | Motion spike ⚠️ | Minimal page that logs DeviceMotion on iOS Safari, Android Chrome, **and inside a Discord Activity on iOS + Android**. Decides whether motion is primary in Discord or flick-only |
| **M2** | Single-player dice | Table + 2d6 physics, face detection, roll button + pointer flick |
| **M3** | Shake & throw | `motion.ts` shake energy, throw detection, cup view, audio + haptics, tuning pass on real phones |
| **M4** | Predetermined results | Host-picked faces + mesh re-orientation, replay from `BodyInit` |
| **M5** | Standalone multiplayer | PeerJS transport, rooms, host election, `shake` broadcast, shared rolls, invite link |
| **M6** | 7, 11, Doubles game | Reducer, turn order, lobby, scoring, callouts |
| **M7** | Discord Activity | Developer Portal app, `/api/token`, SDK auth, URL mappings, `instanceId` rooms |
| **M8** | Resilience & polish | Host migration, Durable Object relay fallback, TURN, mobile perf tuning |

---

### Build status (2026-10-14)

| # | Status |
|---|---|
| M0 | ✅ Live at https://dice.housetandem.com (Worker custom domain), also at https://discord-activity-dice.pete-872.workers.dev |
| M1 | 🟡 Shake-and-throw confirmed working on two real phones in the standalone site (2026-10-14). Still open: whether Discord lets an Activity read motion sensors |
| M2–M6 | ✅ Built. Unit-tested, plus a headless multi-player e2e (`scripts/e2e.mjs`) on both transports, locally and in production |
| M7 | 🟡 Code complete (SDK auth, `/api/token`, `/.proxy` paths, `instanceId` rooms). Needs a Discord application ID and secret |
| M8 | ✅ Host migration, relay transport, stale-host eviction, reconnect grace, optional TURN. 🟡 Mobile performance tuning on real devices |

Known limitation: if a PeerJS host leaves just as it broadcasts a roll, a player who missed that message may take over from slightly older state, and that roll is lost.

## 12. Testing

- **Unit (Vitest):** `sevenElevenDoubles` reducer (all 36 face combinations classified, streaks, turn passing, win mid-streak, rematch), face detection, mesh re-orientation math (every face → every target face), throw normalization/clamping, shake/throw detector against recorded motion traces, host election ordering.
- **Motion fixtures:** record real `devicemotion` traces (shakes, flicks, lazy drops, walking around) from iOS and Android as JSON, replay them in tests to tune thresholds without a phone in hand.
- **Integration:** multiple local tabs in standalone mode — identical faces, scores, turn order.
- **Device:** iPhone (Safari + Discord app), Android (Chrome + Discord app), desktop Discord.
- **Network:** `?transport=relay`, simulated host disconnect mid-turn.

---

## 13. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| **DeviceMotion blocked inside Discord's Activity iframe** (permissions policy / WebView) | M1 spike first; automatic fallback to pointer flick; motion still works in standalone mode |
| iOS motion permission friction | Single clear "Enable shake to roll" prompt on first turn; flick fallback if denied |
| Accidental throws while shaking or walking | Hold-to-shake requirement + peak/decel throw detector + minimum strength |
| WebRTC blocked/limited in Discord | `Transport` abstraction + Durable Object relay fallback |
| Public PeerJS cloud unreliable / not mappable | Self-host PeerJS or Worker-based signaling |
| Physics divergence across devices | Host-authoritative faces + mesh re-orientation |
| Mobile GPU performance | Shadow toggle, DPR cap, simple geometry |
