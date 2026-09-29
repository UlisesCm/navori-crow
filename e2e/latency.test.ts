import { expect, test } from "bun:test";
import {
  appendTranscript,
  makeSandbox,
  promptLine,
  SseClient,
  start,
  writeTranscript,
} from "./helpers";

test("the max latency over 5 appends, from append to /api/stream delivery, is under 2000 ms", async () => {
  // Covers: R29
  const sandbox = makeSandbox();
  writeTranscript(sandbox.transcript, [promptLine("seed", Date.now())]);
  const handle = await start(sandbox);
  const sse = await SseClient.open(handle);
  try {
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const marker = `append-${i}`;
      const arrived = sse.next((e) => e.kind === "prompt" && e.text === marker, 5000);
      const t0 = performance.now();
      appendTranscript(sandbox.transcript, promptLine(marker, Date.now()));
      await arrived;
      latencies.push(performance.now() - t0);
    }
    expect(Math.max(...latencies)).toBeLessThan(2000);
  } finally {
    sse.close();
    await handle.stop();
    sandbox.cleanup();
  }
}, 30_000);
