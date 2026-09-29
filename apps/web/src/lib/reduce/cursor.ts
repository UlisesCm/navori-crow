/**
 * The single cursor rule of the UI (D16, R33): an event id (ULID, so
 * lexicographic order = ingestion order) is applied only if it is strictly
 * greater than the last one applied. Backfilled data and the stream can then
 * overlap without double counting. Pure and framework-free.
 */

/** A reducer state plus the id of the last event folded into it. */
export interface Cursored<T> {
  /** `null` until a snapshot or event has been applied. */
  lastApplied: string | null;
  value: T;
}

/** Builds the state for a fresh snapshot taken at `cursor`. */
export function fromSnapshot<T>(value: T, cursor: string | null): Cursored<T> {
  return { lastApplied: cursor, value };
}

/** `true` when `id` is newer than everything already applied. */
export function isNew(lastApplied: string | null, id: string): boolean {
  return lastApplied === null || id > lastApplied;
}

/**
 * Applies one item through `step` unless its id is `<= lastApplied`.
 * Returns the same object when the item is ignored.
 */
export function applyOne<T, E extends { id: string }>(
  state: Cursored<T>,
  item: E,
  step: (value: T, item: E) => T,
): Cursored<T> {
  if (!isNew(state.lastApplied, item.id)) return state;
  return { lastApplied: item.id, value: step(state.value, item) };
}

/** Applies items in order (a REST page or a replay batch), each through the cursor rule. */
export function applyMany<T, E extends { id: string }>(
  state: Cursored<T>,
  items: readonly E[],
  step: (value: T, item: E) => T,
): Cursored<T> {
  let next = state;
  for (const item of items) next = applyOne(next, item, step);
  return next;
}
