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

  it("refuses a booking in the past, at the public route", async () => {
    // BUG-BOOK-001, the half that is fixed. The body is whatever the caller
    // types; the browser's slot picker is not a gate.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const { POST } = await import("@/app/api/bookings/route");
    const { post, read } = await import("../helpers/app");

    const { status, body } = await read(
      await POST(
        post("http://x/api/bookings", {
          branchId: branch.id,
          startsAt: new Date(Date.now() - 86_400_000).toISOString(),
          members: [{ serviceId: svc.id, addonIds: [] }],
          customer: { name: "Time Traveller", phone: "0530000024", email: "t@example.test" },
        }),
      ),
    );
    await fx.claimBookingsOf(branch.id);

    expect({ status, error: body.error }).toEqual({ status: 400, error: "slot-in-past" });
    expect(await liveBookings(branch.id), "a booking for yesterday was written").toHaveLength(0);
  });

  it("still accepts a slot chosen seconds ago and submitted just after it", async () => {
    // The grace. A customer who picks 14:00 and confirms at 14:00:03 had an
    // honestly available slot; refusing that is a bug nobody can reproduce.
    // alwaysOpen because the start time here is the real clock, and this case
    // is about the grace, not about whether the salon is open at that hour.
    const branch = await fx.branch({ stationCount: 1, alwaysOpen: true });
    const svc = await fx.service({ durationMin: 60 });
    const { POST } = await import("@/app/api/bookings/route");
    const { post } = await import("../helpers/app");

    const res = await POST(
      post("http://x/api/bookings", {
        branchId: branch.id,
        startsAt: new Date(Date.now() - 3_000).toISOString(),
        members: [{ serviceId: svc.id, addonIds: [] }],
        customer: { name: "Just In Time", phone: "0530000025", email: "j@example.test" },
      }),
    );
    await fx.claimBookingsOf(branch.id);
    expect(res.status, "a three-second-old slot was refused").not.toBe(400);
  });

  it("still lets the salon seat a walk-in into a chair a no-show just freed", async () => {
    // The flow the guard must NOT break. A no-show frees a slot that has
    // already begun, and the walk-in drawer seats somebody into it — which is
    // why the check lives on the public route and not in createBookings.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const { createBookings } = await import("@/lib/bookings");

    const past = new Date(Date.now() - 30 * 60_000).toISOString();
    const walkIn = await createBookings({
      branchId: branch.id,
      startsAt: past,
      customer: { name: "Walk-in", phone: "0530000026" },
      source: "walk_in",
      status: "confirmed",
      members: [{ serviceId: svc.id, addonIds: [] }],
    });
    await fx.claimBookingsOf(branch.id);

    expect(walkIn.ok, "the salon could not seat a walk-in into a freed chair").toBe(true);
  });

  it("gives the station QR add-on a wider window than the calendar", async () => {
    // Regression guard. The station page freezes startsAt when the sticker is
    // scanned — the current appointment's projected finish, or `now` on an empty
    // chair — and nothing refreshes it while the customer picks a service and
    // fills in the payment form. A two-minute grace refused real customers
    // standing in the salon; ten minutes stale is an ordinary checkout.
    const branch = await fx.branch({ stationCount: 1, alwaysOpen: true });
    const svc = await fx.service({ durationMin: 60 });
    const { POST } = await import("@/app/api/bookings/route");
    const { post, read } = await import("../helpers/app");

    const scannedTenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const body = {
      branchId: branch.id,
      startsAt: scannedTenMinutesAgo,
      members: [{ serviceId: svc.id, addonIds: [] }],
      customer: { name: "In The Chair", phone: "0530000027", email: "c@example.test" },
    };

    // Without a token this is the calendar flow, and ten minutes is refused.
    const plain = await read(await POST(post("http://x/api/bookings", body)));
    expect(plain.status).toBe(400);
    expect(plain.body.error).toBe("slot-in-past");

    // With the chair's own sticker it is the add-on flow, and it goes through.
    const withToken = await POST(
      post("http://x/api/bookings", {
        ...body,
        stationToken: branch.stations[0].qrToken,
      }),
    );
    await fx.claimBookingsOf(branch.id);
    expect(withToken.status, "the add-on flow was refused a ten-minute-old scan").toBe(201);
  });

  it("still refuses a station booking from far enough back to be junk", async () => {
    // The wider window is not an open door: the token is on a public sticker
    // anyone can photograph, so yesterday is still yesterday.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const { POST } = await import("@/app/api/bookings/route");
    const { post, read } = await import("../helpers/app");

    const { status, body } = await read(
      await POST(
        post("http://x/api/bookings", {
          branchId: branch.id,
          startsAt: new Date(Date.now() - 86_400_000).toISOString(),
          members: [{ serviceId: svc.id, addonIds: [] }],
          customer: { name: "Yesterday", phone: "0530000028", email: "y@example.test" },
          stationToken: branch.stations[0].qrToken,
        }),
      ),
    );
    await fx.claimBookingsOf(branch.id);
    expect({ status, error: body.error }).toEqual({ status: 400, error: "slot-in-past" });
  });

  it("does not let a made-up station token buy anything but a 404", async () => {
    // The grace is keyed on the token being present, not valid. A bogus one
    // gets the wider window and is then refused by the station lookup.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const { POST } = await import("@/app/api/bookings/route");
    const { post, read } = await import("../helpers/app");

    const { status, body } = await read(
      await POST(
        post("http://x/api/bookings", {
          branchId: branch.id,
          startsAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          members: [{ serviceId: svc.id, addonIds: [] }],
          customer: { name: "Forger", phone: "0530000029", email: "f@example.test" },
          stationToken: "00000000-0000-0000-0000-000000000000",
        }),
      ),
    );
    await fx.claimBookingsOf(branch.id);
    expect({ status, error: body.error }).toEqual({ status: 404, error: "unknown-station" });
    expect(await liveBookings(branch.id)).toHaveLength(0);
  });

  it("refuses the start times outside the branch's opening hours", async () => {
    // The other half of BUG-BOOK-001. Checked against branch_hours and closures
    // rather than the slot grid, so the station QR add-on — which books at a
    // projected finish time that sits on no grid — is held to the same rule
    // without being refused for missing it.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const long = await fx.service({ durationMin: 90 });
    const { POST } = await import("@/app/api/bookings/route");
    const { post, read } = await import("../helpers/app");

    const send = async (serviceId: string, startsAt: string, phone: string) =>
      read(
        await POST(
          post("http://x/api/bookings", {
            branchId: branch.id,
            startsAt,
            members: [{ serviceId, addonIds: [] }],
            customer: { name: "Out Of Hours", phone, email: "o@example.test" },
          }),
        ),
      );

    // The fixture branch opens 10:00–22:00 Riyadh; 04:00 UTC is 07:00 local.
    const early = await send(svc.id, "2030-03-02T04:00:00.000Z", "0530000030");
    // 21:30 local + 90 minutes runs past the 22:00 close. The appointment must
    // *finish* before closing, not merely start before it.
    const late = await send(long.id, "2030-03-02T18:30:00.000Z", "0530000031");
    await fx.claimBookingsOf(branch.id);

    expect(early.status).toBe(400);
    expect(early.body.error).toBe("outside-hours");
    expect(late.status).toBe(400);
    expect(late.body.error, "an appointment running past closing was sold").toBe("outside-hours");
    expect(await liveBookings(branch.id), "an out-of-hours booking was written").toHaveLength(0);
  });

  it("refuses a day the branch is shut", async () => {
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const { branchHours } = await import("@/lib/db/schema");
    // weekday 0 = Saturday, and 2030-03-02 is a Saturday.
    await db
      .update(branchHours)
      .set({ closed: true })
      .where(and(eq(branchHours.branchId, branch.id), eq(branchHours.weekday, 0)));

    const { POST } = await import("@/app/api/bookings/route");
    const { post, read } = await import("../helpers/app");
    const { status, body } = await read(
      await POST(
        post("http://x/api/bookings", {
          branchId: branch.id,
          startsAt: SLOT,
          members: [{ serviceId: svc.id, addonIds: [] }],
          customer: { name: "Closed Day", phone: "0530000032", email: "c@example.test" },
        }),
      ),
    );
    await fx.claimBookingsOf(branch.id);
    expect({ status, error: body.error }).toEqual({ status: 400, error: "closed-day" });
  });

  it("refuses a booking inside a closure, including an all-branch one", async () => {
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const { closures } = await import("@/lib/db/schema");
    const [eid] = await db
      .insert(closures)
      .values({
        // Null branch = every branch. Eid, not one salon's maintenance day.
        branchId: null,
        startsAt: new Date("2030-03-02T09:00:00.000Z"),
        endsAt: new Date("2030-03-02T15:00:00.000Z"),
      })
      .returning();
    fx.claim(closures, eid.id);

    const { POST } = await import("@/app/api/bookings/route");
    const { post, read } = await import("../helpers/app");
    const { status, body } = await read(
      await POST(
        post("http://x/api/bookings", {
          branchId: branch.id,
          startsAt: SLOT, // 11:00 UTC, inside the closure
          members: [{ serviceId: svc.id, addonIds: [] }],
          customer: { name: "Eid", phone: "0530000033", email: "e@example.test" },
        }),
      ),
    );
    await fx.claimBookingsOf(branch.id);
    expect({ status, error: body.error }).toEqual({ status: 400, error: "closure" });
  });

  it("still lets the counter seat someone outside hours", async () => {
    // enforceOpeningHours is off by default, so the admin walk-in path and the
    // no-show release keep working. This is the flag's whole reason for being.
    const branch = await fx.branch({ stationCount: 1 });
    const svc = await fx.service({ durationMin: 60 });
    const atDawn = await book(branch.id, svc.id, "2030-03-02T04:00:00.000Z", "0530000034");
    await fx.claimBookingsOf(branch.id);
    expect(atDawn.ok, "the counter lost the ability to seat outside hours").toBe(true);
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
