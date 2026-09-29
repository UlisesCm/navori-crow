import { expect, test } from "bun:test";
import type { SessionDetailResponse, SessionEventsResponse } from "@crow/core";
import { fetchSessionDetail, fetchSessionEventsBackward } from "../apps/web/src/lib/api";
import {
  baseUrl,
  getEvents,
  makeSandbox,
  promptLine,
  promptTexts,
  start,
  waitFor,
  writeTranscript,
} from "./helpers";

test("the web client's real URL builders reach a session (engine:nativeId is percent-encoded)", async () => {
  // Covers: R26, R27, R32
  const sandbox = makeSandbox();
  writeTranscript(sandbox.transcript, [promptLine("enc-1", Date.now() - 1000)]);
  const handle = await start(sandbox);
  const realFetch = globalThis.fetch;
  try {
    await waitFor(async () => promptTexts((await getEvents(handle)).events).length === 1, "ingest");
    const base = baseUrl(handle);
    // api.ts issues relative paths (same-origin in the browser); point them at the real server.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      realFetch(
        typeof input === "string" && input.startsWith("/") ? base + input : input,
        init,
      )) as typeof fetch;

    const sessions = (await (await realFetch(`${base}/api/sessions`)).json()) as {
      sessions: Array<{ id: string }>;
    };
    const id = sessions.sessions[0]?.id ?? "";
    expect(id).toContain(":");

    const detail: SessionDetailResponse = await fetchSessionDetail(id);
    expect(detail.session.id).toBe(id);
    const events: SessionEventsResponse = await fetchSessionEventsBackward(id);
    expect(events.events.length).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = realFetch;
    await handle.stop();
    sandbox.cleanup();
  }
}, 30_000);
