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

/**
 * How long until something unlocks — "in 24 minutes" / "خلال 24 دقيقة".
 *
 * Intl.RelativeTimeFormat does the wording and the pluralisation in both
 * languages, so this adds no copy to lib/admin/strings.ts. Arabic asks for Latin
 * digits (`-u-nu-latn`) for the same reason formatDateTime below does: the panel
 * shows times and figures in Latin numerals throughout, and one Arabic-Indic
 * number in the middle of them reads as a glitch.
 *
 * Minutes round *up*. A desk told "in 1 minute" and finding the button still
 * locked has been told the truth about the wrong second; told "now" and finding
 * it locked, it has been lied to.
 *
 * Past two hours it switches to whole hours and rounds to the nearest, which can
 * read half an hour either side of the truth. That is fine there and would not
 * be fine in the minute range: nobody stands at the desk waiting out a two-hour
 * countdown, they come back and read it again.
 */
export function formatCountdown(ms: number, lang: "ar" | "en"): string {
  const rtf = new Intl.RelativeTimeFormat(lang === "ar" ? "ar-u-nu-latn" : "en", {
    numeric: "auto",
  });

  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 120) return rtf.format(minutes, "minute");

  // Each unit gives out where it stops being something a person acts on. Without
  // the day step a booking later in the week reads "in 73 hours", which is
  // technically true and no use to anybody.
  const hours = Math.round(minutes / 60);
  return hours < 48 ? rtf.format(hours, "hour") : rtf.format(Math.round(hours / 24), "day");
}

/**
 * How long something took — "42 minutes" / "42 دقيقة".
 *
 * Minutes all the way up rather than switching to hours: a service runs half an
 * hour to a couple of hours, and "95 minutes" is a figure the desk can compare
 * against the next one at a glance, where "1 hr 35 min" has to be decoded first.
 *
 * Like formatCountdown, Intl supplies the unit word and its plural — Arabic's
 * "5 دقائق" against "42 دقيقة" is grammar this file should not be inventing —
 * so this adds no copy either.
 */
export function formatDuration(ms: number, lang: "ar" | "en"): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return new Intl.NumberFormat(lang === "ar" ? "ar-u-nu-latn" : "en", {
    style: "unit",
    unit: "minute",
    unitDisplay: "long",
  }).format(minutes);
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
