import "./style.css";
import type { PeerOptions } from "peerjs";
import { DiceAudio } from "./audio";
import { planRoll } from "./dice/plan";
import { preparePlayback } from "./dice/roller";
import { createGame, type GameState } from "./game/sevenElevenDoubles";
import { ThrowController } from "./input/controller";
import { buttonThrow } from "./input/throw";
import { PeerJsTransport } from "./net/peerjs";
import type { Player } from "./net/protocol";
import { RelayTransport } from "./net/relay";
import { Room, type Self } from "./net/room";
import type { Transport } from "./net/transport";
import { startDiscord } from "./platform/discord";
import { apiBase, debug, inDiscord, peerServer, transportChoice } from "./platform/env";
import { inviteLink, standaloneRoom, storedName, storeName } from "./platform/identity";
import { newIdentity } from "./net/identityKey";
import { DiceScene } from "./render/scene";
import { UI } from "./ui";

/** If the host never answers a throw, give the dice back after this long. */
const THROW_ACK_TIMEOUT_MS = 4_000;
/** Let the result callout breathe before the shooter can throw again. */
const AFTER_LANDING_MS = 700;

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

async function peerOptions(): Promise<PeerOptions> {
  const options: PeerOptions = { debug: debug ? 2 : 0, config: { iceServers: await iceServers() } };
  if (peerServer.host) {
    options.host = peerServer.host;
    options.port = peerServer.port ?? 443;
    options.path = peerServer.path ?? "/";
    options.secure = options.port === 443;
  }
  return options;
}

async function boot() {
  const audio = new DiceAudio();
  const transportKind = transportChoice();
  let roomId = "";
  let room: Room | null = null;
  let controller: ThrowController | null = null;

  const ui = new UI(
    {
      start: (target) => room?.start(target),
      rematch: () => room?.rematch(),
      quickRoll: () => {
        if (!room || !myTurn()) return;
        audio.unlock();
        throwDice(buttonThrow());
      },
      enableMotion: async () => {
        const ok = await controller?.requestMotionPermission();
        ui.showEnableMotion(false);
        ui.hint(ok ? "Shake enabled — hold the cup and shake!" : "Motion isn't available here — flick instead.");
        refresh();
      },
      toggleMute: () => {
        audio.setMuted(!audio.muted);
        audio.unlock();
        return audio.muted;
      },
      copyInvite: () => navigator.clipboard.writeText(inviteLink(roomId, transportKind)),
    },
    audio.muted,
  );
  document.addEventListener("pointerdown", () => audio.unlock(), { capture: true });

  const scene = new DiceScene(document.getElementById("stage")!);

  // ---- identity & room ----
  let self: Self;
  if (inDiscord) {
    try {
      ({ self, roomId } = await startDiscord());
    } catch (err) {
      ui.fatal(`Couldn't connect to Discord: ${(err as Error).message}`);
      return;
    }
  } else {
    roomId = standaloneRoom();
    const name = storedName() ?? (await ui.askName(""));
    storeName(name);
    self = { ...(await newIdentity()), name };
  }
  ui.removeNamePrompt(); // no-op if already gone; see removeNamePrompt
  ui.setRoom(roomId, !inDiscord);
  // Discord lists the Terms and Privacy links on the app's own page; plain links can't leave the Activity frame.
  document.getElementById("legal-links")!.hidden = inDiscord;

  ui.status({ kind: "connecting" });
  const transport: Transport =
    transportKind === "relay" ? new RelayTransport(roomId, self.id, self.key, apiBase)
      : new PeerJsTransport(roomId, self.id, self.key, await peerOptions());
  room = new Room(transport, self, (rollId, shooter, input) => planRoll(rollId, shooter, input));
  const r = room;

  // ---- what's on screen ----
  // `shown` lags the room's game while dice are in the air, so scores and
  // callouts never spoil a roll before it lands.
  let players: Player[] = [];
  let shown: GameState = createGame();
  let rollSeq = 0;
  let rolling = false;
  let cooling = false;
  let awaitingAck: ReturnType<typeof setTimeout> | undefined;

  const playerById = (id: string | null) => players.find((p) => p.id === id);
  const myTurn = () => shown.phase === "awaitingThrow" && shown.shooterId === self.id && !rolling && !cooling && awaitingAck === undefined;

  function refresh() {
    ui.render({ players, game: shown, selfId: self.id, hostId: r.hostId, isHost: r.isHost });
    const shooter = playerById(shown.shooterId);
    const mine = myTurn();
    controller?.setEnabled(mine);
    if (shown.phase !== "awaitingThrow") ui.setZone("hidden");
    else if (rolling || awaitingAck !== undefined) ui.setZone("rolling");
    else if (cooling) ui.setZone("settling", { shooterName: shooter?.id === self.id ? undefined : shooter?.name });
    else if (mine) ui.setZone("mine", { color: shooter?.color, motion: controller?.motion === "active" });
    else ui.setZone("waiting", { shooterName: shooter?.name });
    ui.showEnableMotion(mine && controller?.motion === "needs-permission");
    if (!rolling && shooter) scene.setColor(shooter.color);
    // A new match starts with the dice in hand.
    if (!rolling && shown.phase === "awaitingThrow" && !shown.lastRoll) scene.toHand();
  }

  function throwDice(input: Parameters<Room["throwDice"]>[0]) {
    awaitingAck = setTimeout(() => {
      awaitingAck = undefined;
      ui.hint("The host didn't catch that — try again.");
      refresh();
    }, THROW_ACK_TIMEOUT_MS);
    refresh();
    r.throwDice(input);
  }

  controller = new ThrowController(ui.zone, {
    onShake: (intensity) => {
      scene.setShake(intensity);
      audio.rattle(intensity);
      r.shake(intensity);
    },
    onThrow: (input) => throwDice(input),
    onHint: (text) => ui.hint(text),
    onHoldChange: (holding) => {
      ui.setHolding(holding);
      if (holding) scene.toHand();
    },
    onMotionState: () => refresh(),
  });

  r.on("state", (p, game) => {
    players = p;
    if (!rolling) shown = game;
    refresh();
  });

  r.on("roll", async (plan, game) => {
    const seq = ++rollSeq;
    clearTimeout(awaitingAck);
    awaitingAck = undefined;
    rolling = true;
    const shooter = playerById(plan.shooter);
    if (shooter) scene.setColor(shooter.color);
    refresh();
    await scene.play(preparePlayback(plan), (impact) => audio.impact(impact.strength, impact.withDie));
    if (seq !== rollSeq) return;
    rolling = false;
    cooling = true;
    shown = r.game;
    refresh();
    setTimeout(() => {
      if (seq !== rollSeq) return;
      cooling = false;
      refresh();
    }, AFTER_LANDING_MS);
    const record = game.lastRoll;
    if (record) ui.announceRoll(record, shooter, playerById(game.shooterId), self.id, game.phase === "matchOver");
  });

  r.on("shake", (_from, intensity) => {
    if (rolling) return;
    if (intensity > 0) scene.toHand();
    scene.setShake(intensity);
    audio.rattle(intensity);
  });

  r.on("role", () => refresh());
  r.on("status", (s) => ui.status(s, transportKind === "peerjs" && s.kind === "failed" ? inviteLink(roomId, "relay") : undefined));

  if (debug) Object.assign(window, { dice: { room: r, scene, self } });
  addEventListener("pagehide", () => r.leave());

  try {
    await r.join();
  } catch {
    // The status banner already explains what went wrong.
  }
}

void boot();
