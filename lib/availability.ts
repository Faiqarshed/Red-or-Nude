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
      available: freeStationIds.length > 0 && startsAt >= earliest,
      freeStationIds,
    });
  }

  return slots;
}

/** Bookable slots for one day. */
export async function getDayAvailability(
  branchId: string,
  dateStr: string,
  durationMin: number,
  now: Date = new Date(),
): Promise<Slot[]> {
  const from = localToUtc(dateStr, "00:00");
  const to = new Date(from.getTime() + DAY_MS);
  const ctx = await loadContext(branchId, from, to);
  return computeDay(ctx, dateStr, durationMin, now);
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
): Promise<Record<string, boolean>> {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = localToUtc(`${year}-${pad(month)}-01`, "00:00");
  const last = new Date(localToUtc(`${year}-${pad(month)}-${pad(daysInMonth)}`, "00:00").getTime() + DAY_MS);

  const ctx = await loadContext(branchId, first, last);

  const out: Record<string, boolean> = {};
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${pad(month)}-${pad(day)}`;
    out[dateStr] = computeDay(ctx, dateStr, durationMin, now).some((s) => s.available);
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
 * `ignoreBookingId` excludes one booking from the conflict scan — a booking being
 * rescheduled must not see itself as the thing blocking its own move.
 */
export async function reserveStations(
  tx: Tx,
  branchId: string,
  startsAt: Date,
  endsAt: Date,
  count: number,
  ignoreBookingId?: string,
): Promise<string[] | null> {
  const stationRows = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(and(eq(stations.branchId, branchId), eq(stations.active, true)))
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

  const taken = new Set(
    conflicting
      .filter((b) => b.id !== ignoreBookingId)
      .map((b) => b.stationId)
      .filter(Boolean) as string[],
  );

  const free = stationRows.filter((s) => !taken.has(s.id)).map((s) => s.id);
  return free.length >= count ? free.slice(0, count) : null;
}
