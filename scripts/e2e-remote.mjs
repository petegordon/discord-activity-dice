// End-to-end test for the shaker remote (SHAKER-REMOTE.md).
// Usage: node scripts/e2e-remote.mjs [baseUrl] [relay|peerjs]
// Expects `npm run preview` (wrangler dev) to be serving baseUrl.
//
// 1. A remote opened before anyone is at the table must not become host.
// 2. Alice (desktop, no motion) pairs a phone; the phone throws for her with
//    synthetic DeviceMotion shakes and flicks, while Bob uses Quick roll.
// 3. "New link" on the table makes the old phone link stop working.
import { chromium } from "playwright-core";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const transport = process.argv[3] ?? "relay";
const room = `RMT${Date.now().toString(36).toUpperCase()}`;
const outDir = "scripts/out";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const watch = (page, label) => {
  page.on("pageerror", (e) => errors.push(`[${label}] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/is taken|Aborting|Could not connect to peer|ERR_|status of 4/.test(m.text()) && errors.push(`[${label}] console: ${m.text()}`));
};
const fail = (msg) => {
  throw new Error(msg);
};
const poll = { polling: 200 };

async function table(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await ctx.addInitScript((n) => localStorage.setItem("dice.name", n), name);
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(`${base}/?room=${room}&t=${transport}&nomotion&debug`);
  await page.waitForFunction(() => window.dice?.room?.players?.length > 0, null, { timeout: 30_000, ...poll });
  return page;
}

/** A phone: touch, mobile viewport, and a steady stream of DeviceMotion events we can steer. */
async function phone(url, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    // Headless Chrome has no DeviceMotionEvent; a stand-in with the same fields is enough for our reader.
    if (typeof DeviceMotionEvent === "undefined") {
      window.DeviceMotionEvent = class extends Event {
        constructor(type, init = {}) {
          super(type);
          Object.assign(this, { acceleration: null, accelerationIncludingGravity: null, rotationRate: null, interval: 16 }, init);
        }
      };
    }
    window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
    setInterval(() => {
      const m = window.__motion;
      window.dispatchEvent(
        new DeviceMotionEvent("devicemotion", {
          acceleration: { x: m.x, y: m.y, z: m.z },
          accelerationIncludingGravity: { x: m.x, y: m.y + 9.8, z: m.z },
          rotationRate: { alpha: m.rot, beta: 0, gamma: 0 },
          interval: 16,
        }),
      );
    }, 16);
  });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(url);
  await page.click("#r-connect");
  return page;
}

/** Hold the cup, shake, then flick the phone forward; the flick alone throws. */
async function shakeAndFlick(page) {
  await page.waitForSelector("#zone.mine", { timeout: 15_000 });
  const sub = await page.textContent("#zone .zone-sub");
  if (!/Shake your phone/.test(sub)) fail(`phone isn't using motion: "${sub}"`);
  const box = await page.locator("#zone").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 30; i++) {
      window.__motion = { x: i % 2 ? 16 : -16, y: i % 2 ? -6 : 6, z: 0, rot: 400 };
      await sleep(20);
    }
    window.__motion = { x: 0, y: 0, z: -32, rot: 300 };
    await sleep(64);
    window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
    await sleep(260);
  });
  // The flick, not the release, should have thrown: the cup is no longer held.
  const flicked = !(await page.$("#zone.holding"));
  await page.mouse.up();
  return flicked;
}

const selfId = (page) => page.evaluate(() => window.dice.self.id);
const game = (page) => page.evaluate(() => window.dice.room.game);

try {
  // ---- 1. A remote that shows up first never becomes host ----
  const early = await phone(`${base}/remote?room=${room}&t=${transport}&debug#k=${randomBytes(16).toString("hex")}`, "early-phone");
  await early.waitForTimeout(1500);
  const alice = await table("Alice");
  await alice.waitForFunction(() => window.dice.room.isHost, null, { timeout: 30_000, ...poll });
  await early.waitForSelector("#r-message:not([hidden])", { timeout: 15_000 });
  console.log("unpaired remote first: table is host, remote says:", await early.textContent("#r-msg-title"));
  await early.context().close();

  // ---- 2. Bob (not the host) pairs a phone from the lobby and plays with it ----
  const bob = await table("Bob");
  await alice.waitForFunction(() => window.dice.room.players.length === 2, null, { timeout: 30_000, ...poll });
  await bob.click("#lobby-phone");
  await bob.waitForSelector("#pair:not([hidden]) #pair-qr svg", { timeout: 5_000 });
  const link = (await bob.textContent("#pair-link")).trim();
  if (!link.includes("/remote?") || !link.includes("#k=")) fail(`bad link ${link}`);
  await bob.screenshot({ path: `${outDir}/remote-${transport}-pair.png` });

  const remote = await phone(link, "phone");
  const bobId = await selfId(bob);
  const remoteOnline = (page, want) =>
    page.waitForFunction(([id, w]) => window.dice.room.players.find((p) => p.id === id)?.remoteOnline === w, [bobId, want], { timeout: 30_000, ...poll });
  await remoteOnline(bob, true);
  await remoteOnline(alice, true); // everyone sees the 📱 badge
  await bob.waitForSelector("#pair", { state: "hidden", timeout: 5_000 });
  if (remote.url().includes("#")) fail("remote kept the key in the address bar");

  await alice.selectOption("#target", "21");
  await alice.click("#start");

  /** Play until the phone has thrown `target` more times; others use Quick roll. */
  let phoneThrows = 0;
  async function play(tables, target) {
    for (let i = 0; i < 80 && phoneThrows < target; i++) {
      const g = await game(bob);
      const prev = g.history[0]?.rollId ?? null;
      const bobTurn = g.shooterId === bobId;
      if (bobTurn) {
        await bob.waitForFunction(() => document.querySelector("#zone .zone-title")?.textContent === "SHAKE YOUR PHONE", null, { timeout: 15_000, ...poll });
        if (!(await bob.isHidden("#use-phone"))) fail("table still offers to pair while the phone is online");
        if (phoneThrows === 0) await bob.screenshot({ path: `${outDir}/remote-${transport}-table-turn.png` });
        if (!(await shakeAndFlick(remote))) fail("the flick didn't throw");
        await remote.waitForFunction(() => document.querySelector("#zone .zone-title")?.textContent === "Rolling…", null, { timeout: 5_000, ...poll });
      } else {
        const shooter = tables.find((t) => t.id === g.shooterId);
        await shooter.page.waitForSelector("#quick-roll:not([hidden])", { timeout: 15_000 });
        await shooter.page.click("#quick-roll");
      }
      await Promise.all(
        tables.map((t) => t.page.waitForFunction((pr) => window.dice.room.game.history[0]?.rollId !== pr && !window.dice.scene.isRolling, prev, { timeout: 20_000, ...poll })),
      );
      if (bobTurn) {
        const last = (await game(bob)).history[0];
        if (last.shooter !== bobId) fail("phone throw was credited to someone else");
        await remote.waitForSelector("#r-callout.show", { timeout: 6_000 });
        const callout = await remote.textContent("#r-callout .callout-main");
        console.log(`phone throw ${++phoneThrows}: ${last.faces.join("+")} -> phone shows "${callout}"`);
        if (phoneThrows === 1) await remote.screenshot({ path: `${outDir}/remote-${transport}-phone.png` });
      }
    }
    if (phoneThrows < target) fail(`only ${phoneThrows} phone throws`);
  }
  const both = [
    { id: await selfId(alice), page: alice },
    { id: bobId, page: bob },
  ];
  await play(both, 2);
  const [ga, gb] = await Promise.all([game(alice), game(bob)]);
  if (JSON.stringify(ga.scores) !== JSON.stringify(gb.scores)) fail("tables disagree on scores");

  // ---- 3. The host leaves; Bob takes over and his phone keeps working ----
  await alice.context().close();
  await bob.waitForFunction(() => window.dice.room.isHost && window.dice.room.players.length === 1, null, { timeout: 60_000, ...poll });
  await remoteOnline(bob, true);
  console.log("host left: Bob is host, phone still paired");
  await play([{ id: bobId, page: bob }], 3);

  // ---- 4. New link revokes the old one ----
  await bob.click("#remote-btn");
  await bob.click("#pair-new");
  await remote.waitForSelector("#r-message:not([hidden])", { timeout: 10_000 });
  console.log("after New link, old phone says:", await remote.textContent("#r-msg-title"));
  await remoteOnline(bob, false);

  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(errors.length ? 1 : 0);
} catch (e) {
  console.log("FAILED:", e.message.split("\n")[0], "at line", (e.stack.match(/e2e-remote\.mjs:(\d+)/) ?? [])[1]);
  console.log("errors:", errors);
  await browser.close();
  process.exit(2);
}
