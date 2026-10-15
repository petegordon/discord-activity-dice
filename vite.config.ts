import { defineConfig } from "vite";

// In dev, /api (token exchange + WebSocket relay) is served by `wrangler dev` on :8787.
export default defineConfig({
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
