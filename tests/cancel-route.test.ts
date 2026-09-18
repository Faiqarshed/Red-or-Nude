// The cancellation route's own fan-out.
//
// The staffing suite next door proves assignIfToday is called once per floor;
// this proves the *route* does it. They are different claims: the route holds
// its own copy of that loop, and a test that reimplements the loop would go on
// passing after somebody deleted it.
//
// Observed rather than spied on. A booking left unassigned at the far branch —
// because the only technician there is busy with the party being cancelled —
// must have a technician by the time the route returns. That can only happen if
// the far branch was re-dealt, which is the fix.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/throttle", () => ({
  throttled: () => false,
  clientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/booking-auth", () => ({
  // The reference alone is not enough in production; who may cancel is a
  // separate concern from what cancelling does, and it is that second half
  // these assertions are about.
  refuseBookingAction: async () => null,
}));

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, settings } from "@/lib/db/schema";
import { createBooking, createBookings } from "@/lib/bookings";
import { assignDay } from "@/lib/assign";
import { POST } from "@/app/api/my-bookings/cancel/route";
import { riyadhDateKey } from "@/lib/time";
import {
  TEST_PHONE,
  fixtures,
  groupRows,
  reset,
  techniciansAt,
  type Fixtures,
} from "./helpers";

let f: Fixtures;

/**
 * A time later today, far enough out to be cancellable.
 *
 * Null when the salon's day has run out — these assertions are about *today*,
 * because assignIfToday does nothing for any other day, and a run started late
 * in the evening has no "later today" left. Skipped rather than faked: moving
 * the clock would be testing a different function than the one that ships.
 */
function laterToday(minutesAhead: number): Date | null {
  const at = new Date(Date.now() + minutesAhead * 60_000);
  return riyadhDateKey(at) === riyadhDateKey(new Date()) ? at : null;
}

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
  // Any booking still in the future may be cancelled, so "later today" does not
  // have to clear the salon's usual three-hour deadline.
  await db
    .insert(settings)
    .values({ key: "cancel_cutoff_hours", value: 0 })
    .onConflictDoUpdate({ target: settings.key, set: { value: 0 } });
});

afterEach(async () => {
  await db.delete(settings).where(eq(settings.key, "cancel_cutoff_hours"));
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/my-bookings/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/my-bookings/cancel", () => {
  it("re-deals the far branch, not only the anchor's", async () => {
    const at = laterToday(120);
    if (!at) return; // no "later today" left; see laterToday.

    const [techB] = await techniciansAt(f.branchB);
    if (!techB) return;

    // The party: one guest here, one at the other salon. Both confirmed, so the
    // dealer hands each floor's technician to them.
    const party = await createBookings({
      branchId: f.branchA,
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
      status: "confirmed",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      ],
    });
    expect(party.ok, party.ok ? "" : party.error).toBe(true);
    if (!party.ok) return;

    await assignDay(f.branchA);
    await assignDay(f.branchB);

    // Someone else at the far branch, overlapping. Every technician there is
    // busy with the party, so she is left on nobody's list.
    const waiting = await createBooking({
      branchId: f.branchB,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(waiting.ok, waiting.ok ? "" : waiting.error).toBe(true);
    if (!waiting.ok) return;

    await assignDay(f.branchB);

    const before = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, waiting.id))
      .limit(1);
    expect(
      before[0].technicianId,
      "the fixture needs her unassigned, or the assertion below proves nothing",
    ).toBeNull();

    // Cancel the party by quoting the guest at *this* branch — so the anchor is
    // branch A and the freed chair is at branch B. That asymmetry is the bug.
    const rows = await groupRows(party.groupId!);
    const anchor = rows.find((r) => r.branchId === f.branchA)!;

    const res = await POST(post({ code: anchor.code }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(2);

    // The technician at the far branch is free now, and the customer who was
    // waiting there has her. Before the fix only branch A was re-dealt and this
    // row still had no technician.
    const [after] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, waiting.id))
      .limit(1);
    expect(
      after.technicianId,
      "the far branch was never re-dealt, so the freed technician went unused",
    ).toBeTruthy();
  });

  it("cancels every guest of the party, wherever she is sitting", async () => {
    const at = laterToday(150);
    if (!at) return;

    const party = await createBookings({
      branchId: f.branchA,
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
      status: "confirmed",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      ],
    });
    expect(party.ok).toBe(true);
    if (!party.ok) return;

    const rows = await groupRows(party.groupId!);
    const res = await POST(post({ code: rows[0].code }));
    expect(res.status).toBe(200);

    const after = await db
      .select()
      .from(bookings)
      .where(
        inArray(
          bookings.id,
          rows.map((r) => r.id),
        ),
      );
    expect(after.every((r) => r.status === "cancelled")).toBe(true);
  });

  it("refuses a second cancellation rather than double-refunding", async () => {
    const at = laterToday(180);
    if (!at) return;

    const made = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const first = await POST(post({ code: made.code }));
    expect(first.status).toBe(200);

    const second = await POST(post({ code: made.code }));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("already-cancelled");
  });

  it("does not release half a party when the other half has arrived", async () => {
    const at = laterToday(200);
    if (!at) return;

    // Two friends on one discounted bill. One of them gets there early and the
    // desk checks her in; the other then cancels from her phone.
    const party = await createBookings({
      branchId: f.branchA,
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
      status: "confirmed",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [] },
      ],
    });
    expect(party.ok, party.ok ? "" : party.error).toBe(true);
    if (!party.ok) return;

    const rows = await groupRows(party.groupId!);
    expect(rows).toHaveLength(2);
    const [arrived, canceller] = rows;

    await db
      .update(bookings)
      .set({ status: "checked_in", updatedAt: new Date() })
      .where(eq(bookings.id, arrived.id));

    const res = await POST(post({ code: canceller.code }));
    const after = await db
      .select()
      .from(bookings)
      .where(
        inArray(
          bookings.id,
          rows.map((r) => r.id),
        ),
      );
    const cancelled = after.filter((r) => r.status === "cancelled");

    // The route says so itself: "A group cancels as a unit. It is one combined
    // bill at a discount that only exists because two people booked together, so
    // releasing half of it would leave the other guest holding a pair price for
    // a solo appointment." Either both go or neither does — a party that is half
    // cancelled is the one outcome the comment rules out.
    expect(
      cancelled.length === 0 || cancelled.length === rows.length,
      `${cancelled.length} of ${rows.length} were cancelled; the party was split` +
        ` (route answered ${res.status})`,
    ).toBe(true);

    // And specifically: refused, in the vocabulary cancelRefusal already uses,
    // rather than half-done and reported as success.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not-cancellable");
    expect(cancelled).toHaveLength(0);
  });

  it("still cancels a whole party when every guest is still waiting", async () => {
    // The other side of the same rule: the guard must refuse a split party, not
    // every party. Nobody has arrived here, so both go.
    const at = laterToday(220);
    if (!at) return;

    const party = await createBookings({
      branchId: f.branchA,
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
      status: "confirmed",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [] },
      ],
    });
    expect(party.ok).toBe(true);
    if (!party.ok) return;

    const rows = await groupRows(party.groupId!);
    const res = await POST(post({ code: rows[0].code }));
    expect(res.status).toBe(200);
    expect((await res.json()).cancelled).toBe(2);
  });

  it("turns away a reference that does not exist", async () => {
    const res = await POST(post({ code: "ZZZZZZ" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("wrong");
  });

  it("rejects a malformed body", async () => {
    const res = await POST(post({ code: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid");
  });
});
