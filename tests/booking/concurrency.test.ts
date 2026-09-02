// One chair, one customer, whatever the traffic does.
//
// The guarantee lives in `reserveStations` (lib/availability.ts:356) and nowhere
// else. Its own comment is explicit that the database constraint is not enough:
//
//   "the `bookings_station_slot_unique` constraint only catches an identical
//    `starts_at`" — two *overlapping* bookings with different start times both
//    pass it, and only the `for update` lock stops them landing on one chair.
//
// So these cases are deliberately not constraint tests (tests/schema owns
// those). They run the real `createBookings` path concurrently and count what
// survived. What would be easy to break: moving the station SELECT out of the
// transaction, dropping `.for("update")`, or "optimising" the ORDER BY that
// keeps concurrent transactions taking rows in the same order — none of which
// would fail a single-threaded test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { resetAppContext } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);

const fx = new Fixtures();
beforeEach(resetAppContext);
afterEach(() => fx.cleanup());

/** A Saturday well in the future, inside the 10:00–22:00 the fixture opens. */
const SLOT = "2030-03-02T11:00:00.000Z";
const at = (iso: string) => new Date(iso);

type Made = Awaited<ReturnType<typeof import("@/lib/bookings").createBookings>>;

async function book(
  branchId: string,
  serviceId: string,
  startsAt: string,
  phone: string,
  members = 1,
): Promise<Made> {
  const { createBookings } = await import("@/lib/bookings");
  return createBookings({
    branchId,
    startsAt,
    customer: { name: "Racer", phone },
    source: "web",
    // addonIds is required by BookingMember and read without a guard in
    // priceMember — an empty array is the "no extras" case, not omission.
    members: Array.from({ length: members }, () => ({ serviceId, addonIds: [] })),
  });
}

/** Everything actually on the books at this branch, cancellations excluded. */
async function liveBookings(branchId: string) {
  return db
    .select({ id: bookings.id, stationId: bookings.stationId, startsAt: bookings.startsAt })
    .from(bookings)
    .where(and(eq(bookings.branchId, branchId), ne(bookings.status, "cancelled")));
}

describe("two customers going for the last chair", () => {
  it("gives it to exactly one of them", async () => {
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });

    // Fired together, on separate connections, into the same transaction window.
    const [a, b] = await Promise.all([
      book(branch.id, svc.id, SLOT, "0530000001"),
      book(branch.id, svc.id, SLOT, "0530000002"),
    ]);
    await fx.claimBookingsOf(branch.id);

    const winners = [a, b].filter((r) => r.ok);
    expect(winners, "both customers were given the same chair").toHaveLength(1);

    const losers = [a, b].filter((r) => !r.ok) as Array<{ ok: false; error: string }>;
    // "slot-taken" is the honest answer; "failed" would mean the lock threw
    // rather than the loser being told the chair went.
    expect(losers[0].error).toBe("slot-taken");

    expect(await liveBookings(branch.id)).toHaveLength(1);
  });

  it("holds under eight at once, with two chairs", async () => {
    // The pathological shape: far more contenders than capacity, so any window
    // between the check and the write shows up as an over-sell.
    const branch = await fx.branch({ stationCount: 2 });
    const svc = await fx.service({ durationMin: 60 });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        book(branch.id, svc.id, SLOT, `05301000${String(i).padStart(2, "0")}`),
      ),
    );
    await fx.claimBookingsOf(branch.id);

    expect(results.filter((r) => r.ok), "more bookings than chairs").toHaveLength(2);

    const live = await liveBookings(branch.id);
    expect(live).toHaveLength(2);
    // Two winners must be on two *different* chairs, not both on chair one.
    expect(new Set(live.map((b) => b.stationId)).size).toBe(2);
  });

  it("stops an overlap that starts at a different minute", async () => {
    // The case the unique index cannot see: 11:00–12:00 and 11:30–12:30 have
    // different start times, so only the row lock separates them.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });

    const [a, b] = await Promise.all([
      book(branch.id, svc.id, "2030-03-02T11:00:00.000Z", "0530000003"),
      book(branch.id, svc.id, "2030-03-02T11:30:00.000Z", "0530000004"),
    ]);
    await fx.claimBookingsOf(branch.id);

    expect([a, b].filter((r) => r.ok), "an overlapping pair both got the chair").toHaveLength(1);
  });

  it("lets a group of two take two chairs, or none", async () => {
    // A group is all-or-nothing: three guests into two chairs must not seat two
    // and drop the third.
    const branch = await fx.branch({ stationCount: 2 });
    const svc = await fx.service({ durationMin: 60 });

    const tooBig = await book(branch.id, svc.id, SLOT, "0530000005", 3);
    await fx.claimBookingsOf(branch.id);
    expect(tooBig.ok).toBe(false);
    expect(await liveBookings(branch.id), "a partial group was seated").toHaveLength(0);

    const fits = await book(branch.id, svc.id, SLOT, "0530000006", 2);
    await fx.claimBookingsOf(branch.id);
    expect(fits.ok).toBe(true);
    expect(await liveBookings(branch.id)).toHaveLength(2);
  });
});

describe("the boundary between two appointments", () => {
  it("lets one start exactly when the other ends", async () => {
    // reserveStations is strict on both ends, and its comment says this must
    // match computeDay "character for character" or a slot shown as free fails
    // on confirm. 11:00–12:00 then 12:00–13:00 is one chair, twice, legally.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });

    const first = await book(branch.id, svc.id, "2030-03-02T11:00:00.000Z", "0530000007");
    const second = await book(branch.id, svc.id, "2030-03-02T12:00:00.000Z", "0530000008");
    await fx.claimBookingsOf(branch.id);

    expect(first.ok).toBe(true);
    expect(second.ok, "a booking starting on the previous one's end was refused").toBe(true);

    const live = await liveBookings(branch.id);
    expect(new Set(live.map((b) => b.stationId)).size, "the salon opened a second chair").toBe(1);
  });

  it("refuses one that starts a minute before the other ends", async () => {
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });

    expect((await book(branch.id, svc.id, "2030-03-02T11:00:00.000Z", "0530000009")).ok).toBe(true);
    const overlapping = await book(branch.id, svc.id, "2030-03-02T11:59:00.000Z", "0530000010");
    await fx.claimBookingsOf(branch.id);

    expect(overlapping.ok, "a one-minute overlap was allowed").toBe(false);
  });
});

describe("a chair that comes back", () => {
  it("is rebookable once the booking on it is cancelled", async () => {
    // The partial index and the reserve scan both exclude cancelled and
    // no_show. Cancelling used to burn that chair-and-time for everyone.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });

    const first = await book(branch.id, svc.id, SLOT, "0530000011");
    expect(first.ok).toBe(true);
    await fx.claimBookingsOf(branch.id);

    await db
      .update(bookings)
      .set({ status: "cancelled" })
      .where(eq(bookings.id, (first as { bookings: { id: string }[] }).bookings[0].id));

    const second = await book(branch.id, svc.id, SLOT, "0530000012");
    await fx.claimBookingsOf(branch.id);
    expect(second.ok, "a cancelled booking kept its chair").toBe(true);
  });

  it("is not freed by a booking that is merely pending", async () => {
    // A pending hold is unpaid but real: the chair is held. Treating pending as
    // free is how two people are told they have the same 11:00.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });

    const held = await book(branch.id, svc.id, SLOT, "0530000013");
    expect(held.ok).toBe(true);
    await fx.claimBookingsOf(branch.id);

    const second = await book(branch.id, svc.id, SLOT, "0530000014");
    await fx.claimBookingsOf(branch.id);
    expect(second.ok, "an unpaid hold did not hold the chair").toBe(false);
  });

  it("is freed by deactivating it only for new bookings, not retroactively", async () => {
    // reserveStations filters on stations.active. Turning a chair off must not
    // disturb what is already booked on it.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const made = await book(branch.id, svc.id, SLOT, "0530000015");
    expect(made.ok).toBe(true);
    await fx.claimBookingsOf(branch.id);

    const { stations } = await import("@/lib/db/schema");
    await db.update(stations).set({ active: false }).where(eq(stations.id, branch.stations[0].id));

    // Existing booking still stands…
    expect(await liveBookings(branch.id)).toHaveLength(1);
    // …and the branch now has no capacity at all.
    const after = await book(branch.id, svc.id, "2030-03-02T15:00:00.000Z", "0530000016");
    await fx.claimBookingsOf(branch.id);
    expect(after.ok, "a deactivated chair was still sold").toBe(false);
  });
});

describe("times a booking must never be accepted at", () => {
  it("refuses a branch that does not exist", async () => {
    const svc = await fx.service();
    const made = await book(
      "00000000-0000-0000-0000-000000000000",
      svc.id,
      SLOT,
      "0530000020",
    );
    expect(made.ok).toBe(false);
  });

  /**
   * UNCHECKED START TIME — docs/_testing/known-bugs-booking.md BUG-BOOK-001.
   *
   * `POST /api/bookings` validates `startsAt` as a datetime and hands it to
   * `createBookings`, which asks `reserveStations` only whether a chair is
   * free. Nothing on the path asks whether the availability engine would ever
   * have *offered* that moment. The browser only shows real slots, but the
   * route is public HTTP and the body is whatever the caller types.
   *
   * Three shapes below, all currently accepted. Marked `fails` so the day a
   * guard lands they turn green.
   */
  it.fails("refuses the three start times the slot engine would never offer", async () => {
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const long = await fx.service({ durationMin: 90 });

    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const results = {
      past: await book(branch.id, svc.id, yesterday, "0530000017"),
      // The fixture branch opens 10:00–22:00 Riyadh; 04:00 UTC is 07:00 local.
      beforeOpening: await book(branch.id, svc.id, "2030-03-02T04:00:00.000Z", "0530000018"),
      // "The appointment must finish before closing, not merely start before
      // it" — computeDay, lib/availability.ts:202. 21:30 local + 90 runs over.
      pastClosing: await book(branch.id, long.id, "2030-03-02T18:30:00.000Z", "0530000019"),
    };
    await fx.claimBookingsOf(branch.id);

    expect({
      past: results.past.ok,
      beforeOpening: results.beforeOpening.ok,
      pastClosing: results.pastClosing.ok,
    }).toEqual({ past: false, beforeOpening: false, pastClosing: false });
  });

  // @characterization — pins BUG-BOOK-001 as it stands on 2026-09-02, so the
  // behaviour cannot drift in some third direction while the bug is open.
  it("today, all three are written to the books", async () => {
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const long = await fx.service({ durationMin: 90 });

    const past = await book(branch.id, svc.id, new Date(Date.now() - 86_400_000).toISOString(), "0530000021");
    const early = await book(branch.id, svc.id, "2030-03-03T04:00:00.000Z", "0530000022");
    const late = await book(branch.id, long.id, "2030-03-03T18:30:00.000Z", "0530000023");
    await fx.claimBookingsOf(branch.id);

    expect([past.ok, early.ok, late.ok]).toEqual([true, true, true]);
    expect(await liveBookings(branch.id)).toHaveLength(3);
  });

  it("the availability engine, asked directly, offers none of them", async () => {
    // The counterpart to the two above: the engine is right, so the hole is the
    // route trusting a start time instead of asking the engine.
    const { getDayAvailability } = await import("@/lib/availability");
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });

    const day = await getDayAvailability(branch.id, "2030-03-02", svc.durationMin);
    // Slot.startsAt is already ISO UTC — see the Slot type, availability.ts:62.
    const offered = new Set(day.filter((s) => s.available).map((s) => s.startsAt));

    expect(offered.has("2030-03-02T04:00:00.000Z"), "07:00 local was offered").toBe(false);
    expect(offered.size, "the engine offered nothing at all on an open Saturday")
      .toBeGreaterThan(0);
  });
});
