import "./remote.css";
import { createGame, type GameState } from "../game/sevenElevenDoubles";
import { ThrowController } from "../input/controller";
import { playerIdFromKey } from "../net/identityKey";
import { PeerJsTransport } from "../net/peerjs";
import { peerOptions } from "../net/peerOptions";
import type { Player } from "../net/protocol";
import { RelayTransport } from "../net/relay";
import { Room } from "../net/room";
import type { TransportStatus } from "../net/transport";
import { apiBase, debug } from "../platform/env";
import { hitLabel } from "../ui";
import { parseRemoteLink } from "./link";

/**
 * The shaker remote: a phone browser tab that shakes and throws for a seat at
 * a table running elsewhere (Discord, a desktop). See SHAKER-REMOTE.md.
 */

/** If the host never answers a throw, give the dice back after this long. */
const THROW_ACK_TIMEOUT_MS = 4_000;
const AFTER_LANDING_MS = 700;
/** Used if an older host doesn't say when the dice land. */
const DEFAULT_LANDING_MS = 3_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function message(title: string, text: string, retry = false) {
  $("r-msg-title").textContent = title;
  $("r-msg-text").textContent = text;
  $("r-retry").hidden = !retry;
  $("r-message").hidden = false;
}

/** The key arrives in the link's fragment; keep it for refreshes, then take it out of the address bar. */
function remoteKey(room: string, fromLink: string | null): string | null {
  const storageKey = `dice.remote.${room}`;
  try {
    if (fromLink) sessionStorage.setItem(storageKey, fromLink);
    else fromLink = sessionStorage.getItem(storageKey);
  } catch {
    // storage unavailable; a refresh will need the link again
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return fromLink;
}

function boot() {
  const params = parseRemoteLink(location.href);
  const key = params ? remoteKey(params.room, params.key) : null;
  $("r-retry").addEventListener("click", () => location.reload());
  if (!params || !key) {
    $("r-start").hidden = true;
    message("Scan the code at the table", "Open the game, tap 📱, and scan the code with this phone's camera.");
    return;
  }

  const zone = $("zone");
  let room: Room | null = null;
  let selfId = "";
  let players: Player[] = [];
  let shown: GameState = createGame();
  let gotState = false;
  let rolling = false;
  let cooling = false;
  let awaitingAck: ReturnType<typeof setTimeout> | undefined;
  let rollSeq = 0;
  let wasMyTurn = false;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  const hint = (text: string) => {
    $("r-hint").textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => ($("r-hint").textContent = ""), 2400);
  };
  const me = () => players.find((p) => p.remoteId === selfId);
  const byId = (id: string | null) => players.find((p) => p.id === id);
  const myTurn = () => {
    const mine = me();
    return !!mine && shown.phase === "awaitingThrow" && shown.shooterId === mine.id && !rolling && !cooling && awaitingAck === undefined;
  };

  // Declared first: the controller reports its motion state (and so renders) while it's being constructed.
  let controller: ThrowController | null = null;
  controller = new ThrowController(zone, {
    onShake: (intensity) => room?.shake(intensity),
    onThrow: (input) => {
      awaitingAck = setTimeout(() => {
        awaitingAck = undefined;
        hint("The table didn't catch that. Try again.");
        render();
      }, THROW_ACK_TIMEOUT_MS);
      room?.throwDice(input);
      render();
    },
    onHint: hint,
    onHoldChange: (holding) => zone.classList.toggle("holding", holding),
    onMotionState: () => render(),
  });

  function renderMe(p: Player | undefined) {
    const box = $("r-me");
    box.replaceChildren();
    if (!p) return;
    box.style.setProperty("--pc", p.color);
    let av: HTMLElement;
    if (p.avatarUrl) {
      const img = document.createElement("img");
      img.src = p.avatarUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      av = img;
    } else {
      av = document.createElement("span");
      av.textContent = (p.name.trim()[0] ?? "?").toUpperCase();
    }
    av.className = "avatar";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    box.append(av, name);
  }

  function renderScores() {
    const list = $("r-scores");
    list.replaceChildren(
      ...(shown.phase === "lobby" ? [] : shown.turnOrder)
        .map((id) => byId(id))
        .filter((p): p is Player => !!p)
        .map((p) => {
          const li = document.createElement("li");
          li.style.setProperty("--pc", p.color);
          if (p.id === shown.shooterId && shown.phase === "awaitingThrow") li.className = "shooter";
          const sw = document.createElement("span");
          sw.className = "swatch";
          const score = document.createElement("b");
          score.textContent = String(shown.scores[p.id] ?? 0);
          li.append(sw, p.name + " ", score);
          return li;
        }),
    );
  }

  function render() {
    const mine = me();
    renderMe(mine);
    renderScores();
    if (gotState && !mine) {
      message("This link isn't active", "Tap 📱 at the table and scan the new code. This page will pick it up if the link comes back.");
    } else {
      $("r-message").hidden = true;
    }

    const turn = myTurn();
    controller?.setEnabled(turn);
    if (turn && !wasMyTurn && "vibrate" in navigator) navigator.vibrate([40, 60, 40]);
    wasMyTurn = turn;

    const shooter = byId(shown.shooterId);
    const title = zone.querySelector(".zone-title")!;
    const sub = zone.querySelector(".zone-sub")!;
    zone.classList.toggle("mine", turn);
    zone.classList.toggle("waiting", !turn);
    if (mine) zone.style.setProperty("--pc", mine.color);
    const banner = $("r-banner");
    banner.replaceChildren();

    if (!gotState) {
      title.textContent = "Connecting…";
      sub.textContent = "";
    } else if (shown.phase === "lobby") {
      title.textContent = "Waiting for the game";
      sub.textContent = "The host starts it at the table";
    } else if (shown.phase === "matchOver") {
      const winner = byId(shown.winnerId);
      title.textContent = winner ? (winner.id === mine?.id ? "🏆 You win!" : `🏆 ${winner.name} wins`) : "Game over";
      sub.textContent = "Rematch from the table";
    } else if (rolling || awaitingAck !== undefined) {
      title.textContent = "Rolling…";
      sub.textContent = "Watch the table";
    } else if (cooling) {
      title.textContent = shooter && shooter.id !== mine?.id ? `${shooter.name}'s up next` : "Get ready…";
      sub.textContent = "";
    } else if (turn) {
      title.textContent = "HOLD & SHAKE";
      sub.textContent = controller?.motion === "active" ? "Shake your phone, then flick it or let go" : "Hold, wiggle, then flick upward";
      banner.append(document.createElement("b"));
      banner.firstElementChild!.textContent = "Your roll";
      banner.append(` · first to ${shown.target}`);
    } else {
      title.textContent = shooter ? `${shooter.name} is rolling` : "Waiting…";
      sub.textContent = "";
    }
  }

  function showCallout(main: string, sub: string, tone: "hit" | "miss") {
    const c = $("r-callout");
    c.querySelector(".callout-main")!.textContent = main;
    c.querySelector(".callout-sub")!.textContent = sub;
    c.className = `r-callout ${tone}`;
    void c.offsetWidth; // restart the animation
    c.classList.add("show");
  }

  function status(s: TransportStatus) {
    const conn = $("r-conn");
    conn.classList.toggle("ok", s.kind === "connected");
    conn.textContent = s.kind === "connected" ? "Connected" : s.kind === "failed" ? "Offline" : s.kind === "reconnecting" ? "Reconnecting…" : "Connecting…";
    if (s.kind === "failed") message("Couldn't reach the table", `${s.reason} Make sure the game is still open.`, true);
  }

  /** Keep the screen on while connected. The browser drops the lock whenever the page is hidden. */
  async function keepAwake() {
    try {
      await navigator.wakeLock?.request("screen");
    } catch {
      // not supported, or the page isn't visible
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && room) void keepAwake();
  });

  async function connect() {
    selfId = await playerIdFromKey(key!);
    const transport =
      params!.transport === "relay"
        ? new RelayTransport(params!.room, selfId, key!, apiBase, { role: "remote" })
        : new PeerJsTransport(params!.room, selfId, key!, await peerOptions(), "remote");
    const r = new Room(
      transport,
      { id: selfId, key: key!, name: "remote" },
      () => {
        throw new Error("Remotes never plan rolls");
      },
      Date.now,
      "remote",
    );
    room = r;
    r.on("status", status);
    r.on("state", (p, game) => {
      players = p;
      gotState = true;
      if (!rolling) shown = game;
      render();
    });
    r.on("roll", (_plan, game, landsInMs) => {
      const seq = ++rollSeq;
      clearTimeout(awaitingAck);
      awaitingAck = undefined;
      rolling = true;
      render();
      // Hold the result until the dice land on the table, so the phone doesn't spoil it.
      setTimeout(() => {
        if (seq !== rollSeq) return;
        rolling = false;
        cooling = true;
        shown = r.game;
        const record = game.lastRoll;
        const mine = me();
        if (record) {
          const shooterName = record.shooter === mine?.id ? "you" : (byId(record.shooter)?.name ?? "Someone");
          const next = byId(game.shooterId);
          let sub: string;
          if (game.phase === "matchOver") sub = `+${record.points}, ${shooterName === "you" ? "you win!" : `${shooterName} wins!`}`;
          else if (record.points) sub = `+${record.points} · ${shooterName === "you" ? "roll again!" : `${shooterName} rolls again`}`;
          else sub = `Miss, dice to ${next ? (next.id === mine?.id ? "you" : next.name) : "the next player"}`;
          showCallout(hitLabel(record), sub, record.points ? "hit" : "miss");
          if (record.shooter === mine?.id && record.points && "vibrate" in navigator) navigator.vibrate([60, 40, 120]);
        }
        render();
        setTimeout(() => {
          if (seq !== rollSeq) return;
          cooling = false;
          render();
        }, AFTER_LANDING_MS);
      }, landsInMs ?? DEFAULT_LANDING_MS);
    });
    if (debug) Object.assign(window, { dice: { room: r, self: { id: selfId }, controller } });
    addEventListener("pagehide", () => r.leave());
    try {
      await r.join();
    } catch {
      // status() already explained
    }
  }

  $("r-connect").addEventListener("click", () => {
    // iOS only grants motion from inside a tap, so ask before anything async.
    if (controller?.motion === "needs-permission") void controller.requestMotionPermission();
    $("r-start").hidden = true;
    void keepAwake();
    render();
    void connect();
  });
  render();
}

boot();
