// Records a demo reel by playing real games (no rigged dice), like
// screenshots.mjs, then cuts the footage into a 1080p video with ffmpeg.
// Usage: node scripts/demo-reel.mjs [baseUrl] [--compose]
//   --compose  skip recording and re-cut the last recording (scripts/out/reel/)
// Output: scripts/out/reel/demo-reel.mp4 (1920×1080) and demo-reel-vertical.mp4
// (1080×1920, for TikTok, Reels and Shorts). Needs ffmpeg on PATH.
//
// Each player's screen is captured with the DevTools screencast and piped to
// ffmpeg at a steady 30 fps, so video time = wall time since the first frame.
// The script logs what happened when (markers.json) and the cut is built from that.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { compose } from "./demo-reel-compose.mjs";

const args = process.argv.slice(2);
const base =
  args.find((a) => !a.startsWith("--")) ?? "https://dice.housetandem.com";
const dir = "scripts/out/reel";
const FPS = 30;

if (args.includes("--compose")) {
  await compose(dir, JSON.parse(readFileSync(`${dir}/markers.json`, "utf8")));
  process.exit(0);
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// A real GPU makes for smooth footage; headless Chrome uses it when asked.
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-angle=d3d11",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const log = { fps: FPS, clips: {}, marks: [] };
const mark = (name, extra = {}) => {
  log.marks.push({ name, t: Date.now(), ...extra });
  console.log(name, JSON.stringify(extra));
};

/** Screencast a page into `${name}.mp4` at a constant frame rate, repeating the last frame while nothing changes. */
async function record(page, name, size) {
  const cdp = await page.context().newCDPSession(page);
  const ff = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-framerate",
      String(FPS),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "14",
      "-pix_fmt",
      "yuv420p",
      `${dir}/${name}.mp4`,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  let latest = null;
  let t0 = null;
  let written = 0;
  cdp.on("Page.screencastFrame", (f) => {
    latest = Buffer.from(f.data, "base64");
    t0 ??= Date.now();
    cdp
      .send("Page.screencastFrameAck", { sessionId: f.sessionId })
      .catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: size.w,
    maxHeight: size.h,
  });
  const pump = setInterval(() => {
    if (!latest) return;
    const due = Math.floor(((Date.now() - t0) / 1000) * FPS) + 1;
    for (; written < due; written++) ff.stdin.write(latest);
  }, 5);
  return async () => {
    clearInterval(pump);
    await cdp.send("Page.stopScreencast").catch(() => {});
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
    log.clips[name] = { t0, frames: written, ...size };
  };
}

/** A phone: touch, a visible fingertip, and DeviceMotion events we can steer (headless Chrome has no sensors). */
async function phone(name, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript((n) => {
    if (n) localStorage.setItem("dice.name", n);
    // Always our own: with the GPU on, headless Chrome has a native one that the page treats as a sensorless desktop.
    window.DeviceMotionEvent = class extends Event {
      constructor(type, init = {}) {
        super(type);
        Object.assign(
          this,
          {
            acceleration: null,
            accelerationIncludingGravity: null,
            rotationRate: null,
            interval: 16,
          },
          init,
        );
      }
    };
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
    // A fingertip, like Android's "show taps", so the hold reads on video.
    addEventListener("DOMContentLoaded", () => {
      const dot = document.createElement("div");
      dot.style.cssText =
        "position:fixed;left:0;top:0;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;pointer-events:none;z-index:99999;" +
        "background:radial-gradient(circle,rgba(255,255,255,.55),rgba(255,255,255,.18) 60%,transparent 70%);border:2px solid rgba(255,255,255,.7);display:none";
      document.body.append(dot);
      const at = (e) =>
        Object.assign(dot.style, {
          left: `${e.clientX}px`,
          top: `${e.clientY}px`,
        });
      addEventListener(
        "pointerdown",
        (e) => (at(e), (dot.style.display = "block")),
        true,
      );
      addEventListener("pointermove", at, true);
      for (const t of ["pointerup", "pointercancel"])
        addEventListener(t, () => (dot.style.display = "none"), true);
    });
  }, name);
  return ctx.newPage();
}

/** Hold the cup, shake the phone for a moment, then flick it forward to throw. */
async function shakeAndFlick(page, who) {
  await page.bringToFront();
  const box = await page.locator("#zone").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  mark("shake", { who });
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60; i++) {
      window.__motion = {
        x: i % 2 ? 16 : -16,
        y: i % 2 ? -6 : 6,
        z: 0,
        rot: 400,
      };
      await sleep(22);
    }
    window.__motion = { x: 0, y: 0, z: -32, rot: 300 };
    await sleep(64);
    window.__motion = { x: 0, y: 0, z: 0, rot: 0 };
  });
  mark("flick", { who });
  await page.waitForTimeout(260);
  await page.mouse.up();
}

const poll = { polling: 50 };
const game = (page) => page.evaluate(() => window.dice.room.game);

// ---------- Part 1: three friends on their phones ----------
{
  const room = `REEL${Date.now().toString(36).toUpperCase()}`;
  const names = ["Sam", "Riley", "Jordan"];
  const players = [];
  const stops = [];
  for (const name of names) {
    const page = await phone(name);
    await page.goto(`${base}/?room=${room}&t=relay&debug`);
    await page.waitForFunction(
      () => window.dice?.room?.players?.length > 0,
      null,
      { polling: 200, timeout: 30_000 },
    );
    await page.waitForTimeout(400);
    stops.push(await record(page, name, { w: 780, h: 1688 }));
    if (players.length === 0) await page.waitForTimeout(1500);
    mark("joined", { who: name });
    players.push({
      name,
      page,
      id: await page.evaluate(() => window.dice.self.id),
    });
    await page.waitForTimeout(1200);
  }
  await Promise.all(
    players.map((p) =>
      p.page.waitForFunction(
        (n) => window.dice.room.players.length === n,
        names.length,
        { polling: 200 },
      ),
    ),
  );
  const host = players[0].page;
  await host.waitForTimeout(800);
  await host.selectOption("#target", "5");
  await host.waitForTimeout(500);
  mark("start");
  await host.click("#start");

  const wanted = new Set(["seven", "eleven", "doubles"]);
  for (let roll = 0; roll < 80; roll++) {
    await host.waitForFunction(
      () =>
        ["awaitingThrow", "matchOver"].includes(window.dice.room.game.phase),
      null,
      { timeout: 20_000, ...poll },
    );
    let g = await game(host);
    if (g.phase === "matchOver") {
      const winner = players.find((p) => p.id === g.winnerId);
      await winner.page.waitForSelector("#match-over:not([hidden])");
      mark("win", { who: winner.name });
      await host.waitForTimeout(3500);
      if (!wanted.size) break;
      mark("rematch");
      await host.click("#rematch");
      await host.click("#start");
      continue;
    }
    const shooter = players.find((p) => p.id === g.shooterId);
    await shooter.page.waitForSelector("#zone.mine", { timeout: 15_000 });
    await shooter.page.waitForTimeout(500);
    const prev = g.history[0]?.rollId ?? null;
    await shakeAndFlick(shooter.page, shooter.name);
    await Promise.all(
      players.map((p) =>
        p.page.waitForFunction(
          (pr) =>
            (window.dice.room.game.history[0]?.rollId ?? null) !== pr &&
            !window.dice.scene.isRolling,
          prev,
          { timeout: 20_000, ...poll },
        ),
      ),
    ).catch(async (e) => {
      for (const p of players)
        console.log(
          p.name,
          await p.page.evaluate(() => ({
            hist: window.dice.room.game.history.length,
            rolling: window.dice.scene.isRolling,
            title: document.querySelector("#zone .zone-title").textContent,
            vis: document.visibilityState,
          })),
        );
      throw e;
    });
    const last = (await game(host)).history[0];
    mark("landed", {
      who: shooter.name,
      hit: last.hit ?? null,
      faces: last.faces,
    });
    if (last.hit) wanted.delete(last.hit);
    await host.waitForTimeout(1200);
  }
  for (const stop of stops) await stop();
  await Promise.all(players.map((p) => p.page.context().close()));
}

// ---------- Part 2: a laptop table with the phone as the dice cup ----------
{
  const room = `REELR${Date.now().toString(36).toUpperCase()}`;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1.5,
  });
  await ctx.addInitScript(() => localStorage.setItem("dice.name", "Alex"));
  const table = await ctx.newPage();
  await table.goto(`${base}/?room=${room}&t=relay&nomotion&debug`);
  await table.waitForFunction(() => window.dice?.room?.isHost, null, {
    polling: 200,
    timeout: 30_000,
  });
  await table.waitForTimeout(400);
  const stopTable = await record(table, "table", { w: 1920, h: 1200 });
  await table.waitForTimeout(1500);
  mark("pair-open");
  await table.click("#lobby-phone");
  await table.waitForSelector("#pair:not([hidden]) #pair-qr svg");
  const link = (await table.textContent("#pair-link")).trim();
  await table.waitForTimeout(2500);

  const remote = await phone(null);
  await remote.goto(link.replace("https://dice.housetandem.com", base));
  await remote.waitForSelector("#r-connect");
  const stopPhone = await record(remote, "phone", { w: 780, h: 1688 });
  await remote.waitForTimeout(1200);
  mark("connect");
  await remote.click("#r-connect");
  const alexId = await table.evaluate(() => window.dice.self.id);
  await table.waitForFunction(
    (id) => window.dice.room.players.find((p) => p.id === id)?.remoteOnline,
    alexId,
    { polling: 100, timeout: 30_000 },
  );
  mark("paired");
  await table.waitForSelector("#pair", { state: "hidden" });
  await table.waitForTimeout(1200);
  await table.selectOption("#target", "5");
  mark("remote-start");
  await table.click("#start");

  for (let i = 0; i < 4; i++) {
    await table.waitForFunction(
      () =>
        document.querySelector("#zone .zone-title")?.textContent ===
        "SHAKE YOUR PHONE",
      null,
      { timeout: 20_000, ...poll },
    );
    await remote.waitForSelector("#zone.mine", { timeout: 15_000 });
    await remote.waitForTimeout(700);
    const prev = (await game(table)).history[0]?.rollId ?? null;
    await shakeAndFlick(remote, "Alex");
    await table.waitForFunction(
      (pr) =>
        (window.dice.room.game.history[0]?.rollId ?? null) !== pr &&
        !window.dice.scene.isRolling,
      prev,
      { timeout: 20_000, ...poll },
    );
    const last = (await game(table)).history[0];
    mark("remote-landed", { hit: last.hit ?? null, faces: last.faces });
    await table.waitForTimeout(1800);
    if ((await game(table)).phase === "matchOver") break;
  }
  await stopTable();
  await stopPhone();
  await ctx.close();
  await remote.context().close();
}

await browser.close();
writeFileSync(`${dir}/markers.json`, JSON.stringify(log, null, 2));
console.log("recorded", Object.keys(log.clips).join(", "));
await compose(dir, log);
