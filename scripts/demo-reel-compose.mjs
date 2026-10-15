// Cuts the footage recorded by demo-reel.mjs into two 1080p reels: a wide one
// (1920×1080) and a vertical one (1080×1920) for TikTok, Reels and Shorts.
// Shots are chosen from the markers (whatever the dice did), stills are drawn
// as HTML with Playwright, and each segment is put together with ffmpeg.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

// The frame being cut; set per format by compose().
let W = 1920;
let H = 1080;
let TALL = false;
const FADE = 0.3;
const BG = "#0f1a14";
const GOLD = "#f2c14e";

// ---------- Layouts: where each screen sits on the frame ----------
// Vertical apps cover the bottom ~20% and the right edge with their own
// buttons and captions, so the tall layouts keep the action above that.
const PHONE = 780 / 1688;
const TABLE = 1920 / 1200;

function trio() {
  if (TALL) {
    const w = 316,
      h = Math.round(w / PHONE),
      gap = 26;
    const x0 = Math.round((W - (3 * w + 2 * gap)) / 2);
    return [0, 1, 2].map((i) => ({ x: x0 + i * (w + gap), y: 560, w, h, r: 26 }));
  }
  const h = 850,
    w = Math.round(h * PHONE),
    gap = 80;
  const x0 = Math.round((W - (3 * w + 2 * gap)) / 2);
  return [0, 1, 2].map((i) => ({ x: x0 + i * (w + gap), y: 196, w, h, r: 36 }));
}
const split = () => {
  if (TALL) {
    const h = 1060,
      w = Math.round(h * PHONE);
    return [{ x: Math.round((W - w) / 2), y: 500, w, h, r: 40 }];
  }
  const h = 940,
    w = Math.round(h * PHONE);
  return [{ x: 1200, y: 70, w, h, r: 40 }];
};
const remote = () => {
  if (TALL) {
    // The phone overlaps the table's empty bottom-right corner, picture-in-picture.
    const w = 960,
      h = Math.round(w / TABLE),
      ph = 560,
      pw = Math.round(ph * PHONE);
    return [
      { x: 60, y: 540, w, h, r: 14 },
      { x: W - 60 - pw, y: 540 + h - 70, w: pw, h: ph, r: 30 },
    ];
  }
  const w = 1290,
    h = Math.round(w / TABLE),
    ph = h,
    pw = Math.round(ph * PHONE);
  return [
    {
      x: 100,
      y: 214,
      w,
      h,
      r: 14,
      label: "The table: a laptop, a TV, or Discord",
    },
    { x: 100 + w + 70, y: 214, w: pw, h: ph, r: 34, label: "Your phone" },
  ];
};

// ---------- Choosing shots from what happened ----------
function plan(log) {
  const marks = log.marks;
  const find = (name, test = () => true, from = 0) =>
    marks.find((m) => m.name === name && m.t >= from && test(m));
  const before = (name, t, test = () => true) =>
    marks.filter((m) => m.name === name && m.t <= t && test(m)).at(-1);
  const names = Object.keys(log.clips).filter(
    (c) => !["table", "phone"].includes(c),
  );
  const host = names[0];
  const s = (t) => t / 1000;
  const segs = [];

  segs.push({ card: "title", dur: 3.2 });

  // The lobby filling up, on the host's phone.
  const start = find("start");
  segs.push({
    layout: split(),
    clips: [host],
    from: s(find("joined").t) - 0.4,
    to: s(start.t) - 0.6,
    caption: {
      title: "Invite friends with a link",
      sub: "Everyone plays on their own phone. Nothing to install.",
    },
  });

  // The first throw, seen on all three phones at once.
  const shake1 = find("shake"),
    flick1 = find("flick"),
    land1 = find("landed");
  const trioClips = (who) => [who, ...names.filter((n) => n !== who)];
  segs.push({
    layout: trio(),
    clips: trioClips(shake1.who),
    from: s(shake1.t) - 0.5,
    to: s(land1.t) + 1.5,
    shake: [[s(shake1.t), s(flick1.t)]],
    captions: [
      { title: "Hold the cup and shake your phone", until: s(flick1.t) + 0.2 },
      { title: "Flick to throw. Everyone sees the same roll." },
    ],
  });

  // Scoring rolls we haven't shown yet.
  const shown = new Set([land1.hit]);
  const hits = ["seven", "eleven", "doubles"]
    .filter((k) => !shown.has(k))
    .map((k) => find("landed", (m) => m.hit === k && m.t > land1.t))
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  for (const land of hits) {
    const flick = before("flick", land.t);
    const shake = before("shake", land.t);
    segs.push({
      layout: split(),
      clips: [land.who],
      from: s(flick.t) - 0.5,
      to: s(land.t) + 1.4,
      shake: [[s(shake.t), s(flick.t)]],
      caption: {
        title: "Roll 7, 11 or doubles to score",
        sub: "Score, and you roll again. First to the target wins.",
      },
    });
  }

  // The winning roll and the win screen.
  const win = find("win");
  if (win) {
    const land = before("landed", win.t);
    const shake = before("shake", land.t);
    const flick = before("flick", land.t);
    segs.push({
      layout: trio(),
      clips: trioClips(win.who),
      from: s(flick.t) - 0.3,
      to: s(win.t) + 2.6,
      shake: [[s(shake.t), s(flick.t)]],
      captions: [
        { title: "First to the target wins", until: s(win.t) - 0.4 },
        { title: `${win.who} wins!` },
      ],
    });
  }

  // The shaker remote: pair with the QR code, then throw from the phone.
  const connect = find("connect");
  if (connect) {
    const paired = find("paired");
    segs.push({
      layout: remote(),
      clips: ["table", "phone"],
      from: s(find("pair-open").t) + 0.6,
      to: s(paired.t) + 1.4,
      captions: [
        {
          title: "On a laptop or in Discord?",
          sub: "Scan the code and your phone becomes the dice cup.",
        },
      ],
    });
    const land = find("remote-landed", (m) => !!m.hit) ?? find("remote-landed");
    const shake = before("shake", land.t),
      flick = before("flick", land.t);
    segs.push({
      layout: remote(),
      clips: ["table", "phone"],
      from: s(shake.t) - 0.5,
      to: s(land.t) + 1.8,
      shake: [[s(shake.t), s(flick.t), 1]],
      captions: [
        { title: "Shake the phone. The dice roll on the big screen." },
      ],
    });
  }

  segs.push({ card: "end", dur: 4 });
  return segs;
}

// ---------- Stills ----------
const css = () => `
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #f4efe4; background: transparent; }
  .bg { position: absolute; inset: 0; background:
      radial-gradient(1200px 700px at 50% 120%, rgba(0, 122, 62, 0.45), transparent 70%),
      radial-gradient(900px 500px at 15% -10%, rgba(242, 193, 78, 0.10), transparent 70%), ${BG}; }
  .dev { position: absolute; background: #050806; box-shadow: 0 0 0 2px rgba(255,255,255,0.14), 0 30px 80px rgba(0,0,0,0.55); }
  .label { position: absolute; font-size: 22px; color: #a9b5ac; text-align: center; font-weight: 600; }
  .brand { position: absolute; right: 48px; bottom: 30px; }
  .tall .brand { right: 0; left: 0; bottom: 250px; text-align: center; }
  .brand { font-size: 22px; color: rgba(244,239,228,0.55); font-weight: 700; letter-spacing: 0.02em; }
  h1 { margin: 0; font-weight: 900; letter-spacing: -0.01em; line-height: 1.08; }
  .sub { color: #c8d1ca; font-weight: 500; }
  .gold { color: ${GOLD}; }
`;

function backgroundHtml(layout) {
  const pad = (b) => (b.r > 20 ? 14 : 10);
  const devs = layout
    .map(
      (b) =>
        `<div class="dev" style="left:${b.x - pad(b)}px;top:${b.y - pad(b)}px;width:${b.w + 2 * pad(b)}px;height:${b.h + 2 * pad(b)}px;border-radius:${b.r + pad(b)}px"></div>` +
        (b.label
          ? `<div class="label" style="left:${b.x}px;width:${b.w}px;top:${b.y + b.h + 22}px">${b.label}</div>`
          : ""),
    )
    .join("");
  // The watermark goes where no screen or label is: wide, only beside a single
  // phone; tall, below anything but the two-screen shot's overlapping phone.
  const room = TALL ? layout.length !== 2 : layout.length === 1;
  const brand = room ? `<div class="brand">dice.housetandem.com</div>` : "";
  return `<div class="bg"></div>${devs}${TALL ? `<div class="tall">${brand}</div>` : brand}`;
}

function captionHtml(c, layout) {
  if (TALL) {
    return `<div style="position:absolute;left:70px;right:70px;top:${layout === "remote" ? 150 : 170}px;height:${layout === "split" ? 300 : 360}px;display:flex;flex-direction:column;justify-content:center;text-align:center;gap:18px">
      <h1 style="font-size:${c.title.length > 34 ? 66 : 76}px">${c.title}</h1>${c.sub ? `<div class="sub" style="font-size:40px;line-height:1.25">${c.sub}</div>` : ""}</div>`;
  }
  if (layout === "split") {
    return `<div style="position:absolute;left:150px;width:930px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:26px">
      <h1 style="font-size:76px">${c.title}</h1>${c.sub ? `<div class="sub" style="font-size:38px;line-height:1.3">${c.sub}</div>` : ""}</div>`;
  }
  const top = layout === "remote" ? 34 : 44;
  return `<div style="position:absolute;left:0;right:0;top:${top}px;text-align:center">
    <h1 style="font-size:${c.sub ? 58 : 64}px">${c.title}</h1>${c.sub ? `<div class="sub" style="font-size:34px;margin-top:10px">${c.sub}</div>` : ""}</div>`;
}

const DIE = (pips) => {
  const at = {
    1: [[50, 50]],
    5: [
      [27, 27],
      [73, 27],
      [50, 50],
      [27, 73],
      [73, 73],
    ],
    6: [
      [27, 25],
      [73, 25],
      [27, 50],
      [73, 50],
      [27, 75],
      [73, 75],
    ],
  }[pips];
  return `<svg viewBox="0 0 100 100" width="150" height="150"><rect x="4" y="4" width="92" height="92" rx="20" fill="#e5484d"/>${at
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="#fff"/>`)
    .join("")}</svg>`;
};

function cardHtml(kind) {
  const big = TALL ? 0.92 : 1;
  const dice = `<div style="display:flex;gap:28px;justify-content:center;margin-bottom:36px"><div style="transform:rotate(-12deg)">${DIE(5)}</div><div style="transform:rotate(9deg)">${DIE(6)}</div></div>`;
  const body =
    kind === "title"
      ? `${dice}<h1 style="font-size:${120 * big}px">7, 11, <span class="gold">Doubles</span></h1>
         <div class="sub" style="font-size:42px;margin-top:22px;max-width:900px">Shake your phone. Throw the dice. Play with friends.</div>`
      : `<h1 style="font-size:96px">7, 11, <span class="gold">Doubles</span></h1>
         <div style="font-size:56px;font-weight:800;margin-top:34px" class="gold">dice.housetandem.com</div>
         <div class="sub" style="font-size:36px;margin-top:22px;max-width:900px">Free in your browser, or as an Activity in Discord.</div>`;
  return `<div class="bg"></div><div style="position:absolute;inset:0 0 ${TALL ? 260 : 0}px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">${body}</div>`;
}

const maskHtml = (b) =>
  `<div style="position:absolute;left:0;top:0;width:${b.w}px;height:${b.h}px;border-radius:${b.r}px;background:#fff"></div>`;

async function renderStills(dir, segs) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const snap = async (html, file, opts = {}) => {
    await page.setContent(`<!doctype html><style>${css()}</style>${html}`);
    await page.screenshot({ path: file, omitBackground: true, ...opts });
  };
  for (const [i, seg] of segs.entries()) {
    const p = `${dir}/s${i}`;
    if (seg.card) {
      await snap(cardHtml(seg.card), `${p}-bg.png`);
      continue;
    }
    await snap(backgroundHtml(seg.layout), `${p}-bg.png`);
    const kind =
      seg.layout.length === 1
        ? "split"
        : seg.layout.length === 2
          ? "remote"
          : "trio";
    const caps = seg.captions ?? [seg.caption];
    for (const [j, c] of caps.entries())
      await snap(captionHtml(c, kind), `${p}-cap${j}.png`);
    for (const [j, b] of seg.layout.entries()) {
      await page.setViewportSize({ width: b.w, height: b.h });
      await snap(maskHtml(b), `${p}-mask${j}.png`, { omitBackground: false });
      await page.setViewportSize({ width: W, height: H });
    }
  }
  await browser.close();
}

// ---------- ffmpeg ----------
const ff = (args) =>
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { stdio: "inherit" },
  );
const ENCODE = [
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
];

function renderSegment(dir, work, log, seg, i) {
  const p = `${work}/s${i}`;
  const out = `${p}.mp4`;
  if (seg.card) {
    ff([
      "-loop",
      "1",
      "-t",
      String(seg.dur),
      "-i",
      `${p}-bg.png`,
      "-vf",
      `format=yuv420p,fade=t=in:st=0:d=${FADE * 1.5},fade=t=out:st=${seg.dur - FADE * 1.5}:d=${FADE * 1.5}`,
      ...ENCODE,
      out,
    ]);
    return { out, dur: seg.dur };
  }
  const dur = +(seg.to - seg.from).toFixed(3);
  const caps = seg.captions ?? [seg.caption];
  const inputs = ["-loop", "1", "-t", String(dur), "-i", `${p}-bg.png`];
  const f = [];
  let n = 1;
  let last = "0:v";
  seg.layout.forEach((b, j) => {
    const clip = log.clips[seg.clips[j]];
    // A screen whose recording starts later holds its first frame until then.
    const late = Math.max(0, clip.t0 / 1000 + 0.15 - seg.from);
    const ss = Math.max(0, seg.from - clip.t0 / 1000);
    inputs.push(
      "-ss",
      ss.toFixed(3),
      "-t",
      String(dur - late),
      "-i",
      `${dir}/${seg.clips[j]}.mp4`,
    );
    inputs.push("-loop", "1", "-t", String(dur), "-i", `${p}-mask${j}.png`);
    const v = n++,
      m = n++;
    f.push(
      `[${v}:v]setpts=PTS-STARTPTS,${late ? `tpad=start_duration=${late.toFixed(3)}:start_mode=clone,` : ""}scale=${b.w}:${b.h}:flags=lanczos,format=rgba[v${j}]`,
    );
    f.push(`[${m}:v]format=gray[m${j}]`);
    f.push(`[v${j}][m${j}]alphamerge[a${j}]`);
    // The shooter's phone shakes on screen while they shake it.
    let x = String(b.x),
      y = String(b.y);
    for (const [s0, s1, who = 0] of seg.shake ?? []) {
      if (who !== j) continue;
      const a = (s0 - seg.from).toFixed(3),
        z = (s1 - seg.from).toFixed(3);
      x = `${x}+if(between(t,${a},${z}),16*sin(2*PI*7*t),0)`;
      y = `${y}+if(between(t,${a},${z}),6*sin(2*PI*11*t),0)-if(between(t,${z},${z}+0.18),40*sin(PI*(t-${z})/0.18),0)`;
    }
    f.push(
      `[${last}][a${j}]overlay=x='${x}':y='${y}':eval=frame:shortest=1[o${j}]`,
    );
    last = `o${j}`;
  });
  let capStart = 0;
  caps.forEach((c, j) => {
    const end = c.until ? c.until - seg.from : dur;
    inputs.push("-loop", "1", "-t", String(dur), "-i", `${p}-cap${j}.png`);
    const k = n++;
    const fades = [
      j > 0 ? `fade=t=in:st=${capStart.toFixed(3)}:d=0.25:alpha=1` : null,
      end < dur
        ? `fade=t=out:st=${(end - 0.2).toFixed(3)}:d=0.2:alpha=1`
        : null,
    ]
      .filter(Boolean)
      .join(",");
    f.push(`[${k}:v]format=rgba${fades ? "," + fades : ""}[c${j}]`);
    f.push(
      `[${last}][c${j}]overlay=0:0:enable='between(t,${capStart.toFixed(3)},${end.toFixed(3)})'[k${j}]`,
    );
    last = `k${j}`;
    capStart = end;
  });
  f.push(
    `[${last}]format=yuv420p,fade=t=in:st=0:d=${FADE},fade=t=out:st=${(dur - FADE).toFixed(3)}:d=${FADE}[out]`,
  );
  ff([
    ...inputs,
    "-filter_complex",
    f.join(";"),
    "-map",
    "[out]",
    "-t",
    String(dur),
    ...ENCODE,
    out,
  ]);
  return { out, dur };
}

const FORMATS = [
  { name: "demo-reel", w: 1920, h: 1080 },
  { name: "demo-reel-vertical", w: 1080, h: 1920 },
];

export async function compose(dir, log) {
  for (const f of FORMATS) {
    [W, H, TALL] = [f.w, f.h, f.h > f.w];
    await composeOne(dir, log, f.name);
  }
}

async function composeOne(dir, log, name) {
  const work = `${dir}/cut-${name}`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const segs = plan(log);
  await renderStills(work, segs);
  const parts = segs.map((seg, i) => renderSegment(dir, work, log, seg, i));
  writeFileSync(
    `${work}/list.txt`,
    parts.map((p) => `file '${p.out.split("/").pop()}'`).join("\n"),
  );
  ff([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    `${work}/list.txt`,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    `${dir}/${name}.mp4`,
  ]);
  const total = parts.reduce((a, p) => a + p.dur, 0);
  console.log(
    `${name}: ${dir}/${name}.mp4 (${segs.length} shots, ${total.toFixed(1)} s)`,
  );
}
