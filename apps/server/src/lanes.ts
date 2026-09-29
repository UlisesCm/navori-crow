/**
 * In-memory per-engine lane counters (design.md D15), served as `/api/stats.lanes`. Only the hook
 * lane exists so far; B4.T2 adds the OTLP lane. Counters reset with the process (`since`).
 */
import type { ClockFn, EngineId, LaneCounters, LaneRejection, LanesStatus } from "@crow/core";

function emptyCounters(): LaneCounters {
  return { lastReceivedAt: null, lastStoredAt: null, received: 0, rejected: {} };
}

export class LaneMonitor {
  private readonly since: number;
  private readonly hook = new Map<EngineId, LaneCounters>();

  /** Tracks exactly `engines`: deliveries naming any other engine are ignored (bounded keys). */
  constructor(
    engines: readonly EngineId[],
    private readonly now: ClockFn,
  ) {
    this.since = now();
    for (const engine of engines) this.hook.set(engine, emptyCounters());
  }

  /** A hook delivery that passed auth, engine and size checks (queued or discarded). */
  hookReceived(engine: EngineId): void {
    const counters = this.hook.get(engine);
    if (counters === undefined) return;
    counters.received += 1;
    counters.lastReceivedAt = this.now();
  }

  /** A hook delivery refused or discarded for `reason`. */
  hookRejected(engine: EngineId, reason: LaneRejection): void {
    const counters = this.hook.get(engine);
    if (counters === undefined) return;
    counters.rejected[reason] = (counters.rejected[reason] ?? 0) + 1;
  }

  /** A hook-lane event of `engine` was committed to the store. */
  hookStored(engine: EngineId): void {
    const counters = this.hook.get(engine);
    if (counters !== undefined) counters.lastStoredAt = this.now();
  }

  snapshot(): LanesStatus {
    const engines: LanesStatus["engines"] = {};
    for (const [engine, counters] of this.hook) {
      engines[engine] = { hook: { ...counters, rejected: { ...counters.rejected } } };
    }
    return { since: this.since, engines };
  }
}
