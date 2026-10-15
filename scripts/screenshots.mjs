// Captures marketing screenshots by playing real games (no rigged dice) with
// headless phone-sized players, then saves them to public/screenshots/.
// Usage: node scripts/screenshots.mjs [baseUrl]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "https://dice.housetandem.com";
const out = "public/screenshots";
mkdirSync(out, { recursive: true });

const room = `SHOT${Date.now().toString(36).toUpperCase()}`;
const names = ["Sam", "Riley", "Jordan"];
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const players = [];
for (const name of names) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((n) => localStorage.setItem("dice.name", n), name);
  const page = await ctx.newPage();
  await page.goto(`${base}/?room=${room}&t=relay&debug`);
  await page.waitForFunction(() => window.dice?.room?.players?.length > 0, null, { polling: 200, timeout: 30_000 });
  players.push({ name, page, id: await page.evaluate(() => window.dice.self.id) });
  await page.waitForTimeout(300);
}
await Promise.all(players.map((p) => p.page.waitForFunction((n) => window.dice.room.players.length === n, names.length, { polling: 200 })));
const host = players[0];

const shot = async (p, file) => {
  await p.page.screenshot({ path: `${out}/${file}` });
  console.log("saved", file);
};
const game = () => host.page.evaluate(() => window.dice.room.game);
const shooterOf = (g) => players.find((p) => p.id === g.shooterId);

await shot(host, "lobby.png");
await host.page.selectOption("#target", "10");
await host.page.click("#start");

const wanted = new Set(["seven", "eleven", "doubles"]);
let shookAndTumbled = false;

for (let roll = 0; roll < 200; roll++) {
  let g = await game();
  if (g.phase === "matchOver") {
    if (!wanted.size) break;
    await host.page.click("#rematch");
    await host.page.click("#start");
    g = await game();
  }
  const shooter = shooterOf(g);
  await shooter.page.waitForSelector("#quick-roll:not([hidden])", { timeout: 15_000 });
  const prev = g.history[0]?.rollId ?? null;

  if (!shookAndTumbled) {
    // Hold the cup and wiggle so the dice rattle in hand, then flick to throw.
    const box = await shooter.page.locator("#zone").boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await shooter.page.mouse.move(x, y);
    await shooter.page.mouse.down();
    for (let i = 0; i < 14; i++) await shooter.page.mouse.move(x + (i % 2 ? 60 : -60), y + (i % 3) * 8, { steps: 2 });
    await shot(shooter, "shaking.png");
    for (let i = 0; i < 4; i++) await shooter.page.mouse.move(x + (i % 2 ? 60 : -60), y, { steps: 2 });
    await shooter.page.mouse.move(x, y - 180, { steps: 3 });
    await shooter.page.mouse.up();
    const threw = await shooter.page
      .waitForFunction(() => window.dice.scene.isRolling, null, { polling: 30, timeout: 4_000 })
      .then(() => true, () => false);
    if (threw) {
      await shooter.page.waitForTimeout(380);
      await shot(shooter, "rolling.png");
      shookAndTumbled = true;
    } else {
      console.log("flick didn't throw (hint: %s); using Quick roll", await shooter.page.textContent("#hint"));
      await shooter.page.waitForSelector("#quick-roll:not([hidden])", { timeout: 10_000 });
      await shooter.page.click("#quick-roll");
    }
  } else {
    await shooter.page.click("#quick-roll");
  }

  await shooter.page.waitForFunction((p) => window.dice.room.game.history[0]?.rollId !== p && !window.dice.scene.isRolling, prev, { polling: 50, timeout: 20_000 });
  const last = (await game()).history[0];
  const after = await game();
  // Let the callout pop to full size.
  await shooter.page.waitForTimeout(420);
  if (last.hit && wanted.has(last.hit) && after.phase !== "matchOver") {
    wanted.delete(last.hit);
    await shot(shooter, `${last.hit}.png`);
  }
  if (after.phase === "matchOver" && !wanted.size) {
    const winner = players.find((p) => p.id === after.winnerId);
    await winner.page.waitForSelector("#match-over:not([hidden])");
    await winner.page.waitForTimeout(400);
    await shot(winner, "win.png");
    break;
  }
  // Wait for everyone so the next turn starts cleanly.
  await Promise.all(players.map((p) => p.page.waitForFunction((r) => window.dice.room.game.history[0]?.rollId === r && !window.dice.scene.isRolling, last.rollId, { polling: 100 })));
}

// A wide desktop shot for READMEs and link previews.
const wide = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await wide.addInitScript(() => localStorage.setItem("dice.name", "Sam"));
const desk = await wide.newPage();
await desk.goto(`${base}/?room=WIDE${Date.now().toString(36).toUpperCase()}&t=relay&debug`);
await desk.click("#start");
await desk.waitForSelector("#quick-roll:not([hidden])");
for (let i = 0; i < 12; i++) {
  const prev = await desk.evaluate(() => window.dice.room.game.history[0]?.rollId ?? null);
  await desk.click("#quick-roll");
  await desk.waitForFunction((p) => window.dice.room.game.history[0]?.rollId !== p && !window.dice.scene.isRolling, prev, { polling: 50 });
  const hit = await desk.evaluate(() => window.dice.room.game.history[0].hit);
  if (hit) {
    await desk.waitForTimeout(420);
    await desk.screenshot({ path: `${out}/desktop.png` });
    console.log("saved desktop.png");
    break;
  }
  await desk.waitForSelector("#quick-roll:not([hidden])");
}

console.log("missing:", [...wanted]);
await browser.close();
