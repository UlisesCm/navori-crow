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
    proxy: {
      "/healthz": `http://127.0.0.1:${serverPort}`,
      "/api": `http://127.0.0.1:${serverPort}`,
    },
  },
});
