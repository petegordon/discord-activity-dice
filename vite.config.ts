import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// House Tandem sign-in (@usersfirst/identity) is vendored, not installed: see
// scripts/sync-identity.mjs. The specifiers match the package's own exports.
const identity = fileURLToPath(new URL("./src/vendor/identity", import.meta.url)).replace(/\\/g, "/");

// In dev, /api (token exchange + WebSocket relay) is served by `wrangler dev` on :8787.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@usersfirst\/identity\/(client|text)$/, replacement: `${identity}/$1.js` },
      { find: /^@usersfirst\/identity\/elements\/([\w-]+)$/, replacement: `${identity}/elements/$1.js` },
    ],
  },
  server: {
    host: true,
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    // The table, and the phone-only shaker remote (SHAKER-REMOTE.md), served at /remote.
    rollupOptions: { input: { main: "index.html", remote: "remote.html" } },
  },
});
