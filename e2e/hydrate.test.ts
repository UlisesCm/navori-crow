import { expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import type { ProjectsResponse } from "@crow/core";
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

test("a session that existed before startup is hydrated from its transcript and listed as idle", async () => {
  // Covers: R16
  const sandbox = makeSandbox();
  const t = Date.now() - 60 * 60_000; // an hour old: inside the 24 h window, past the 5 min idle cutoff
  writeTranscript(sandbox.transcript, [promptLine("old-1", t), promptLine("old-2", t + 1000)]);
  const handle = await start(sandbox);
  try {
    const res = await waitFor(async () => {
      const r = await getEvents(handle);
      return promptTexts(r.events).length === 2 && r;
    }, "backfill");
    expect(promptTexts(res.events)).toEqual(["old-1", "old-2"]);

    const projects = (await (
      await fetch(`${baseUrl(handle)}/api/projects`)
    ).json()) as ProjectsResponse;
    const sessions = projects.projects.flatMap((p) => p.sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("idle");
    expect(sessions[0]?.lastPrompt).toBe("old-2");
  } finally {
    await handle.stop();
    sandbox.cleanup();
  }
}, 30_000);

test("a transcript outside the backfill window is not hydrated", async () => {
  // Covers: R16
  const sandbox = makeSandbox();
  const old = Date.now() - 48 * 60 * 60_000;
  writeTranscript(sandbox.transcript, [promptLine("ancient", old)]);
  utimesSync(sandbox.transcript, new Date(old), new Date(old));
  const handle = await start(sandbox);
  try {
    await Bun.sleep(1500);
    expect(promptTexts((await getEvents(handle)).events)).toEqual([]);
  } finally {
    await handle.stop();
    sandbox.cleanup();
  }
}, 30_000);
