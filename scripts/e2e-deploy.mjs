// Checks that a page caught mid-deploy recovers (public/boot-guard.js).
// Usage: node scripts/e2e-deploy.mjs [baseUrl]
//
// Fakes the deploy window by answering the game's script with the HTML page,
// the way a not-yet-propagated asset can look. The first two loads fail, the
// third works: the page should show a notice, reload itself and boot. Then,
// with every load failing, it should stop after three reloads and offer a button.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  ok &&= cond;
};

async function run(path, failLoads) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript(() => localStorage.setItem("dice.name", "Tester"));
  const page = await ctx.newPage();
  let scriptLoads = 0;
  await page.route(/\/assets\/(main|remote)-[^/]+\.js$/, async (route) => {
    scriptLoads++;
    if (scriptLoads <= failLoads) {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>not yet</title>" });
    } else {
      await route.continue();
    }
  });
  await page.goto(`${base}${path}`);
  return { page, ctx, loads: () => scriptLoads };
}

// Table page: two failed loads, then it works.
{
  const { page, ctx, loads } = await run("/?room=GUARD1&t=relay&debug", 2);
  await page.waitForSelector("#boot-guard", { timeout: 5_000 });
  check((await page.textContent("#boot-guard")).includes("Loading the latest version"), "table shows a notice while recovering");
  await page.waitForFunction(() => window.dice?.room, null, { timeout: 20_000, polling: 200 });
  check(loads() === 3, `table booted after ${loads() - 1} automatic reloads`);
  check((await page.evaluate(() => sessionStorage.getItem("dice.reloads"))) === null, "retry count cleared once running");
  await ctx.close();
}

// Phone remote page: one failed load, then it works.
{
  const { page, ctx, loads } = await run("/remote?room=GUARD1&t=relay", 1);
  await page.waitForSelector("#r-message:not([hidden])", { timeout: 20_000 }); // no key in this link: "Scan the code"
  check(loads() === 2, "remote page recovered after 1 reload");
  await ctx.close();
}

// Never works: stops reloading and offers a button.
{
  const { page, ctx, loads } = await run("/?room=GUARD2&t=relay", 99);
  await page.waitForFunction(() => document.querySelector("#boot-guard button"), null, { timeout: 20_000, polling: 200 });
  const settled = loads();
  await page.waitForTimeout(2500);
  check(loads() === settled && settled === 4, `gave up after ${settled - 1} reloads and shows Reload`);
  await ctx.close();
}

// Missing files are a 404, not the game page.
{
  const res = await fetch(`${base}/assets/does-not-exist.js`);
  check(res.status === 404, `a missing asset returns ${res.status}`);
}

await browser.close();
process.exit(ok ? 0 : 1);
