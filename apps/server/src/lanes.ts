/**
 * In-memory per-engine lane counters (design.md D15), served as `/api/stats.lanes`. Only the hook
 * lane is counted here; the OTLP lane's status is read from `otlp` (its own counters live in the
 * receiver). Counters reset with the process (`since`).
 */
import type {
  ClockFn,
  EngineId,
  LaneCounters,
  LaneRejection,
  LanesStatus,
  OtlpLaneStatus,
} from "@crow/core";
import { laneStatus } from "./otlp-server";

function emptyCounters(): LaneCounters {
  return { lastReceivedAt: null, lastStoredAt: null, received: 0, rejected: {} };
}

export class LaneMonitor {
  private readonly since: number;
  private readonly hook = new Map<EngineId, LaneCounters>();

  /**
   * Tracks exactly `engines`: deliveries naming any other engine are ignored (bounded keys).
   * `otlp` supplies the OTLP lane's status at snapshot time; default `disabled`.
   */
  constructor(
    engines: readonly EngineId[],
    private readonly now: ClockFn,
    private readonly otlp: () => OtlpLaneStatus = () => laneStatus("disabled", null),
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
    return { since: this.since, engines, otlp: this.otlp() };
  }
}
