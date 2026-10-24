# Shaker Remote — Plan & Specification

Use a phone's browser as a motion controller for a seat at a table that is running somewhere motion can't reach: a Discord Activity, a desktop browser, or a phone that has no motion sensors or where motion was denied.

> Status: **built** (2026-10-15). Milestone **M9** in [PLAN.md](PLAN.md). Decisions D1–D4 were accepted as recommended. Differences from the original plan are listed in §12.

## 1. Why

Inside Discord the game runs in a cross-origin iframe (`<app-id>.discordsays.com`). Device motion is gated by the Permissions Policy features `accelerometer` and `gyroscope`, which default to `self`. A cross-origin frame only gets them if the parent iframe's `allow` attribute delegates them. Discord's Activity iframe doesn't, and a frame cannot re-enable a feature its parent disabled. So `devicemotion` never fires, and on iOS `requestPermission()` is refused. Nothing in our code can change that.

References:
- [MDN: Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Permissions_Policy)
- [MDN: `accelerometer`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/accelerometer)
- [MDN: `gyroscope`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/gyroscope)
- [W3C Device Orientation and Motion §4](https://w3c.github.io/deviceorientation/)

A phone's own browser tab is a top-level page, so motion works there. The remote moves only the *input* to that tab. The table, dice and scores stay where they are.

## 2. User experience

### 2.1 At the table (Discord, or a desktop/no-motion browser)

1. **Detect the environment** (§3) once at boot. Re-check when the motion probe settles.
2. **When motion is unavailable**, the cup zone on your turn changes:
   - The hold-and-shake cup is **hidden**.
   - The primary button is **📱 Shake with your phone**.
   - A smaller **Quick roll** stays as a fallback (see §9, decision D1).
3. **Pressing 📱** opens the **Pair a remote** sheet:
   - A **QR code** of the remote link, generated locally (§6.4).
   - The **full link** below it in a read-only, select-all text field, plus a **Copy** button that falls back to selecting the text when the clipboard is blocked (it is in the Discord iframe).
   - Inside Discord on **mobile**: an **Open in browser on this phone** button that calls `discordSdk.commands.openExternalLink`. Discord shows its own leave-confirmation dialog.
   - Status text: *Waiting for your phone…* until the remote connects, then the sheet closes on its own.
4. **Once paired:**
   - A 📱 badge appears on your player chip, visible to everyone.
   - On your turn, the cup zone reads **Shake your phone!**.
   - Shake intensity streamed from the remote drives the same cup-shake animation and rattle sound that local shaking does today.
   - The sheet offers **Unpair** and **New link** (which revokes the old link).
5. If the remote **drops mid-turn**, the zone falls back to 📱 + Quick roll after the reconnect grace period, so the game never stalls.

When motion **is** available, the 📱 option still exists in the menu (⋯) as a secondary choice, e.g. for a phone on a stand or a tablet. The cup works as it does today.

### 2.2 On the remote (phone browser at `/remote`)

A single, lightweight full-screen page, with no Three.js or cannon-es, so it loads fast on mobile data.

| State | Screen |
|---|---|
| First open | Player name, avatar and color, plus a big **Tap to connect** button. That tap is the user gesture iOS needs for `DeviceMotionEvent.requestPermission()`, and it also starts the Wake Lock. |
| Connecting / reconnecting | Spinner and status text. |
| Not your turn | *Riley is rolling…* and a mini scoreboard. |
| Your turn | A big cup: **Hold, shake, flick or let go**. Haptics where available (`navigator.vibrate`, Android only). |
| Rolling | *Rolling…*. The result is held back until the dice land on the table (§5.4), then shows the callout (**SEVEN! +1 · roll again**). |
| Match over | Winner and final scores. |
| Seat gone / link revoked | *This remote is no longer linked. Scan a new code at the table.* |
| Motion denied or missing | Explain, and offer a touch-flick cup so the remote still works as a touch controller. |

## 3. Detection

New module `src/platform/capabilities.ts`.

### 3.1 In Discord?

`inDiscord` already exists in `src/platform/env.ts`: the `frame_id` and `instance_id` query params. It's confirmed by `sdk.ready()` succeeding. Keep it as-is.

### 3.2 Motion availability

```ts
type MotionCapability =
  | "probing"           // waiting for the first devicemotion event (≤1.5 s)
  | "needs-permission"  // iOS: available after a tap
  | "available"         // events are arriving
  | "blocked"           // a Permissions Policy forbids it (e.g. Discord iframe)
  | "unavailable";      // no sensors (desktop), no events, or permission denied
```

Order of checks:

1. **No API.** `typeof DeviceMotionEvent === "undefined"` → `unavailable`.
2. **Policy block.**
   - Where `document.featurePolicy` exists (Chromium, so Android): if `allowsFeature("accelerometer")` or `allowsFeature("gyroscope")` is false → `blocked`. This is a definitive answer and future-proof: if Discord ever delegates the features, we automatically use them.
   - Where it doesn't exist (Safari) and `inDiscord`: treat as `blocked` without calling `requestPermission()`. Calling it inside the frame would just be refused and could look like an error.
3. **Desktop.** `matchMedia("(pointer: coarse)")` is false and there is no touch → `unavailable` straight away. Don't wait out the probe or show *Enable shake*.
4. **iOS.** `requestPermission` exists → `needs-permission`. A denial becomes `unavailable`. It's sticky until reload, and that's how iOS behaves anyway.
5. **Otherwise probe.** No sample with real data within 1.5 s → `unavailable`. `MotionReader` already ignores null-valued events. This is what `ThrowController.listen()` does today; it moves into `capabilities.ts` and the controller consumes it.

`ThrowController.motion` keeps its current states. `blocked` maps to `unavailable` for the cup logic. The UI distinguishes the two only in the hint text: *"Discord doesn't allow motion — use your phone as a remote"* versus *"No motion sensors here"*.

### 3.3 Mobile vs desktop

Only used for UI choices (QR first vs *Open on this phone* first), never for rules:

- **Mobile:** `matchMedia("(pointer: coarse)")`, or the Discord launch param `platform=mobile` when in Discord.
- **Desktop:** everything else.

## 4. Identity & pairing

### 4.1 Remote identity

Each remote gets its **own** keypair, reusing `newIdentity()`: `remoteKey` and `remoteId = H(remoteKey)`.

It must **not** reuse the player's id. The relay closes an existing socket when the same id connects (`"replaced"`), so the remote would kick the Discord player off the table.

### 4.2 The link

```
https://dice.housetandem.com/remote?room=<roomId>&t=<relay|peerjs>#k=<remoteKey>
```

- **Origin:** always the public origin (`PUBLIC_ORIGIN`, from the build env, default `https://dice.housetandem.com`). Inside Discord, `location.origin` is `*.discordsays.com`, which a phone browser can't use.
- **Key in the fragment:** it is never sent in an HTTP request and never logged by Cloudflare. The remote page reads it, stores it in `sessionStorage` (so a refresh survives), and strips it from the URL with `history.replaceState`.
- **Transport:** comes from the table. Rooms are `relay` unless the table was opened with `?t=peerjs`.

### 4.3 Binding (host-authoritative)

1. The table player generates the remote identity and sends `{ t: "pair", remoteId }` to the host. The transport authenticates the sender as the player.
2. The host records `player.remoteId = remoteId`, replacing any previous one, and broadcasts `state`.
   - The binding lives in `Player`, so it survives host migration via `restore()`.
   - Every client can map a remote's `shake` to the right player.
3. The remote connects with its own key, with `role=remote` (§5). It sends `{ t: "remote-hello" }`.
4. The host checks that some player has `remoteId === from`. If not, it replies `{ t: "remote-status", linked: false }` and the remote shows *no longer linked*.
5. `{ t: "unpair" }` from the player clears `remoteId`. **New link** is unpair plus pair with a fresh identity, so any old QR or link becomes useless.

### 4.4 What the remote may do

- **Send `throw`** to the host. The host resolves `remoteId` to its player and runs the normal `canThrow` and busy checks **as that player**. The table player and their remote share one turn. Whichever throws first wins; the other is refused, as a duplicate throw is today.
- **Broadcast `shake`.** Clients accept it if `from` is the shooter **or** the shooter's `remoteId`.
- **Nothing else.** No `hello`, `start` or `rematch`, and it never appears in `players`.

## 5. Transport & server changes

### 5.1 Relay (Durable Object)

The relay (`worker/src/index.ts`) needs these changes:

- **Role parameter.** `/api/relay/:room?id&key&role=remote` stores `role` in the socket attachment.
- **Never host.** Host = earliest **player** socket; remotes are excluded from the ordering.
  - This is the critical one. Today a remote that connected first, or survived the table host leaving, would become host and stall the game, because it doesn't run `HostAuthority`.
- **Peers list.** `peers` lists only players.
  - Optionally send a separate `remotes` list, so the host can show the 📱 badge as *connected* vs *linked but offline*.
- **Remote messages.**
  - A remote may send `to: "host"` (throw, remote-hello) and `to: "all"` only for `shake`.
  - A remote receives everything the host broadcasts.
- **Limits.** Cap of 1 remote socket per bound player is enforced by the host, not the relay. Remotes count toward `MAX_SOCKETS_PER_ROOM`; raise it from 32 to 48. The shake rate limit applies as today.

### 5.2 PeerJS

The PeerJS transport (`src/net/peerjs.ts`) needs these changes:

- `options.role = "remote"`: the transport **never** tries to claim `dice-<room>-host`, either at first connect or after losing the host. It only joins, and keeps retrying until the migration deadline.
- The host's `admit` verifies the key as today and tags the connection's role from the `metadata`. Remotes are excluded from the `peers` emit and from the `successionDelay` ranking.
- Heartbeat and dead-timeout apply to remotes too.

### 5.3 Protocol (`src/net/protocol.ts`)

```ts
| { t: "pair"; remoteId: string }               // player → host
| { t: "unpair" }                               // player → host
| { t: "remote-hello" }                         // remote → host
| { t: "remote-status"; linked: boolean; playerId?: string }  // host → remote (to: that remote; see below)
```

- **`Player` change:** add `remoteId?: string`.
- **`isEnvelope`:** the `MSG_TYPES` set grows to include the new types.
- **Directed send:** `remote-status` is the first host→one-peer message. Add `Target = "host" | "all" | { peer: string }`, or simply broadcast it. It carries no secret, and remotes can match on `playerId`. **Recommendation:** broadcast it to keep the transports unchanged. The remote derives *linked* from `state` (any player with `remoteId === me`), so `remote-status` is a convenience.

### 5.4 No spoilers on the remote

The `roll` message gets `landsInMs` (the host already knows `frameCount * FRAME_DT * 1000`). The remote shows the result only after that delay, roughly when the dice land on the table screen. The table client ignores the field.

## 6. Client code layout

| File | Change |
|---|---|
| `src/platform/capabilities.ts` | **new** — detection in §3 |
| `src/remote/main.ts`, `remote.html`, `src/remote/remote.css` | **new** — remote page. Second Vite entry (`build.rollupOptions.input`); the Worker serves `/remote` → `remote.html` |
| `src/remote/link.ts` | **new** — build and parse the link, `PUBLIC_ORIGIN` |
| `src/ui/pairSheet.ts` | **new** — QR + link sheet, copy fallback, Open in browser |
| `src/input/controller.ts` | consumes `capabilities`; reused unchanged by the remote page (same `ThrowController`, `ShakeTracker`) |
| `src/net/room.ts` | `pair()`, `unpair()`. Shake acceptance via `remoteId`. A `remote` mode that skips `hello` and never builds a `HostAuthority` |
| `src/game/host.ts` | `pair`, `unpair`, `remote-hello` handling. `throw(from)` resolves `remoteId` → player |
| `src/net/relay.ts`, `src/net/peerjs.ts` | `role` option (§5) |
| `worker/src/index.ts` | roles in `RelayRoom`; `/remote` route |
| `src/main.ts`, `src/ui.ts` | 📱 button and badge; *Shake your phone!* zone state |
| `src/platform/discord.ts` | expose the `sdk` (for `openExternalLink`) |

### 6.4 QR code

- **Generated locally.** Discord's CSP blocks third-party requests, and sending the link (with its key) to a QR web service would leak it.
- **Library:** a small dependency-free encoder bundled with Vite, e.g. `uqr` or `qrcode-generator`.
- **Rendering:** an SVG, at error correction level M.
- **Size:** about 220 px, with a white quiet zone so it scans off a dark UI.

## 7. Security & privacy

| Risk | Mitigation |
|---|---|
| Someone sees the QR (screen-share, stream) and takes over your throws | The link controls only your throws, only in this room, and only while bound. The 📱 badge shows when a remote connects. **New link** revokes the old one. The sheet warns: *"Anyone with this code can roll for you."* |
| Link copied into a chat | Same as above. The key is in the fragment, so link-preview unfurlers and servers don't receive it (crawlers ignore fragments). |
| Remote becomes host | Prevented by roles on both transports (§5). Unit-tested. |
| Remote spams shakes or throws | Existing relay and PeerJS shake rate limits; host `busyUntil`; `canThrow`. |
| **Existing gap:** anyone who learns a Discord `instanceId` can join that table as a player from the website (`?room=<id>&t=relay`) | The remote link puts the room id in front of more people, so fix this alongside: `/api/token` returns an HMAC-signed *room ticket* for the instance, and the relay requires a valid ticket for **player** sockets in Discord rooms (prefix them `d-`). Remotes don't need a ticket because the host checks the binding. |
| Privacy policy | Add a line: the remote reads motion on the phone and sends only shake intensity and the throw vector. No new data categories. |

## 8. Edge cases

- **Remote opens before the table connects,** or during host migration: the remote shows *Waiting for the table…* and keeps retrying, using the existing reconnect logic.
- **Phone sleeps:** the relay evicts the socket after 16 s. On `visibilitychange` → visible, the remote reconnects immediately. The Wake Lock (where supported) keeps the screen on while the page is open.
- **The table player leaves:** they're pruned after 8 s, which drops the binding. The remote shows *no longer linked*.
- **The remote leaves:** the binding stays, so the same link reconnects. The badge shows *offline*, and the table offers Quick roll.
- **iOS:** permission must be requested from a tap (**Tap to connect**). A denial leaves the remote as a touch-flick controller.
- **Orientation:** `ShakeTracker.screenAngle` already handles rotation. No lock is needed.
- **Same phone in Discord:** *Open in browser on this phone* works, but the player has to switch apps to watch the roll. The callout on the remote (§5.4) softens that. Recommend a second device in the help text.
- **Two players on one phone in two tabs:** this works, but each tab needs its own focus. Not a goal.
- **Old Discord clients:** `openExternalLink` returns `{ opened: null }`. Ignore the result.

## 9. Decisions to confirm

- **D1 – Keep Quick roll when motion is unavailable?** **Recommended: yes**, as a small secondary button.
  - Without it, a player with only one device, or one whose remote dropped, can't take their turn, and the whole table stalls.
  - It also helps accessibility.
  - The hold-and-shake *cup* is hidden, as requested.
- **D2 – Offer the remote even when motion works?** **Recommended: yes**, as a menu item, not a primary button.
- **D3 – Spectator view on the remote** (mini dice animation)? **Recommended: no** for v1. Show text callouts only, to keep the page tiny.
- **D4 – Room tickets (§7)** in the same milestone? **Recommended: yes.** It's a small change and closes a hole the remote makes more visible.

## 10. Testing

**Unit (Vitest):**
- `HostAuthority`:
  - pair, unpair, re-pair.
  - A throw via the remote counts as the player's throw.
  - A throw from a remote bound to a non-shooter is refused.
  - An unbound remote is refused.
  - The binding survives `restore()`.
- `Room`: shake from a shooter's remote is accepted; shake from another remote is ignored.
- `capabilities`:
  - `featurePolicy` false → `blocked`.
  - In Discord without `featurePolicy` → `blocked`.
  - Desktop → `unavailable`.
  - iOS → `needs-permission`.
  - Probe timeout → `unavailable`.
- Link round trip: the fragment is parsed and then stripped.

**Relay (miniflare / `wrangler dev`):**
- A remote never becomes host, even when it connects first.
- `peers` excludes remotes.
- A remote's non-shake broadcast is dropped.

**E2E (`scripts/e2e.mjs --remote`):**
- One **table** page with `?nomotion` (forces `unavailable`) and one **remote** page at 390x844.
- The remote is driven by synthetic `DeviceMotionEvent`s (shake, then flick) dispatched with `page.evaluate`.
- Assert the table rolled for the right player, the remote showed the callout after `landsInMs`, and **New link** locks out the old remote.
- Run it on both transports, and once with a host migration while a remote is bound.

**Manual:**
- Discord desktop + iPhone remote.
- Discord desktop + Android remote.
- Discord mobile with *Open in browser on this phone*.
- Standalone desktop + phone remote.

## 11. Milestone M9 — build order

1. `capabilities.ts`; refactor `ThrowController` to use it; the cup zone respects `blocked`/`unavailable` and keeps Quick roll (D1).
2. Protocol and `HostAuthority` pairing, with unit tests.
3. Relay roles and PeerJS roles (never-host), with tests.
4. Remote page (second Vite entry, `/remote` route), reusing `ThrowController`.
5. Pair sheet: QR, link, copy fallback, `openExternalLink`; 📱 badge.
6. `landsInMs` and the remote callouts.
7. Room tickets for Discord rooms (D4).
8. E2E `--remote`, then deploy and run the manual matrix.
9. Docs: README *Playing in Discord* section, Privacy line, screenshots of the pair sheet and the remote.

## 12. As built

Differences from the plan above:

- **No `remote-status` message.** The remote works out whether it's linked from `state`: is any player's `remoteId` its own id? The host answers `remote-hello` with a state broadcast. Transports stay unchanged.
- **Where 📱 lives.** There's no ⋯ menu. 📱 sits in the top bar, which now stays above the lobby and match-over cards. The lobby also shows **📱 Roll with your phone** where motion is off.
- **The remote flag on envelopes.** Both the relay and the PeerJS host set `Envelope.remote`; they never take it from the sender. The host lets a remote send only `remote-hello` and `throw`, so a remote can never join as a player.
- **PeerJS role.** It's self-declared in the connection metadata. That isn't an escalation: anyone with a standalone room code can already join as a player.
- **Relay `peers`.** It's now `{ ids: players, remotes }`. Older clients ignore `remotes`, and older socket attachments without a role count as players.
- **Room tickets.** `/api/token` takes `{ code, instanceId, playerId }` and returns `{ access_token, room, ticket }`.
  - The room is `"d" + 30 hex` of an HMAC of the instance id. The ticket is an HMAC of the room and the player id.
  - The HMAC key is derived from `DISCORD_CLIENT_SECRET`, so there's no new secret to manage.
  - Clients that don't send the new fields keep the old behavior (the raw instance id as their room, and no ticket).
  - Tickets apply only to the relay. Discord's default transport is the relay; a forced `?t=peerjs` doesn't use tickets.
- **Re-pairing.** If the host loses our pairing (e.g. we were dropped and rejoined), the table quietly re-sends it, at most every 3 s.
- **`?nomotion`** forces the no-motion layout, for testing.
- **Headless testing.** Headless Chrome has no `DeviceMotionEvent`, so `e2e-remote.mjs` installs a stand-in with the same fields before the page loads.
