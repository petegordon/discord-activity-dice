import "./style.css";
import { renderSVG } from "uqr";
import { DiceAudio } from "./audio";
import { planRoll } from "./dice/plan";
import { preparePlayback } from "./dice/roller";
import { createGame, type GameState } from "./game/sevenElevenDoubles";
import { CalibrationSheet } from "./input/calibrateUI";
import { ThrowController } from "./input/controller";
import { buttonThrow } from "./input/throw";
import { PeerJsTransport } from "./net/peerjs";
import { peerOptions } from "./net/peerOptions";
import type { Player } from "./net/protocol";
import { RelayTransport } from "./net/relay";
import { Room, type Self } from "./net/room";
import type { Transport } from "./net/transport";
import { startDiscord, type DiscordSession } from "./platform/discord";
import { apiBase, debug, inDiscord, transportChoice } from "./platform/env";
import { inviteLink, standaloneRoom, storedName, storeName } from "./platform/identity";
import { newIdentity } from "./net/identityKey";
import { remoteLink } from "./remote/link";
import { DiceScene } from "./render/scene";
import { UI } from "./ui";

/** If the host never answers a throw, give the dice back after this long. */
const THROW_ACK_TIMEOUT_MS = 4_000;
/** Let the result callout breathe before the shooter can throw again. */
const AFTER_LANDING_MS = 700;

/** Don't re-send a pairing the host hasn't reflected yet more often than this. */
const REPAIR_MS = 3_000;

async function boot() {
  const audio = new DiceAudio();
  const transportKind = transportChoice();
  let roomId = "";
  let room: Room | null = null;
  let controller: ThrowController | null = null;
  let calibration: CalibrationSheet | null = null;
  let discord: DiscordSession | null = null;
  /** Our shaker remote's identity, once the 📱 sheet has been opened. */
  let remote: { id: string; key: string; sentAt: number } | null = null;

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
      openRemote: () => void openRemote(false),
      calibrate: () => calibration?.open(),
      remoteNewLink: () => void openRemote(true),
      remoteUnpair: () => {
        room?.unpair();
        remote = null;
        ui.hidePair();
      },
      remoteOpenHere: () => {
        if (remote) void discord?.openExternal(remoteLink(roomId, transportKind, remote.key)).catch(() => {});
      },
    },
    audio.muted,
  );
  document.addEventListener("pointerdown", () => audio.unlock(), { capture: true });

  const scene = new DiceScene(document.getElementById("stage")!);

  // ---- identity & room ----
  let self: Self;
  if (inDiscord) {
    try {
      discord = await startDiscord();
      ({ self, roomId } = discord);
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
    transportKind === "relay" ? new RelayTransport(roomId, self.id, self.key, apiBase, { ticket: self.ticket })
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
  const me = () => playerById(self.id);
  /** Our paired phone is connected to the table right now. */
  const remoteOnline = () => !!remote && me()?.remoteId === remote.id && !!me()?.remoteOnline;
  let remoteWasOnline = false;

  /** Why the phone is the cup here; shown on the 📱 sheet. */
  function remoteWhy() {
    if (controller?.motion === "blocked" && inDiscord) {
      return "Discord doesn't let Activities read motion sensors. Scan this with your phone's camera to use its browser as your dice cup.";
    }
    if (controller?.motionOff) return "Scan this with your phone's camera to use it as your dice cup.";
    return "Scan this with another phone to use it as your dice cup, handy with this device on a stand.";
  }

  function paintPair() {
    if (!remote || !ui.pairOpen) return;
    const link = remoteLink(roomId, transportKind, remote.key);
    ui.showPair({
      link,
      qrSvg: renderSVG(link, { ecc: "M", border: 1 }),
      why: remoteWhy(),
      canOpenHere: !!discord?.mobile,
      paired: me()?.remoteId === remote.id,
      online: remoteOnline(),
    });
  }

  /** Show the 📱 sheet, pairing a new remote first if we have none (or `fresh` asks for a new link). */
  async function openRemote(fresh: boolean) {
    if (!room) return;
    if (fresh || !remote) {
      const { id, key } = await newIdentity();
      remote = { id, key, sentAt: Date.now() };
      room.pair(id);
    }
    ui.openPair();
    paintPair();
  }

  /** The host may have lost our pairing (e.g. we were dropped and rejoined); quietly re-send it. */
  function keepPaired() {
    const mine = me();
    if (!remote || !mine || mine.remoteId === remote.id || Date.now() - remote.sentAt < REPAIR_MS) return;
    remote.sentAt = Date.now();
    r.pair(remote.id);
  }

  function refresh() {
    ui.render({ players, game: shown, selfId: self.id, hostId: r.hostId, isHost: r.isHost });
    const shooter = playerById(shown.shooterId);
    const mine = myTurn();
    // No motion here: the cup is hidden and the phone (or Quick roll) throws.
    const phoneIsCup = !!controller?.motionOff || remoteOnline();
    controller?.setEnabled(mine && !phoneIsCup);
    ui.showLobbyPhone(!!controller?.motionOff && !remoteOnline());
    ui.showCalibrate(controller?.motion === "active" || controller?.motion === "needs-permission");
    if (shown.phase !== "awaitingThrow") ui.setZone("hidden");
    else if (rolling || awaitingAck !== undefined) ui.setZone("rolling");
    else if (cooling) ui.setZone("settling", { shooterName: shooter?.id === self.id ? undefined : shooter?.name });
    else if (mine) {
      ui.setZone("mine", {
        color: shooter?.color,
        motion: controller?.motion === "active",
        remote: phoneIsCup ? { online: remoteOnline(), why: "Roll with your phone, or use Quick roll" } : undefined,
      });
    } else ui.setZone("waiting", { shooterName: shooter?.name });
    ui.showEnableMotion(mine && !phoneIsCup && controller?.motion === "needs-permission");
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
  calibration = new CalibrationSheet(controller, (message) => ui.hint(message));

  r.on("state", (p, game) => {
    players = p;
    if (!rolling) shown = game;
    keepPaired();
    const online = remoteOnline();
    if (online !== remoteWasOnline) {
      ui.hint(online ? "📱 Phone connected. Shake it on your turn!" : "📱 Phone disconnected");
      if (online && ui.pairOpen) setTimeout(() => ui.hidePair(), 1200);
    }
    remoteWasOnline = online;
    paintPair();
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
  r.on("status", (s) => ui.showRemoteButton(s.kind === "connected"));
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
