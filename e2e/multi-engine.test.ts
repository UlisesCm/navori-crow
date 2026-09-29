import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { CrowEvent, ProjectsResponse } from "@crow/core";
import {
  baseUrl,
  codexPromptLine,
  codexRolloutPath,
  codexSessionMetaLine,
  makeSandbox,
  promptLine,
  SseClient,
  start,
  waitFor,
  writeTranscript,
} from "./helpers";

test("two Claude repos and one Codex repo appear live as three projects with per-engine events", async () => {
  // Covers: R14, R15, R29
  const sandbox = makeSandbox();
  const repos = mkdtempSync(join(sandbox.dir, "repos-"));
  const repoPath = (name: string): string => {
    const p = join(repos, name);
    mkdirSync(p);
    return realpathSync(p);
  };
  const claudeA = repoPath("claude-a");
  const claudeB = repoPath("claude-b");
  const codexRepo = repoPath("codex-c");
  const claudeProjects = join(sandbox.config.claudeConfigDir, "projects");
  mkdirSync(join(claudeProjects, "a"), { recursive: true });
  mkdirSync(join(claudeProjects, "b"), { recursive: true });
  const now = Date.now();
  const transcriptA = join(claudeProjects, "a", "sess-a.jsonl");
  const transcriptB = join(claudeProjects, "b", "sess-b.jsonl");
  const rollout = codexRolloutPath(sandbox.config.codexHome, "thread-c", now);
  const linesA = [promptLine("seed-a", now, claudeA, "sess-a")];
  const linesB = [promptLine("seed-b", now, claudeB, "sess-b")];
  const linesC = [codexSessionMetaLine("thread-c", codexRepo, now)];
  // Files (and so every watched root) exist before start.
  writeTranscript(transcriptA, linesA);
  writeTranscript(transcriptB, linesB);
  writeTranscript(rollout, linesC);

  const handle = await start(sandbox);
  const sse = await SseClient.open(handle);
  try {
    const isPrompt = (text: string) => (e: CrowEvent) => e.kind === "prompt" && e.text === text;
    const t0 = performance.now();
    const gotA = sse.next(isPrompt("live-a"), 5000);
    const gotB = sse.next(isPrompt("live-b"), 5000);
    const gotC = sse.next(isPrompt("live-c"), 5000);
    writeTranscript(transcriptA, [...linesA, promptLine("live-a", now + 1, claudeA, "sess-a")]);
    writeTranscript(transcriptB, [...linesB, promptLine("live-b", now + 1, claudeB, "sess-b")]);
    writeTranscript(rollout, [...linesC, codexPromptLine("thread-c", "live-c", now + 1)]);
    await Promise.all([gotA, gotB, gotC]);
    // R29: one 2 s budget for the slowest of the three lanes, measured from write to SSE delivery.
    expect(performance.now() - t0).toBeLessThan(2000);

    const projects = await waitFor(async () => {
      const res = await fetch(`${baseUrl(handle)}/api/projects`);
      const body = (await res.json()) as ProjectsResponse;
      return body.projects.length === 3 ? body.projects : false;
    }, "three projects");
    // R15: keyed by cwd, so three repos are three distinct projects.
    expect(new Set(projects.map((p) => p.key)).size).toBe(3);
    expect(projects.map((p) => p.path).sort()).toEqual([claudeA, claudeB, codexRepo].sort());
    expect(projects.find((p) => p.path === codexRepo)?.engines).toEqual(["codex"]);
    for (const project of projects) expect(project.sessions).toHaveLength(1);

    // R14: each event carries its own engine.
    const byText = (text: string) => sse.received.find((e) => e.text === text);
    expect(byText("live-a")?.engine).toBe("claude");
    expect(byText("live-b")?.engine).toBe("claude");
    const codexEvent = byText("live-c");
    expect(codexEvent?.engine).toBe("codex");
    expect(codexEvent?.sessionId).toBe("thread-c");
    const keys = [byText("live-a"), byText("live-b"), codexEvent].map((e) => e?.projectKey);
    expect(new Set(keys).size).toBe(3);
  } finally {
    sse.close();
    await handle.stop();
    sandbox.cleanup();
  }
}, 30_000);
