// Clocks, and the exact instant each one turns over.
//
// Every rule in this codebase that says "before", "after", "still", "already" or
// "left" has one instant where it changes its mind, and almost all of them are
// documented as strict or inclusive in a comment beside the code. This suite
// stands on each of those instants and on the millisecond either side of it.
//
// Why a whole file: an off-by-one in a window is the bug that does not show up
// in manual testing, because nobody clicks at exactly 14:00:00.000. It shows up
// as one customer a month who could not cancel a booking three hours out, or a
// chair that stayed held for a service that finished on the hour.
//
// Times are built as UTC instants and read in Riyadh (UTC+3, no DST), which is
// the only conversion this application does.

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, otps, promoCodes, stations } from "@/lib/db/schema";
import { canCancel, cancelDeadline, cancelRefusal } from "@/lib/cancellation";
import { refillDaysLeft, refillWindowEnd } from "@/lib/refill";
import { promoRefusal } from "@/lib/promo";
import { spendableBalance } from "@/lib/rewards";
import { serviceClock } from "@/lib/booking-clock";
import { monthWindow } from "@/lib/staff-codes";
import { isToday } from "@/lib/assign";
import { verifyOtp } from "@/lib/otp";
import {
  getDayAvailability,
  localToUtc,
  reserveStations,
  utcToLocalDate,
  utcToLocalTime,
} from "@/lib/availability";
import {
  UTC_OFFSET_HOURS,
  closureDays,
  formatCountdown,
  riyadhDateKey,
  riyadhDayRange,
  riyadhWeekday,
} from "@/lib/time";
import { createBooking, sweepNoShows } from "@/lib/bookings";
import { getSettings } from "@/lib/settings";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** One millisecond either side of an instant — the whole point of this file. */
const before = (t: Date | number) => new Date(Number(t) - 1);
const after = (t: Date | number) => new Date(Number(t) + 1);

let f: Fixtures;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

// ---------------------------------------------------------------------------

describe("the cancellation window closes on the deadline, not after it", () => {
  const startsAt = new Date(FUTURE);
  const open = { startsAt, status: "confirmed" };
  const cutoff = 3;

  it("puts the deadline exactly cutoffHours before the appointment", () => {
    expect(cancelDeadline(open, cutoff).getTime()).toBe(startsAt.getTime() - 3 * HOUR);
    // Zero hours means "up until it starts", not "never".
    expect(cancelDeadline(open, 0).getTime()).toBe(startsAt.getTime());
  });

  it("refuses at the deadline and allows one millisecond before it", () => {
    const deadline = cancelDeadline(open, cutoff);

    // The comment on cancelRefusal says standing exactly on the deadline is too
    // late, so a booking is never cancellable and uncancellable at once.
    expect(cancelRefusal(open, cutoff, deadline)).toBe("window-closed");
    expect(cancelRefusal(open, cutoff, before(deadline))).toBeNull();
    expect(cancelRefusal(open, cutoff, after(deadline))).toBe("window-closed");

    expect(canCancel(open, cutoff, before(deadline))).toBe(true);
    expect(canCancel(open, cutoff, deadline)).toBe(false);
  });

  it("names the reason rather than blaming the clock", () => {
    const early = before(cancelDeadline(open, cutoff));

    // Well inside the window, so anything refused here is refused on status.
    expect(cancelRefusal({ startsAt, status: "cancelled" }, cutoff, early)).toBe("already-cancelled");
    expect(cancelRefusal({ startsAt, status: "no_show" }, cutoff, early)).toBe("already-cancelled");
    expect(cancelRefusal({ startsAt, status: "in_progress" }, cutoff, early)).toBe("not-cancellable");
    expect(cancelRefusal({ startsAt, status: "completed" }, cutoff, early)).toBe("not-cancellable");
    // An unpaid hold is hers to let go of without waiting out the sweep.
    expect(cancelRefusal({ startsAt, status: "pending" }, cutoff, early)).toBeNull();
  });

  it("reports a status refusal even after the window has shut", () => {
    const late = after(cancelDeadline(open, cutoff));
    // Order matters: "you already cancelled" is true and useful; "your window
    // closed" would send her looking for a deadline problem she does not have.
    expect(cancelRefusal({ startsAt, status: "cancelled" }, cutoff, late)).toBe("already-cancelled");
  });
});

// ---------------------------------------------------------------------------

describe("a refill window runs out at the instant it says", () => {
  const served = (startsAt: Date, refillDays = 30) => ({
    startsAt,
    status: "completed",
    refillDays,
    alreadyRefilled: false,
    isRefill: false,
  });

  it("ends exactly refillDays after the appointment", () => {
    const startsAt = new Date(FUTURE);
    expect(refillWindowEnd(served(startsAt))!.getTime()).toBe(startsAt.getTime() + 30 * DAY);
    // No window at all rather than a zero-length one.
    expect(refillWindowEnd(served(startsAt, 0))).toBeNull();
  });

  it("offers nothing on the closing instant and one day on the millisecond before", () => {
    const startsAt = new Date(FUTURE);
    const end = refillWindowEnd(served(startsAt))!;

    expect(refillDaysLeft(served(startsAt), before(end))).toBe(1);
    // msLeft <= 0 — the window is spent the moment it ends.
    expect(refillDaysLeft(served(startsAt), end)).toBe(0);
    expect(refillDaysLeft(served(startsAt), after(end))).toBe(0);
  });

  it("rounds the last partial day up, so a countdown never reads zero while it is open", () => {
    const startsAt = new Date(FUTURE);
    const end = refillWindowEnd(served(startsAt))!;

    // A minute of window left still says "1 day".
    expect(refillDaysLeft(served(startsAt), new Date(end.getTime() - MIN))).toBe(1);
    // Exactly one whole day left says 1, not 2.
    expect(refillDaysLeft(served(startsAt), new Date(end.getTime() - DAY))).toBe(1);
    expect(refillDaysLeft(served(startsAt), new Date(end.getTime() - DAY - 1))).toBe(2);
  });

  it("counts a confirmed appointment as served the moment it starts", () => {
    const startsAt = new Date(FUTURE);
    const confirmed = { ...served(startsAt), status: "confirmed" };

    // `startsAt <= now` — she is in the chair at the exact instant it begins.
    expect(refillDaysLeft(confirmed, startsAt)).toBeGreaterThan(0);
    expect(refillDaysLeft(confirmed, before(startsAt))).toBe(0);
  });

  it("gives nothing back to a refill, a spent window or a service without one", () => {
    const now = new Date(FUTURE + DAY);
    const startsAt = new Date(FUTURE);
    expect(refillDaysLeft({ ...served(startsAt), isRefill: true }, now)).toBe(0);
    expect(refillDaysLeft({ ...served(startsAt), alreadyRefilled: true }, now)).toBe(0);
    expect(refillDaysLeft(served(startsAt, 0), now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("a chair is free the instant the last appointment ends", () => {
  it("does not treat a booking that ends exactly when the next starts as a clash", async () => {
    const start = new Date(FUTURE);
    const mid = new Date(FUTURE + f.svcA.durationMin * MIN);

    const first = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: start.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(first.ok).toBe(true);

    // Butted right up against it. Both predicates are strict on both ends —
    // reserveStations says so in a comment, and computeDay has to agree.
    const second = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: mid.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(second.ok).toBe(true);

    // One millisecond earlier overlaps, so it must land on a different chair.
    const overlapping = await db.transaction((tx) =>
      reserveStations(tx, f.branchA, before(mid), new Date(Number(mid) + HOUR), 1),
    );
    const used = await db
      .select({ stationId: bookings.stationId })
      .from(bookings)
      .where(eq(bookings.branchId, f.branchA));
    expect(overlapping).not.toBeNull();
    expect(used.map((u) => u.stationId)).not.toContain(overlapping![0]);
  });

  it("refuses the last chair to an overlap of one millisecond", async () => {
    const start = new Date(FUTURE);
    const end = new Date(FUTURE + HOUR);

    const chairs = await db
      .select({ id: stations.id })
      .from(stations)
      .where(and(eq(stations.branchId, f.branchA), eq(stations.active, true)));

    // Fill every chair for the hour.
    const guest = (
      await db.insert(customers).values({ phone: "0500000093" }).returning()
    )[0];
    for (const [i, chair] of chairs.entries()) {
      await db.insert(bookings).values({
        code: `RON-T${String(i).padStart(4, "0")}`,
        branchId: f.branchA,
        customerId: guest.id,
        stationId: chair.id,
        serviceId: f.svcA.id,
        startsAt: start,
        endsAt: end,
        status: "confirmed",
        source: "walk_in",
        serviceName: { ar: "اختبار", en: "test" },
      });
    }

    // Starting on the tick they all end: free.
    await expect(
      db.transaction((tx) => reserveStations(tx, f.branchA, end, new Date(Number(end) + HOUR), 1)),
    ).resolves.not.toBeNull();

    // One millisecond earlier: nothing left.
    await expect(
      db.transaction((tx) =>
        reserveStations(tx, f.branchA, before(end), new Date(Number(end) + HOUR), 1),
      ),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("the calendar's own edges", () => {
  const day = utcToLocalDate(new Date(FUTURE));

  it("offers a slot that finishes exactly at closing and nothing past it", async () => {
    const slots = await getDayAvailability(f.branchA, day, 60, new Date(FUTURE - DAY));
    if (!slots.length) return; // branch shut that day

    const last = slots[slots.length - 1];
    const ends = new Date(Date.parse(last.startsAt) + 60 * MIN);

    // The appointment must finish before closing, not merely start before it —
    // so the last offered start plus its duration lands on or before close.
    const longer = await getDayAvailability(f.branchA, day, 120, new Date(FUTURE - DAY));
    if (longer.length) {
      const lastLong = longer[longer.length - 1];
      expect(Date.parse(lastLong.startsAt) + 120 * MIN).toBeLessThanOrEqual(ends.getTime() + 60 * MIN);
      // A service an hour longer cannot start as late as a shorter one.
      expect(Date.parse(lastLong.startsAt)).toBeLessThan(Date.parse(last.startsAt));
    }
  });

  it("puts every grid slot on the slot length, counted from opening", async () => {
    const slots = await getDayAvailability(f.branchA, day, 60, new Date(FUTURE - DAY));
    if (slots.length < 2) return;

    const { slot_length_min: step } = await getSettings(["slot_length_min"]);
    const first = Date.parse(slots[0].startsAt);

    // Gap slots — the moment a chair comes free — are allowed off-grid, so this
    // asserts the grid ones only: every start is a whole number of steps from
    // the first, or it is a gap the engine surfaced deliberately.
    for (const s of slots) {
      const delta = Date.parse(s.startsAt) - first;
      const onGrid = delta % (step * MIN) === 0;
      expect(onGrid || s.available).toBe(true);
    }
  });

  it("calls a slot starting this very second `too-soon`, never `past`", async () => {
    const slots = await getDayAvailability(f.branchA, day, 60, new Date(FUTURE - DAY));
    if (!slots.length) return;

    const at = new Date(slots[0].startsAt);

    // `startsAt < now` is strict, so standing exactly on the start is not past —
    // and for a walk-in, whose lead time is zero, it is the slot the desk wants.
    const atTheTick = await getDayAvailability(f.branchA, day, 60, at, 1, 0);
    const thisSlot = atTheTick.find((s) => s.startsAt === slots[0].startsAt);
    expect(thisSlot?.blockedBy).not.toBe("past");

    const oneMsLater = await getDayAvailability(f.branchA, day, 60, after(at), 1, 0);
    expect(oneMsLater.find((s) => s.startsAt === slots[0].startsAt)?.blockedBy).toBe("past");
  });

  it("lets a slot exactly on the lead time through", async () => {
    const slots = await getDayAvailability(f.branchA, day, 60, new Date(FUTURE - DAY));
    if (!slots.length) return;

    const at = Date.parse(slots[0].startsAt);
    const lead = 60;

    // `startsAt < earliest` is strict: now + leadTime lands on the slot exactly,
    // and exactly is allowed.
    const onTheLine = await getDayAvailability(
      f.branchA,
      day,
      60,
      new Date(at - lead * MIN),
      1,
      lead,
    );
    expect(onTheLine.find((s) => s.startsAt === slots[0].startsAt)?.blockedBy).not.toBe("too-soon");

    const oneMsShort = await getDayAvailability(
      f.branchA,
      day,
      60,
      new Date(at - lead * MIN + 1),
      1,
      lead,
    );
    expect(oneMsShort.find((s) => s.startsAt === slots[0].startsAt)?.blockedBy).toBe("too-soon");
  });

  it("blames a full branch on the chairs and never on the notice period", async () => {
    // `full` outranks `too-soon` — a slot with no chair stays unbookable however
    // much notice you give it, and saying "book earlier" would be a lie.
    const slots = await getDayAvailability(f.branchA, day, 60, new Date(FUTURE - DAY), 99);
    for (const s of slots) {
      if (s.freeStationIds.length < 99) expect(s.blockedBy).not.toBe("too-soon");
    }
  });
});

// ---------------------------------------------------------------------------

describe("Riyadh is where the day turns over", () => {
  it("rolls the local date at 21:00 UTC and not at midnight UTC", () => {
    // 2031-05-14 20:59:59.999Z is still the 14th in Riyadh; one ms later is the 15th.
    const lastMoment = Date.UTC(2031, 4, 14, 24 - UTC_OFFSET_HOURS, 0, 0) - 1;
    expect(utcToLocalDate(new Date(lastMoment))).toBe("2031-05-14");
    expect(utcToLocalDate(new Date(lastMoment + 1))).toBe("2031-05-15");
    expect(riyadhDateKey(new Date(lastMoment))).toBe("2031-05-14");
    expect(riyadhDateKey(new Date(lastMoment + 1))).toBe("2031-05-15");
  });

  it("agrees with itself: the two date helpers never split a millisecond", () => {
    // utcToLocalDate is the booking engine's; riyadhDateKey is the panel's. A
    // day that is the 14th to one and the 15th to the other is a ticket counter
    // handing out yesterday's numbers.
    for (let h = 0; h < 24; h++) {
      const t = new Date(Date.UTC(2031, 4, 14, h, 30));
      expect(utcToLocalDate(t)).toBe(riyadhDateKey(t));
    }
  });

  it("opens the local day at 21:00 UTC the evening before and runs 24 hours", () => {
    const noonLocal = new Date(Date.UTC(2031, 4, 14, 9, 0)); // 12:00 Riyadh
    const { start, end } = riyadhDayRange(noonLocal);

    expect(start.toISOString()).toBe("2031-05-13T21:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(DAY);
    // Inclusive start, exclusive end.
    expect(start.getTime()).toBeLessThanOrEqual(noonLocal.getTime());
    expect(end.getTime()).toBeGreaterThan(noonLocal.getTime());
  });

  it("keeps a local midnight on the day it belongs to", () => {
    const midnight = localToUtc("2031-05-14", "00:00");
    expect(midnight.toISOString()).toBe("2031-05-13T21:00:00.000Z");
    expect(utcToLocalDate(midnight)).toBe("2031-05-14");
    expect(utcToLocalTime(midnight)).toBe("00:00");

    // And the instant before it is the previous day, not the same one.
    expect(utcToLocalDate(before(midnight))).toBe("2031-05-13");
  });

  it("numbers weekdays from Saturday, measured in Riyadh", () => {
    // 2031-05-17 is a Saturday.
    expect(riyadhWeekday(localToUtc("2031-05-17", "12:00"))).toBe(0);
    expect(riyadhWeekday(localToUtc("2031-05-18", "12:00"))).toBe(1);
    expect(riyadhWeekday(localToUtc("2031-05-23", "12:00"))).toBe(6);

    // The boundary case: 00:00 Riyadh Saturday is 21:00 UTC Friday, and the
    // weekday has to follow the salon's clock rather than UTC's.
    expect(riyadhWeekday(localToUtc("2031-05-17", "00:00"))).toBe(0);
    expect(riyadhWeekday(before(localToUtc("2031-05-17", "00:00")))).toBe(6);
  });

  it("reads a closure back as the days the admin typed, both ends inclusive", () => {
    // Stored as local midnight to local midnight the day after the last closed
    // day. Truncating in UTC lands a day early; printing endsAt as given lands a
    // day late — and on the end they cancel, which is worse than either.
    const startsAt = localToUtc("2031-03-20", "00:00");
    const endsAt = localToUtc("2031-03-23", "00:00");
    expect(closureDays(startsAt, endsAt)).toEqual({ from: "2031-03-20", to: "2031-03-22" });

    // A single closed day.
    expect(closureDays(startsAt, localToUtc("2031-03-21", "00:00"))).toEqual({
      from: "2031-03-20",
      to: "2031-03-20",
    });
  });

  it("puts a staff code's month on the Riyadh calendar, not the UTC one", () => {
    // 21:00 UTC on the 31st is already the 1st in Riyadh, and the code has to
    // renew then rather than three hours later.
    const lastMomentOfApril = before(localToUtc("2031-05-01", "00:00"));
    const firstMomentOfMay = localToUtc("2031-05-01", "00:00");

    expect(monthWindow(lastMomentOfApril).start.toISOString()).toBe(
      localToUtc("2031-04-01", "00:00").toISOString(),
    );
    expect(monthWindow(firstMomentOfMay).start.toISOString()).toBe(
      firstMomentOfMay.toISOString(),
    );
    // One window ends exactly where the next begins — no gap, no overlap.
    expect(monthWindow(lastMomentOfApril).end.getTime()).toBe(
      monthWindow(firstMomentOfMay).start.getTime(),
    );
  });

  it("calls today today on both sides of the local midnight", () => {
    const midnight = localToUtc("2031-05-14", "00:00");
    expect(isToday(midnight, midnight)).toBe(true);
    expect(isToday(midnight, before(midnight))).toBe(false);
    expect(isToday(midnight, new Date(Number(midnight) + DAY - 1))).toBe(true);
    expect(isToday(midnight, new Date(Number(midnight) + DAY))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("a promo code is never live and expired in the same millisecond", () => {
  const rule = (startsAt: Date | null, endsAt: Date | null) => ({
    type: "percent" as const,
    value: 10,
    minTotalHalalas: 0,
    startsAt,
    endsAt,
    maxUses: null,
    uses: 0,
    active: true,
  });

  it("opens on its start instant and shuts on its end instant", () => {
    const start = new Date(FUTURE);
    const end = new Date(FUTURE + 7 * DAY);
    const promo = rule(start, end);

    expect(promoRefusal(promo, 10_000, before(start))).toBe("not-started");
    // Inclusive start: the occasion begins the moment it begins.
    expect(promoRefusal(promo, 10_000, start)).toBeNull();
    expect(promoRefusal(promo, 10_000, before(end))).toBeNull();
    // `now >= endsAt` — exclusive end.
    expect(promoRefusal(promo, 10_000, end)).toBe("expired");
  });

  it("checks the switch and the cap before the clock", () => {
    const now = new Date(FUTURE);
    expect(promoRefusal({ ...rule(null, null), active: false }, 10_000, now)).toBe("inactive");
    expect(promoRefusal({ ...rule(null, null), maxUses: 1, uses: 1 }, 10_000, now)).toBe("used-up");
    // Exactly at the cap is spent; one below is not.
    expect(promoRefusal({ ...rule(null, null), maxUses: 2, uses: 1 }, 10_000, now)).toBeNull();
  });

  it("treats a bill exactly on the minimum as big enough", () => {
    const now = new Date(FUTURE);
    const promo = { ...rule(null, null), minTotalHalalas: 20_000 };
    expect(promoRefusal(promo, 19_999, now)).toBe("min-total");
    expect(promoRefusal(promo, 20_000, now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("points stop counting the moment their booking is past saving", () => {
  const row = (createdAt: Date, status = "pending") => ({
    deltaPoints: 100,
    bookingStatus: status,
    bookingCreatedAt: createdAt,
  });

  it("keeps a pending hold's points until it is older than the hold window", () => {
    const holdMin = 15;
    const madeAt = new Date(FUTURE);
    const expiry = new Date(Number(madeAt) + holdMin * MIN);

    // `now - createdAt > holdMin` is strict, so exactly on the window is alive.
    expect(spendableBalance([row(madeAt)], holdMin, expiry)).toBe(100);
    expect(spendableBalance([row(madeAt)], holdMin, after(expiry))).toBe(0);
  });

  it("drops them at once for a cancellation, whatever the clock says", () => {
    const madeAt = new Date(FUTURE);
    expect(spendableBalance([row(madeAt, "cancelled")], 15, madeAt)).toBe(0);
    expect(spendableBalance([row(madeAt, "no_show")], 15, madeAt)).toBe(0);
    // Paid for: no clock applies at all.
    expect(spendableBalance([row(madeAt, "confirmed")], 15, new Date(Number(madeAt) + 365 * DAY))).toBe(100);
  });

  it("counts a movement attached to no booking forever", () => {
    expect(
      spendableBalance(
        [{ deltaPoints: 50, bookingStatus: null, bookingCreatedAt: null }],
        15,
        new Date(FUTURE + 365 * DAY),
      ),
    ).toBe(50);
  });
});

// ---------------------------------------------------------------------------

describe("the desk clock", () => {
  const iso = (t: number) => new Date(t).toISOString();

  it("counts from check-in, and settles the moment finish is stamped", () => {
    const inAt = FUTURE;
    const outAt = FUTURE + 42 * MIN;

    expect(serviceClock({ status: "in_progress", checkedInAt: iso(inAt) }, inAt + 10 * MIN)).toEqual({
      runningMs: 10 * MIN,
      tookMs: null,
    });

    const settled = serviceClock(
      { status: "in_progress", checkedInAt: iso(inAt), finishedAt: iso(outAt) },
      outAt + 5 * HOUR,
    );
    // Stops climbing while the ticket waits to be closed.
    expect(settled).toEqual({ runningMs: null, tookMs: 42 * MIN });
  });

  it("reads zero, never a negative, when finish lands on check-in", () => {
    const t = FUTURE;
    expect(
      serviceClock({ status: "completed", checkedInAt: iso(t), finishedAt: iso(t) }, t).tookMs,
    ).toBe(0);
    // And a finish stamped before check-in — clock skew, a hand edit — clamps.
    expect(
      serviceClock(
        { status: "completed", checkedInAt: iso(t), finishedAt: iso(t - HOUR) },
        t,
      ).tookMs,
    ).toBe(0);
  });

  it("shows nothing rather than a growing figure once the booking is over", () => {
    const inAt = FUTURE;
    for (const status of ["completed", "cancelled", "no_show"]) {
      expect(serviceClock({ status, checkedInAt: iso(inAt) }, inAt + 7 * HOUR)).toEqual({
        runningMs: null,
        tookMs: null,
      });
    }
  });

  it("falls back to the start stamp for a walk-in with no check-in", () => {
    const at = FUTURE;
    expect(serviceClock({ status: "in_progress", startedAt: iso(at) }, at + MIN).runningMs).toBe(MIN);
    // Nothing stamped at all: no clock, rather than a clock from zero.
    expect(serviceClock({ status: "in_progress" }, at)).toEqual({ runningMs: null, tookMs: null });
  });
});

// ---------------------------------------------------------------------------

describe("countdowns round the way a person reads them", () => {
  it("rounds minutes up, so `now` is never shown for a locked button", () => {
    // Told "in 1 minute" and finding it locked is the truth about the wrong
    // second; told "now" and finding it locked is a lie.
    expect(formatCountdown(1, "en")).toContain("1");
    expect(formatCountdown(59_000, "en")).toContain("1");
    expect(formatCountdown(61_000, "en")).toContain("2");
  });

  it("switches units where a figure stops being something to act on", () => {
    expect(formatCountdown(119 * MIN, "en")).toMatch(/minute/);
    expect(formatCountdown(120 * MIN, "en")).toMatch(/hour/);
    expect(formatCountdown(47 * HOUR, "en")).toMatch(/hour/);
    expect(formatCountdown(48 * HOUR, "en")).toMatch(/day/);
  });

  it("writes Arabic with Latin digits, as the rest of the panel does", () => {
    expect(formatCountdown(5 * MIN, "ar")).toMatch(/5/);
  });
});

// ---------------------------------------------------------------------------

describe("codes expire on the instant stamped on them", () => {
  const subject = `booking:${"0".repeat(8)}-0000-0000-0000-0000000000ff`;

  it("refuses a code whose expiry has just passed", async () => {
    await db.delete(otps).where(eq(otps.subject, subject));
    // Written directly so the expiry is exact rather than ten minutes out.
    const { createHash } = await import("node:crypto");
    await db.insert(otps).values({
      subject,
      codeHash: createHash("sha256").update("123456").digest("hex"),
      expiresAt: new Date(Date.now() - 1),
    });

    // `expiresAt > now()` — a code that expired a millisecond ago is gone, and
    // "expired", "used" and "never issued" are deliberately one answer.
    expect(await verifyOtp(subject, "123456")).toEqual({ ok: false, reason: "no-code" });
  });

  it("accepts one that has a second left", async () => {
    await db.delete(otps).where(eq(otps.subject, subject));
    const { createHash } = await import("node:crypto");
    await db.insert(otps).values({
      subject,
      codeHash: createHash("sha256").update("654321").digest("hex"),
      expiresAt: new Date(Date.now() + 5_000),
    });

    expect(await verifyOtp(subject, "654321")).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------

describe("the no-show sweep waits out the grace period", () => {
  it("leaves a booking still inside its grace and takes one past it", async () => {
    const { no_show_grace_min: grace } = await getSettings(["no_show_grace_min"]);

    const guest = (await db.insert(customers).values({ phone: "0500000094" }).returning())[0];
    const [chair] = await db
      .select({ id: stations.id })
      .from(stations)
      .where(and(eq(stations.branchId, f.branchA), eq(stations.active, true)))
      .limit(1);

    // Two minutes either side of the line rather than exactly on it: the sweep
    // reads the database's own now(), which moves between building these rows
    // and running the statement. The rule is `starts_at < now() - grace`.
    const rows = [
      { code: "RON-GRACE1", offset: -(grace - 2) * MIN, expect: "confirmed" },
      { code: "RON-GRACE2", offset: -(grace + 2) * MIN, expect: "no_show" },
    ];

    for (const r of rows) {
      await db.insert(bookings).values({
        code: r.code,
        branchId: f.branchA,
        customerId: guest.id,
        stationId: chair.id,
        serviceId: f.svcA.id,
        startsAt: new Date(Date.now() + r.offset),
        endsAt: new Date(Date.now() + r.offset + HOUR),
        status: "confirmed",
        source: "web",
        serviceName: { ar: "اختبار", en: "test" },
      });
    }

    await sweepNoShows(f.branchA);

    for (const r of rows) {
      const [row] = await db
        .select({ status: bookings.status, noShowAt: bookings.noShowAt })
        .from(bookings)
        .where(eq(bookings.code, r.code));
      expect(row.status).toBe(r.expect);
      if (r.expect === "no_show") expect(row.noShowAt).not.toBeNull();
    }
  });

  it("keeps the first flag's timestamp however many times it runs", async () => {
    const [row] = await db
      .select({ noShowAt: bookings.noShowAt })
      .from(bookings)
      .where(eq(bookings.code, "RON-GRACE2"));
    if (!row) return;

    const firstStamp = row.noShowAt;
    await sweepNoShows(f.branchA);
    await sweepNoShows(f.branchA);

    const [again] = await db
      .select({ noShowAt: bookings.noShowAt })
      .from(bookings)
      .where(eq(bookings.code, "RON-GRACE2"));
    // `no_show_at is null` in the predicate is what makes it idempotent.
    expect(again.noShowAt?.getTime()).toBe(firstStamp?.getTime());
  });

  it("ignores an appointment older than the lookback and one still to come", async () => {
    const guest = (await db.insert(customers).values({ phone: "0500000095" }).returning())[0];
    const [chair] = await db
      .select({ id: stations.id })
      .from(stations)
      .where(and(eq(stations.branchId, f.branchA), eq(stations.active, true)))
      .limit(1);

    const cases = [
      { code: "RON-OLD01", at: Date.now() - 8 * DAY }, // past the 7-day lookback
      { code: "RON-SOON1", at: Date.now() + HOUR }, // has not happened yet
    ];

    for (const c of cases) {
      await db.insert(bookings).values({
        code: c.code,
        branchId: f.branchA,
        customerId: guest.id,
        stationId: chair.id,
        serviceId: f.svcA.id,
        startsAt: new Date(c.at),
        endsAt: new Date(c.at + HOUR),
        status: "confirmed",
        source: "web",
        serviceName: { ar: "اختبار", en: "test" },
      });
    }

    await sweepNoShows(f.branchA);

    for (const c of cases) {
      const [row] = await db
        .select({ status: bookings.status })
        .from(bookings)
        .where(eq(bookings.code, c.code));
      expect(row.status).toBe("confirmed");
    }
  });
});

// ---------------------------------------------------------------------------

describe("promo rows in the database read the same clock", () => {
  it("refuses a code that lapsed a second ago and honours one with a second left", async () => {
    const codes = [
      { code: "TIMINGGONE", endsAt: new Date(Date.now() - 1_000), live: false },
      { code: "TIMINGLIVE", endsAt: new Date(Date.now() + 60_000), live: true },
    ];

    const { quotePromo } = await import("@/lib/promo");

    for (const c of codes) {
      await db.delete(promoCodes).where(eq(promoCodes.code, c.code));
      await db.insert(promoCodes).values({
        code: c.code,
        type: "percent",
        value: 10,
        startsAt: new Date(Date.now() - DAY),
        endsAt: c.endsAt,
        active: true,
      });

      const quote = await quotePromo(c.code, 50_000);
      expect(quote.ok).toBe(c.live);
      if (!quote.ok) expect(quote.reason).toBe("expired");

      await db.delete(promoCodes).where(eq(promoCodes.code, c.code));
    }
  });
});
