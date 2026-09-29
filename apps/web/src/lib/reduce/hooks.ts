/**
 * Hooks panel reducer (R30, D16): folds `hook` events newer than the snapshot
 * cursor onto the server's per-name aggregate. Pure — no runes, no DOM.
 */
import type { CrowEvent, HookStat, SessionDetailResponse } from "@crow/core/types";
import { applyMany, applyOne, fromSnapshot, type Cursored } from "./cursor";

export interface HooksData {
  hooks: HookStat[];
  /** Recorder horizon: `ts` of the earliest counted hook, or `null`. */
  hooksFrom: number | null;
}

export type HooksState = Cursored<HooksData>;

/** Builds the state from a REST snapshot; only ids `> snapshot.cursor` fold on top (D16). */
export function hooksFromSnapshot(snapshot: SessionDetailResponse): HooksState {
  return fromSnapshot({ hooks: snapshot.hooks, hooksFrom: snapshot.hooksFrom }, snapshot.cursor);
}

function foldHook(data: HooksData, e: CrowEvent): HooksData {
  // `revision` rows never count: hooks are never merged (N3), so the fact was counted on its own row.
  if (e.kind !== "hook" || e.hook === undefined || e.hook.aggregate === true) return data;
  const ms = e.hook.ms ?? 0;
  const blocking = e.hook.blocking === true ? 1 : 0;
  const prev = data.hooks.find((h) => h.name === e.hook?.name);
  const next: HookStat = prev
    ? {
        ...prev,
        runs: prev.runs + 1,
        totalMs: prev.totalMs + ms,
        maxMs: Math.max(prev.maxMs, ms),
        blocking: prev.blocking + blocking,
      }
    : { name: e.hook.name, runs: 1, totalMs: ms, maxMs: ms, blocking };
  return {
    hooks: prev ? data.hooks.map((h) => (h === prev ? next : h)) : [...data.hooks, next],
    hooksFrom: data.hooksFrom === null ? e.ts : Math.min(data.hooksFrom, e.ts),
  };
}

/** Applies one stream/page event; ids `<= lastApplied` are ignored (R33). */
export function applyToHooks(state: HooksState, e: CrowEvent): HooksState {
  return applyOne(state, e, foldHook);
}

/** Applies a page (or replay) in order under the same cursor rule. */
export function applyManyToHooks(state: HooksState, events: readonly CrowEvent[]): HooksState {
  return applyMany(state, events, foldHook);
}
