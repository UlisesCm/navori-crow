/** Shared display formatters (es-MX). */
export const nf = new Intl.NumberFormat("es-MX");
export const usd = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD" });
const time = new Intl.DateTimeFormat("es-MX", { timeStyle: "medium" });

/** `HH:MM:SS` in local time. */
export const formatTime = (ts: number): string => time.format(new Date(ts));

/** Compact duration: `850 ms`, `12 s`, `3 min 5 s`, `1 h 2 min`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
