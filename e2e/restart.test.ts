import { expect, test } from "bun:test";
import {
  appendTranscript,
  getEvents,
  makeSandbox,
  promptLine,
  promptTexts,
  start,
  waitFor,
  writeTranscript,
} from "./helpers";

test("restarting over the same CROW_HOME duplicates nothing and resumes from the stored cursor", async () => {
  // Covers: R6, R16
  const sandbox = makeSandbox();
  const t = Date.now();
  writeTranscript(sandbox.transcript, [promptLine("one", t), promptLine("two", t + 1)]);

  const first = await start(sandbox);
  let before;
  try {
    before = await waitFor(async () => {
      const r = await getEvents(first);
      return promptTexts(r.events).length === 2 && r;
    }, "initial ingest");
  } finally {
    await first.stop();
  }

  // Restart 1: transcript unchanged.
  const second = await start(sandbox);
  try {
    // Let the startup backfill and a poll tick run before asserting "nothing new".
    await Bun.sleep(1500);
    const after = await getEvents(second);
    expect(after.events.map((e) => e.id).sort()).toEqual(before.events.map((e) => e.id).sort());
    expect(after.cursor).toBe(before.cursor);

    // Appending resumes from the persisted offset: exactly one new event, id above the old cursor.
    appendTranscript(sandbox.transcript, promptLine("three", t + 2));
    const grown = await waitFor(async () => {
      const r = await getEvents(second);
      return promptTexts(r.events).length === 3 && r;
    }, "appended event");
    expect(promptTexts(grown.events)).toEqual(["one", "two", "three"]);
    expect(grown.cursor > before.cursor).toBe(true);
    const oldIds = new Set(before.events.map((e) => e.id));
    const fresh = grown.events.filter((e) => !oldIds.has(e.id));
    expect(fresh).toHaveLength(1);
    expect(fresh.every((e) => e.id > before.cursor)).toBe(true);
  } finally {
    await second.stop();
    sandbox.cleanup();
  }
}, 30_000);
