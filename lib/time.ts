// Time helpers. The salon operates in one timezone and Saudi Arabia has no DST,
// so a fixed UTC+3 offset is exact — no tz database needed for day boundaries.

export const TIMEZONE = "Asia/Riyadh";
export const UTC_OFFSET_HOURS = 3;

const HOUR_MS = 60 * 60 * 1000;

/** Start (inclusive) and end (exclusive) of the local day containing `now`. */
export function riyadhDayRange(now: Date = new Date()): { start: Date; end: Date } {
  const local = new Date(now.getTime() + UTC_OFFSET_HOURS * HOUR_MS);
  const startUtcMs =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    UTC_OFFSET_HOURS * HOUR_MS;
  return { start: new Date(startUtcMs), end: new Date(startUtcMs + 24 * HOUR_MS) };
}

/** `YYYY-MM-DD` in Riyadh — the shape date-only columns store. */
export function riyadhDateKey(day: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(day);
}

/**
 * The Riyadh days a closure covers, both ends inclusive — what the admin typed.
 *
 * The inverse of how `addClosure` stores one: local midnight, to local midnight
 * on the day *after* the last closed day. Reversing that by hand invites two
 * separate mistakes, and the codebase had made both. Truncating a `+03:00`
 * timestamp in UTC lands a day early, because 20 March 00:00 Riyadh is 19 March
 * 21:00 UTC; printing `endsAt` as given lands a day late, because it is
 * exclusive. On the end they happen to cancel, which is worse than either —
 * it leaves a wrong line looking right.
 *
 * So it lives here once, and everything that shows a closure reads it.
 */
export function closureDays(startsAt: Date, endsAt: Date): { from: string; to: string } {
  return {
    from: riyadhDateKey(startsAt),
    to: riyadhDateKey(new Date(endsAt.getTime() - 24 * HOUR_MS)),
  };
}

/** Riyadh wall clock, HH:MM, from an ISO string. */
export function localTime(iso: string): string {
  return new Date(new Date(iso).getTime() + UTC_OFFSET_HOURS * HOUR_MS)
    .toISOString()
    .slice(11, 16);
}

/** Weekday index with Saturday = 0, matching the site's calendar and branch_hours. */
export function riyadhWeekday(date: Date): number {
  const local = new Date(date.getTime() + UTC_OFFSET_HOURS * HOUR_MS);
  return (local.getUTCDay() + 1) % 7;
}

export function formatDateTime(date: Date, lang: "ar" | "en"): string {
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: TIMEZONE,
  }).format(date);
}
