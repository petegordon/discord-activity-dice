#!/usr/bin/env node
// ============================================================
// sync-identity.mjs — vendor House Tandem sign-in (@usersfirst/identity) from the lab
// ============================================================
//
// src/vendor/identity/ is a VENDORED copy of packages/identity/src in the
// tandemonium-controller-lab repo: the sign-in client src/platform/houseTandem.ts is
// built on, its wording, and the account elements (<uf-signin> is the one used here).
// housetandem.com and Tandemonium vendor the same package the same way.
// Files are copied byte-for-byte and stamped with the lab version and commit in
// src/vendor/identity/IDENTITY_VERSION.json. Never edit them here: change the lab,
// tag it (identity-vX.Y.Z), check the lab out at that tag, then:
//
//   npm run sync-identity       # copy + stamp
//   npm run check:identity      # fail if src/vendor/identity differs from the lab checkout
//
// Lab location: $CONTROLLER_LAB_DIR, else the sibling ../tandemonium-controller-lab.
// The whole of src/ is vendored (it is small, and index.js names every file).
// The app imports it as "@usersfirst/identity/…" (an alias in vite.config.ts); its types
// are in src/types/usersfirst-identity.d.ts.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAB = path.resolve(process.env.CONTROLLER_LAB_DIR || path.join(ROOT, "..", "tandemonium-controller-lab"));
const PKG = path.join(LAB, "packages", "identity");
const SRC = path.join(PKG, "src");
const DEST_REL = "src/vendor/identity";
const DEST = path.join(ROOT, DEST_REL);
const STAMP = "IDENTITY_VERSION.json";

const norm = (b) => b.toString("utf8").replace(/\r\n/g, "\n");
const walk = (dir, prefix = "") =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? prefix + "/" + e.name : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : e.name === STAMP ? [] : [rel];
  }).sort();

if (!fs.existsSync(SRC)) {
  console.error(`@usersfirst/identity source not found at ${SRC}. Set CONTROLLER_LAB_DIR or check out tandemonium-controller-lab next to this repo.`);
  process.exit(1);
}
const FILES = walk(SRC);

if (process.argv.includes("--check")) {
  const problems = FILES.filter((f) => {
    const dest = path.join(DEST, f);
    return !fs.existsSync(dest) || norm(fs.readFileSync(dest)) !== norm(fs.readFileSync(path.join(SRC, f)));
  }).map((f) => "differs: " + f);
  if (fs.existsSync(DEST)) for (const f of walk(DEST)) if (!FILES.includes(f)) problems.push("not in the lab: " + f);
  if (problems.length) {
    console.error(`${DEST_REL} differs from the lab:\n  ${problems.join("\n  ")}\n(run npm run sync-identity)`);
    process.exit(1);
  }
  console.log(`${DEST_REL} matches the lab checkout (${FILES.length} files)`);
  process.exit(0);
}

fs.rmSync(DEST, { recursive: true, force: true });
for (const f of FILES) {
  fs.mkdirSync(path.dirname(path.join(DEST, f)), { recursive: true });
  fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
}
const git = (cmd) => {
  try {
    return execSync(`git -C "${LAB}" ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const version = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version;
fs.writeFileSync(
  path.join(DEST, STAMP),
  JSON.stringify(
    {
      package: "@usersfirst/identity",
      version,
      sourceCommit: git("rev-parse HEAD"),
      sourceRef: git("describe --tags --always"),
      syncedAt: new Date().toISOString().slice(0, 10),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Synced @usersfirst/identity@${version} → ${DEST_REL}/ (${FILES.length} files)`);
