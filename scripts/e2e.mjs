// End-to-end smoke test: two (or more) headless Chrome players in one room.
// Usage: node scripts/e2e.mjs [baseUrl] [relay|peerjs] [players]
// Expects `npm run preview` (wrangler dev) to be serving baseUrl.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const transport = process.argv[3] ?? "relay";
const count = Number(process.argv[4] ?? 2);
const room = `E2E${Date.now().toString(36).toUpperCase()}`;
const names = ["Alice", "Bob", "Cara", "Dan"];
const outDir = "scripts/out";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});

const errors = [];
const players = [];
for (let i = 0; i < count; i++) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, hasTouch: true });
  await ctx.addInitScript((name) => localStorage.setItem("dice.name", name), names[i]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${names[i]}] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/is taken|Aborting|Could not connect to peer/.test(m.text()) && errors.push(`[${names[i]}] console: ${m.text()}`));
  await page.goto(`${base}/?room=${room}&t=${transport}&debug`);
  await page.waitForFunction(() => window.dice?.room?.players?.length > 0, null, { timeout: 30_000, polling: 200 });
  players.push({ name: names[i], page });
  await page.waitForTimeout(300);
}

process.on("unhandledRejection", async (e) => {
  console.log("FAILED:", e.message.split("\n")[0], "at line", (e.stack.match(/e2e\.mjs:(\d+)/) ?? [])[1]);
  for (const p of players) {
    try {
      console.log(p.name, JSON.stringify(await p.page.evaluate(() => ({
        isHost: window.dice.room.isHost, hostId: window.dice.room.hostId, self: window.dice.self.id,
        players: window.dice.room.players.map((x) => x.id), phase: window.dice.room.game.phase, shooter: window.dice.room.game.shooterId,
        hist: window.dice.room.game.history.length, rolling: window.dice.scene.isRolling,
        zone: document.querySelector(".zone-title")?.textContent, hint: document.getElementById("hint").textContent,
        status: document.getElementById("status").textContent,
      }))));
    } catch (err) { console.log(p.name, "eval failed", err.message); }
  }
  console.log("errors:", errors);
  process.exit(2);
});

const snapshot = (p) => p.page.evaluate(() => ({ players: window.dice.room.players.map((x) => x.name), game: window.dice.room.game, isHost: window.dice.room.isHost }));

// Everyone sees everyone.
await Promise.all(players.map((p) => p.page.waitForFunction((n) => window.dice.room.players.length === n, count, { timeout: 30_000, polling: 200 })));
console.log("joined:", (await snapshot(players[0])).players.join(", "));
const host = players.find((p) => p.page) && (await Promise.all(players.map(snapshot))).findIndex((s) => s.isHost);
console.log("host:", players[host].name);
await players[0].page.screenshot({ path: `${outDir}/${transport}-lobby.png` });

// Host starts a short match.
await players[host].page.selectOption("#target", "5");
await players[host].page.click("#start");
await players[0].page.waitForTimeout(500);
await players[0].page.screenshot({ path: `${outDir}/${transport}-start.png` });

// Play until someone wins, using Quick roll for whoever's turn it is.
let rolls = 0;
for (; rolls < 80; rolls++) {
  const s = await snapshot(players[0]);
  if (s.game.phase === "matchOver") break;
  const shooterId = s.game.shooterId;
  const prevRoll = s.game.history[0]?.rollId ?? null;
  let shooter = null;
  for (const p of players) if ((await p.page.evaluate(() => window.dice.self.id)) === shooterId) shooter = p;
  await shooter.page.waitForSelector("#quick-roll:not([hidden])", { timeout: 15_000 });
  if (rolls === 0) {
    // A real gesture: press the cup, wiggle, and flick upward.
    const box = await shooter.page.locator("#zone").boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await shooter.page.mouse.move(x, y);
    await shooter.page.mouse.down();
    for (let i = 0; i < 6; i++) await shooter.page.mouse.move(x + (i % 2 ? 40 : -40), y, { steps: 2 });
    await shooter.page.mouse.move(x, y - 160, { steps: 4 });
    await shooter.page.mouse.up();
  } else {
    await shooter.page.click("#quick-roll");
  }
  if (rolls === 0) {
    await players[0].page.waitForTimeout(450);
    await players[0].page.screenshot({ path: `${outDir}/${transport}-midroll.png` });
  }
  // Wait until every player has finished animating this roll.
  await Promise.all(
    players.map((p) => p.page.waitForFunction((prev) => window.dice.room.game.history[0]?.rollId !== prev && !window.dice.scene.isRolling, prevRoll, { timeout: 20_000, polling: 200 })),
  ).catch(async (e) => {
    for (const p of players) console.log(p.name, await p.page.evaluate(() => ({ hist: window.dice.room.game.history.length, rolling: window.dice.scene.isRolling, vis: document.visibilityState })));
    throw e;
  });
  if (rolls === 0) await players[0].page.screenshot({ path: `${outDir}/${transport}-landed.png` });
}

const finals = await Promise.all(players.map(snapshot));
const key = (s) => JSON.stringify({ scores: s.game.scores, winner: s.game.winnerId, history: s.game.history.map((h) => h.faces) });
const consistent = finals.every((s) => key(s) === key(finals[0]));
await players[0].page.waitForTimeout(600);
await players[0].page.screenshot({ path: `${outDir}/${transport}-over.png` });
for (const [i, p] of players.entries()) await p.page.screenshot({ path: `${outDir}/${transport}-final-${i}.png` });

// Host migration: the host leaves; someone else must take over and the game continues.
let migrated = true;
if (count > 2) {
  const leaving = players.splice(host, 1)[0];
  await leaving.page.context().close();
  const t0 = Date.now();
  await Promise.all(players.map((p) => p.page.waitForFunction((n) => window.dice.room.players.length === n, count - 1, { timeout: 40_000, polling: 250 })));
  const roles = await Promise.all(players.map(snapshot));
  const newHost = players[roles.findIndex((r) => r.isHost)];
  console.log("migrated to", newHost?.name, "in", Date.now() - t0, "ms");
  // If the departed host was the winner, the table is already back in the lobby.
  if (await newHost.page.isVisible("#rematch")) await newHost.page.click("#rematch");
  await newHost.page.waitForSelector("#start:visible", { timeout: 10_000 });
  await newHost.page.click("#start");
  const s2 = await snapshot(newHost);
  const prevRoll = s2.game.history[0]?.rollId ?? null;
  let shooter = null;
  for (const p of players) if ((await p.page.evaluate(() => window.dice.self.id)) === s2.game.shooterId) shooter = p;
  await shooter.page.waitForSelector("#quick-roll:not([hidden])", { timeout: 15_000 });
  await shooter.page.click("#quick-roll");
  await Promise.all(players.map((p) => p.page.waitForFunction((prev) => window.dice.room.game.history[0]?.rollId !== prev && !window.dice.scene.isRolling, prevRoll, { timeout: 20_000, polling: 200 })));
  const after = await Promise.all(players.map(snapshot));
  migrated = after.every((a) => JSON.stringify(a.game.scores) === JSON.stringify(after[0].game.scores)) && after.filter((a) => a.isHost).length === 1;
  console.log("after migration scores:", after[0].game.scores, "ok:", migrated);
}

console.log("rolls:", rolls, "phase:", finals[0].game.phase, "scores:", finals[0].game.scores);
console.log("consistent across players:", consistent);
console.log("errors:", errors.length ? errors : "none");
await browser.close();
process.exit(migrated && consistent && finals[0].game.phase === "matchOver" && !errors.length ? 0 : 1);
