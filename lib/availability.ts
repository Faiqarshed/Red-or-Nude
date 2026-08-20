// Availability engine — docs/ADMIN-PANEL.md §5.
//
//   slotsFor(branch, date) =
//        branch_hours[weekday]  −  closures  ×  active stations
//      − bookings already occupying those stations
//      → slots of settings.slot_length_min, filtered to now + lead time
//
// Both the public booking API and the admin calendar call this, so the two can
// never disagree about what is bookable. It replaces the fixed June-2026
// calendar and hardcoded TIME_SLOTS that lib/booking.ts used to export.
//
// All stored timestamps are UTC. Branch hours are local wall-clock times; Saudi
// Arabia has no DST, so the conversion is a fixed +3 offset (see lib/time.ts).

import "server-only";
import { and, asc, eq, gt, gte, lt, ne, or, isNull } from "drizzle-orm";
import { db, type Tx } from "@/lib/db";
import { bookings, branchHours, closures, stations } from "@/lib/db/schema";
import { UTC_OFFSET_HOURS, riyadhWeekday } from "@/lib/time";
import { getSettings } from "@/lib/settings";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "2026-07-24" + "09:30" → the matching UTC instant. */
export function localToUtc(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - UTC_OFFSET_HOURS * HOUR_MS);
}

/** UTC instant → "2026-07-24" as seen in Riyadh. */
export function utcToLocalDate(date: Date): string {
  return new Date(date.getTime() + UTC_OFFSET_HOURS * HOUR_MS).toISOString().slice(0, 10);
}

/** UTC instant → "09:30" as seen in Riyadh. */
export function utcToLocalTime(date: Date): string {
  return new Date(date.getTime() + UTC_OFFSET_HOURS * HOUR_MS).toISOString().slice(11, 16);
}

export type Slot = {
  /** Local wall-clock start, "09:30". */
  time: string;
  startsAt: string; // ISO UTC
  available: boolean;
  /** Stations with no conflicting booking for the full duration. */
  freeStationIds: string[];
};

type Booking = { stationId: string | null; startsAt: Date; endsAt: Date };

type Context = {
  slotLengthMin: number;
  leadTimeMin: number;
  stationIds: string[];
  hours: Map<number, { opens: string; closes: string; closed: boolean }>;
  closures: { startsAt: Date; endsAt: Date }[];
  bookings: Booking[];
};

/**
 * Load everything the calculation needs in one pass, so a whole month can be
 * computed without re-querying per day.
 */
async function loadContext(branchId: string, from: Date, to: Date): Promise<Context> {
  const [config, stationRows, hourRows, closureRows, bookingRows] = await Promise.all([
    getSettings(["slot_length_min", "booking_lead_time_min"]),
    db
      .select({ id: stations.id })
      .from(stations)
      .where(and(eq(stations.branchId, branchId), eq(stations.active, true))),
    db.select().from(branchHours).where(eq(branchHours.branchId, branchId)),
    db
      .select({ startsAt: closures.startsAt, endsAt: closures.endsAt })
      .from(closures)
      // A closure with no branch applies to every branch.
      .where(
        and(
          or(eq(closures.branchId, branchId), isNull(closures.branchId)),
          lt(closures.startsAt, to),
          gte(closures.endsAt, from),
        ),
      ),
    db
      .select({
        stationId: bookings.stationId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.branchId, branchId),
          gte(bookings.startsAt, from),
          lt(bookings.startsAt, to),
          // Cancelled and no-show slots are free again.
          ne(bookings.status, "cancelled"),
          ne(bookings.status, "no_show"),
        ),
      ),
  ]);

  return {
    slotLengthMin: config.slot_length_min,
    leadTimeMin: config.booking_lead_time_min,
    stationIds: stationRows.map((s) => s.id),
    hours: new Map(
      hourRows.map((h) => [h.weekday, { opens: h.opens, closes: h.closes, closed: h.closed }]),
    ),
    closures: closureRows,
    bookings: bookingRows,
  };
}

function computeDay(
  ctx: Context,
  dateStr: string,
  durationMin: number,
  now: Date,
  minStations = 1,
): Slot[] {
  const weekday = riyadhWeekday(localToUtc(dateStr, "12:00"));
  const hours = ctx.hours.get(weekday);
  if (!hours || hours.closed || ctx.stationIds.length === 0) return [];

  const open = localToUtc(dateStr, hours.opens.slice(0, 5));
  const close = localToUtc(dateStr, hours.closes.slice(0, 5));
  const earliest = new Date(now.getTime() + ctx.leadTimeMin * MINUTE_MS);

  const slots: Slot[] = [];

  for (
    let start = open.getTime();
    // The appointment must finish before closing, not merely start before it.
    start + durationMin * MINUTE_MS <= close.getTime();
    start += ctx.slotLengthMin * MINUTE_MS
  ) {
    const startsAt = new Date(start);
    const endsAt = new Date(start + durationMin * MINUTE_MS);

    const inClosure = ctx.closures.some(
      (c) => startsAt < c.endsAt && endsAt > c.startsAt,
    );

    const freeStationIds = inClosure
      ? []
      : ctx.stationIds.filter(
          (id) =>
            !ctx.bookings.some(
              (b) => b.stationId === id && startsAt < b.endsAt && endsAt > b.startsAt,
            ),
        );

    slots.push({
      time: utcToLocalTime(startsAt),
      startsAt: startsAt.toISOString(),
      available: freeStationIds.length >= minStations && startsAt >= earliest,
      freeStationIds,
    });
  }

  return slots;
}

/**
 * Bookable slots for one day.
 *
 * `guests` is how many chairs must be free at once — 2 for a group booking, so a
 * slot with only one chair left is correctly shown as unavailable.
 *
 * When two guests have different durations, ask for the longer one: the booking
 * then claims a strict subset of what was checked, so a slot shown as free can
 * never fail on confirm.
 *
 * ponytail: slightly conservative — it hides an end-of-day slot where one chair
 * is free long enough and another only briefly. The exact answer means computing
 * free sets per duration; add it if the salon reports losing bookings.
 */
export async function getDayAvailability(
  branchId: string,
  dateStr: string,
  durationMin: number,
  now: Date = new Date(),
  guests = 1,
  /**
   * Override the branch's booking lead time, in minutes.
   *
   * Pass `0` for a walk-in. The lead time exists to stop a web customer booking
   * something starting in five minutes that nobody is ready for — but a walk-in
   * is a person standing at the desk right now, so the rule is exactly backwards
   * at the counter. It is also what would otherwise make a chair freed by a
   * no-show unusable: the slot it frees is always in the past.
   *
   * Only honoured for signed-in staff — see app/api/availability/route.ts.
   */
  leadTimeMin?: number,
): Promise<Slot[]> {
  const from = localToUtc(dateStr, "00:00");
  const to = new Date(from.getTime() + DAY_MS);
  const ctx = await loadContext(branchId, from, to);
  const effective = leadTimeMin === undefined ? ctx : { ...ctx, leadTimeMin };
  return computeDay(effective, dateStr, durationMin, now, guests);
}

/**
 * Which days in a month have at least one bookable slot — drives the calendar,
 * so unbookable days can be greyed out before the customer clicks them.
 */
export async function getMonthAvailability(
  branchId: string,
  year: number,
  month: number, // 1-12
  durationMin: number,
  now: Date = new Date(),
  guests = 1,
): Promise<Record<string, boolean>> {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = localToUtc(`${year}-${pad(month)}-01`, "00:00");
  const last = new Date(localToUtc(`${year}-${pad(month)}-${pad(daysInMonth)}`, "00:00").getTime() + DAY_MS);

  const ctx = await loadContext(branchId, first, last);

  const out: Record<string, boolean> = {};
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${pad(month)}-${pad(day)}`;
    out[dateStr] = computeDay(ctx, dateStr, durationMin, now, guests).some((s) => s.available);
  }
  return out;
}

/**
 * Claim `count` chairs for a booking. Returns null when there aren't enough free —
 * callers must treat that as a conflict, not an error.
 *
 * MUST be called inside a transaction, and the caller must insert its bookings in
 * that same transaction. The `for update` lock below is what makes "choose a chair"
 * and "write the booking" one indivisible step. Without it, two overlapping bookings
 * with *different* start times both pass the check and land on the same chair — the
 * `bookings_station_slot_unique` constraint only catches an identical `starts_at`.
 *
 * Ordered by `sort` so concurrent transactions always take the rows in the same
 * order, which is what keeps this deadlock-free.
 *
 * `ignoreBookingIds` excludes bookings from the conflict scan — a booking being
 * rescheduled must not see itself as the thing blocking its own move, and a
 * group being moved must not see its other half either.
 *
 * `onlyStationId` narrows the search to one chair, for the station QR add-on
 * (brief §2.7): that flow is not asking for *a* chair, it is asking whether
 * *this* chair — the one the customer is already sitting in — is still free.
 * The lock, the conflict rule and the atomicity are identical, which is the
 * point of putting it here rather than writing a second check.
 */
export type ReserveOptions = {
  ignoreBookingIds?: string[];
  onlyStationId?: string;
};

export async function reserveStations(
  tx: Tx,
  branchId: string,
  startsAt: Date,
  endsAt: Date,
  count: number,
  { ignoreBookingIds, onlyStationId }: ReserveOptions = {},
): Promise<string[] | null> {
  const stationRows = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(
      and(
        eq(stations.branchId, branchId),
        eq(stations.active, true),
        ...(onlyStationId ? [eq(stations.id, onlyStationId)] : []),
      ),
    )
    .orderBy(asc(stations.sort))
    .for("update");

  const conflicting = await tx
    .select({ id: bookings.id, stationId: bookings.stationId })
    .from(bookings)
    .where(
      and(
        eq(bookings.branchId, branchId),
        // Strict on both ends — a booking that finishes exactly when this one
        // starts is not a conflict. This must match computeDay's predicate
        // character for character, or a slot shown as free fails on confirm.
        lt(bookings.startsAt, endsAt),
        gt(bookings.endsAt, startsAt),
        ne(bookings.status, "cancelled"),
        ne(bookings.status, "no_show"),
      ),
    );

  const ignored = new Set(ignoreBookingIds ?? []);
  const taken = new Set(
    conflicting
      .filter((b) => !ignored.has(b.id))
      .map((b) => b.stationId)
      .filter(Boolean) as string[],
  );

  const free = stationRows.filter((s) => !taken.has(s.id)).map((s) => s.id);
  return free.length >= count ? free.slice(0, count) : null;
}

/**
 * How many minutes one chair stays free from `from` — the gap before whatever
 * is booked on it next, or before the branch closes, whichever comes first.
 *
 * This is the question the station QR page asks (brief §2.7: "scanning checks
 * whether that same station is free at the projected finish time"), and the
 * answer is more useful as a length than a yes/no: it lets the page offer only
 * the services that actually fit in the gap, instead of taking payment for a
 * 90-minute service into a 40-minute window.
 *
 * `0` means the chair is not free at all — the page's "rebook on the site"
 * branch. Read-only and outside any transaction: it decides what to *show*.
 * `reserveStations(..., { onlyStationId })` is what decides what to *keep*, and
 * it runs again under a lock when the booking is actually written.
 */
export async function stationFreeWindow(
  branchId: string,
  stationId: string,
  from: Date,
): Promise<number> {
  const [hourRows, nextRows] = await Promise.all([
    db
      .select({ opens: branchHours.opens, closes: branchHours.closes, closed: branchHours.closed })
      .from(branchHours)
      .where(
        and(
          eq(branchHours.branchId, branchId),
          eq(branchHours.weekday, riyadhWeekday(from)),
        ),
      ),
    db
      .select({ startsAt: bookings.startsAt })
      .from(bookings)
      .where(
        and(
          eq(bookings.stationId, stationId),
          // Anything already finished is irrelevant; `gt` on endsAt rather than
          // startsAt so a booking straddling `from` still counts as blocking.
          gt(bookings.endsAt, from),
          ne(bookings.status, "cancelled"),
          ne(bookings.status, "no_show"),
        ),
      )
      .orderBy(asc(bookings.startsAt))
      .limit(1),
  ]);

  const hours = hourRows[0];
  if (!hours || hours.closed) return 0;

  const localDay = utcToLocalDate(from);
  const open = localToUtc(localDay, hours.opens.slice(0, 5));
  const close = localToUtc(localDay, hours.closes.slice(0, 5));

  // Outside opening hours there is no window at all. Without this the free time
  // is measured to the *end* of the day `from` falls in, so an appointment
  // running past midnight reports the whole of the next trading day as free —
  // twenty hours of availability at two in the morning.
  if (from < open || from >= close) return 0;

  // A booking already running at `from` starts before it — the gap is negative
  // and clamps to zero below, which is the correct "chair is occupied".
  const nextStart = nextRows[0]?.startsAt;
  const until = nextStart && nextStart < close ? nextStart : close;

  // Closures are deliberately not consulted: this window is minutes from now,
  // and a closure starting mid-appointment is the salon's problem to handle at
  // the desk, not a case worth a second query on every scan.
  return Math.max(0, Math.floor((until.getTime() - from.getTime()) / MINUTE_MS));
}
