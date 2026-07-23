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
