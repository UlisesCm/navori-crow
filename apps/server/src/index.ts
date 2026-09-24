import { homedir } from "node:os";
import { loadConfig } from "@crow/core";
import { startApp } from "./app";
import { ENGINE_ADAPTERS } from "./adapters";

const config = loadConfig(process.env, homedir());
const handle = await startApp(config);

// Paths and counts only (D15): never log event content or env values.
console.log(`crow server listening on http://${handle.server.hostname}:${handle.server.port}`);
console.log(`crow home: ${config.crowHome}`);
console.log(`engine adapters: ${ENGINE_ADAPTERS.length}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await handle.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
