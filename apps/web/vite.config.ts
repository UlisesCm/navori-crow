import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const serverPort = process.env["CROW_PORT"] ?? "7777";

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
  server: {
    // Fixed dev port (D14): the server's CROW_ALLOWED_ORIGINS only trusts
    // this one origin, so a silently-bumped port would fail the guard.
    port: 5173,
    strictPort: true,
    proxy: {
      "/healthz": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
      "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
    },
  },
});
