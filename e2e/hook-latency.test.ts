import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baseUrl, makeSandbox, SseClient, start } from "./helpers";

const CAPTURE = join(import.meta.dir, "../fixtures/claude/hooks/UserPromptSubmit.json");

test("a Claude hook posted to /ingest/hook/claude reaches /api/stream in under 1000 ms", async () => {
  // Covers: R31
  const sandbox = makeSandbox();
  const handle = await start(sandbox);
  const sse = await SseClient.open(handle);
  try {
    const base = JSON.parse(readFileSync(CAPTURE, "utf8")) as Record<string, unknown>;
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const marker = `hook-${i}`;
      const arrived = sse.next((e) => e.kind === "prompt" && e.text === marker, 5000);
      const t0 = performance.now();
      const res = await fetch(`${baseUrl(handle)}/ingest/hook/claude`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, prompt: marker, prompt_id: `p${i}` }),
      });
      expect(res.status).toBe(204);
      await arrived;
      latencies.push(performance.now() - t0);
    }
    const arrived = sse.received.filter((e) => e.source === "hook");
    expect(arrived.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...latencies)).toBeLessThan(1000);
  } finally {
    sse.close();
    await handle.stop();
    sandbox.cleanup();
  }
}, 30_000);
