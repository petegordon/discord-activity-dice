import { TARGET_OPTIONS } from "./game/rules";
import type { GameState, RollRecord } from "./game/sevenElevenDoubles";
import type { Player } from "./net/protocol";
import type { TransportStatus } from "./net/transport";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string } = {}, ...children: Node[]) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

export type View = {
  players: Player[];
  game: GameState;
  selfId: string;
  hostId: string | null;
  isHost: boolean;
};

export type UIHandlers = {
  start: (target: number) => void;
  rematch: () => void;
  quickRoll: () => void;
  enableMotion: () => void;
  toggleMute: () => boolean;
  copyInvite: () => Promise<void>;
};

function hitLabel(r: RollRecord): string {
  switch (r.hit) {
    case "seven":
      return "SEVEN!";
    case "eleven":
      return "YO-LEVEN!";
    case "doubles":
      return `DOUBLE ${r.faces[0]}s!`;
    default:
      return String(r.total);
  }
}

export class UI {
  readonly zone = $("zone");
  private callout = $("callout");
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private lastCalloutRoll: string | null = null;

  constructor(handlers: UIHandlers, muted: boolean) {
    const target = $<HTMLSelectElement>("target");
    for (const n of TARGET_OPTIONS) target.append(new Option(String(n), String(n), n === 10, n === 10));
    $("start").addEventListener("click", () => handlers.start(Number(target.value)));
    $("rematch").addEventListener("click", () => handlers.rematch());
    $("quick-roll").addEventListener("click", () => handlers.quickRoll());
    $("enable-motion").addEventListener("click", () => handlers.enableMotion());
    const mute = $("mute");
    const paintMute = (m: boolean) => {
      mute.textContent = m ? "🔇" : "🔊";
      mute.setAttribute("aria-label", m ? "Unmute sounds" : "Mute sounds");
    };
    paintMute(muted);
    mute.addEventListener("click", () => paintMute(handlers.toggleMute()));
    $("copy-invite").addEventListener("click", async () => {
      const btn = $("copy-invite");
      try {
        await handlers.copyInvite();
        btn.textContent = "Copied!";
      } catch {
        btn.textContent = "Copy failed";
      }
      setTimeout(() => (btn.textContent = "Copy invite"), 1600);
    });
  }

  askName(initial: string): Promise<string> {
    const layer = $("name-prompt");
    const input = $<HTMLInputElement>("name-input");
    input.value = initial;
    layer.hidden = false;
    setTimeout(() => input.focus(), 50);
    return new Promise((resolve) => {
      $("name-form").addEventListener(
        "submit",
        (e) => {
          e.preventDefault();
          const name = input.value.trim() || "Player";
          this.removeNamePrompt();
          resolve(name);
        },
        { once: true },
      );
    });
  }

  /**
   * Take the name field out of the page for good. iOS "Shake to Undo" offers
   * to undo typing in any text field still in the document, which pops up
   * every time a player shakes the dice.
   */
  removeNamePrompt() {
    const input = document.getElementById("name-input");
    if (input === document.activeElement) (input as HTMLInputElement).blur();
    document.getElementById("name-prompt")?.remove();
  }

  setRoom(code: string, showInvite: boolean) {
    $("room-code").textContent = code.length > 8 ? code.slice(0, 6) + "…" : code;
    $("copy-invite").hidden = !showInvite;
  }

  render(v: View) {
    const { game, players, selfId } = v;
    const byId = new Map(players.map((p) => [p.id, p]));
    const shooter = game.shooterId ? byId.get(game.shooterId) : undefined;

    // Players bar.
    const list = $("players");
    list.replaceChildren(
      ...game.turnOrder
        .map((id) => byId.get(id))
        .filter((p): p is Player => !!p)
        .map((p) => {
          const li = el("li", { className: "player" + (p.id === game.shooterId && game.phase === "awaitingThrow" ? " shooter" : "") });
          li.style.setProperty("--pc", p.color);
          li.append(avatar(p), el("span", { className: "name", text: p.id === selfId ? `${p.name} (you)` : p.name }));
          if (game.phase !== "lobby") li.append(el("span", { className: "score", text: String(game.scores[p.id] ?? 0) }));
          return li;
        }),
    );

    // Banner.
    const banner = $("banner");
    banner.replaceChildren();
    if (game.phase === "awaitingThrow" && shooter) {
      const who = shooter.id === selfId ? "Your" : `${shooter.name}'s`;
      banner.append(el("b", { text: `${who} roll` }));
      if (game.streak > 0) banner.append(` · ${game.streak} in a row`);
      banner.append(` · first to ${game.target}`);
    }

    // Lobby card.
    $("lobby").hidden = game.phase !== "lobby";
    if (game.phase === "lobby") {
      $("lobby-players").replaceChildren(...players.map((p) => playerRow(p, p.id === v.hostId ? "host" : p.id === selfId ? "you" : "")));
      $("host-controls").hidden = !v.isHost;
      $("lobby-wait").hidden = v.isHost;
    }

    // Match over card.
    const over = game.phase === "matchOver";
    $("match-over").hidden = !over;
    if (over) {
      const winner = game.winnerId ? byId.get(game.winnerId) : undefined;
      $("winner").textContent = winner ? (winner.id === selfId ? "You win!" : `${winner.name} wins!`) : "Game over";
      const ranked = [...game.turnOrder].sort((a, b) => (game.scores[b] ?? 0) - (game.scores[a] ?? 0));
      $("final-scores").replaceChildren(
        ...ranked.map((id) => byId.get(id)).filter((p): p is Player => !!p).map((p) => playerRow(p, String(game.scores[p.id] ?? 0), true)),
      );
      $("rematch").hidden = !v.isHost;
      $("rematch-wait").hidden = v.isHost;
    }

    // Log.
    $("log").replaceChildren(
      ...game.history
        .slice(0, 3)
        .map((r) => {
          const name = byId.get(r.shooter)?.name ?? "Someone";
          const li = el("li", { text: `${name}: ${r.faces[0]} + ${r.faces[1]} = ${r.total}` });
          if (r.points) li.append(" ", el("span", { className: "pts", text: `${hitLabel(r)} +${r.points}` }));
          return li;
        }),
    );
  }

  /** The cup zone: yours to shake, or showing whose turn it is. */
  setZone(state: "mine" | "rolling" | "waiting" | "hidden", opts: { color?: string; motion?: boolean; shooterName?: string } = {}) {
    const zone = this.zone;
    zone.hidden = state === "hidden";
    zone.classList.toggle("mine", state === "mine");
    zone.classList.toggle("waiting", state !== "mine");
    if (opts.color) zone.style.setProperty("--pc", opts.color);
    const title = zone.querySelector(".zone-title")!;
    const sub = zone.querySelector(".zone-sub")!;
    if (state === "mine") {
      title.textContent = "HOLD & SHAKE";
      sub.textContent = opts.motion ? "Shake your phone, then flick it or let go to throw" : "Hold here, wiggle, then flick upward to throw";
      zone.setAttribute("aria-label", "Hold and shake to roll the dice");
    } else if (state === "rolling") {
      title.textContent = "Rolling…";
      sub.textContent = "";
    } else {
      title.textContent = opts.shooterName ? `${opts.shooterName} is rolling` : "Waiting…";
      sub.textContent = "";
    }
    $("quick-roll").hidden = state !== "mine";
  }

  setHolding(holding: boolean) {
    this.zone.classList.toggle("holding", holding);
  }

  showEnableMotion(show: boolean) {
    $("enable-motion").hidden = !show;
  }

  hint(text: string, ms = 2400) {
    const h = $("hint");
    h.textContent = text;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => (h.textContent = ""), ms);
  }

  announceRoll(record: RollRecord, shooter: Player | undefined, nextShooter: Player | undefined, selfId: string, gameOver: boolean) {
    if (record.rollId === this.lastCalloutRoll) return;
    this.lastCalloutRoll = record.rollId;
    const mine = record.shooter === selfId;
    const main = hitLabel(record);
    let sub: string;
    if (gameOver) sub = `+${record.points} — ${mine ? "you win!" : `${shooter?.name ?? "Someone"} wins!`}`;
    else if (record.points) sub = `+${record.points} · ${mine ? "roll again!" : `${shooter?.name ?? "Someone"} rolls again`}`;
    else sub = `Miss — dice to ${nextShooter ? (nextShooter.id === selfId ? "you" : nextShooter.name) : "the next player"}`;
    this.showCallout(main, sub, record.points ? "hit" : "miss");
  }

  private showCallout(main: string, sub: string, tone: "hit" | "miss") {
    const c = this.callout;
    c.querySelector(".callout-main")!.textContent = main;
    c.querySelector(".callout-sub")!.textContent = sub;
    c.className = `callout ${tone}`;
    void c.offsetWidth; // restart the animation
    c.classList.add("show");
  }

  status(s: TransportStatus | null, relayLink?: string) {
    const box = $("status");
    box.className = "status";
    box.replaceChildren();
    if (!s || s.kind === "connected") {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (s.kind === "connecting") box.textContent = "Connecting to the table…";
    else if (s.kind === "reconnecting") box.textContent = "Connection lost — reconnecting…";
    else {
      box.classList.add("error");
      box.append(s.reason);
      if (relayLink) {
        const a = el("a", { text: "Use the relay instead" });
        a.href = relayLink;
        box.append(" ", a);
      }
    }
  }

  fatal(message: string) {
    this.status({ kind: "failed", reason: message });
    this.setZone("hidden");
  }
}

function avatar(p: Player): HTMLElement {
  if (p.avatarUrl) {
    const img = el("img", { className: "avatar" });
    img.alt = "";
    img.src = p.avatarUrl;
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.replaceWith(initialBadge(p));
    return img;
  }
  return initialBadge(p);
}

function initialBadge(p: Player): HTMLElement {
  const span = el("span", { className: "avatar", text: (p.name.trim()[0] ?? "?").toUpperCase() });
  span.style.setProperty("--pc", p.color);
  return span;
}

function playerRow(p: Player, tag: string, scoreTag = false): HTMLElement {
  const li = el("li");
  li.style.setProperty("--pc", p.color);
  li.append(el("span", { className: "swatch" }), el("span", { className: "grow", text: p.name }), el("span", { className: scoreTag ? "score" : "muted", text: tag }));
  return li;
}
