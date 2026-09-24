import type { CrowEvent } from "./crow-event";

/** A subscriber's callback, invoked once per `publish` call with the whole batch, in order. */
export type BusListener = (events: readonly CrowEvent[]) => void;

/**
 * In-memory pub/sub for stored events (D13, R22).
 *
 * `publish` is synchronous and must only be called **after** the storing
 * transaction commits — publishing before commit could hand a subscriber
 * (SSE, B5) an event a crash later rolls back, which `EventBus` itself has no
 * way to detect or undo.
 */
export class EventBus {
  private readonly listeners = new Set<BusListener>();

  /** Registers `listener`; returns a function that unsubscribes it. */
  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Synchronously notifies every current subscriber with `events`, in order. */
  publish(events: readonly CrowEvent[]): void {
    if (events.length === 0) return;
    for (const listener of this.listeners) listener(events);
  }
}
