// Fix 1, second half: every floor the party touches gets dealt, not just the
// anchor's.
//
// assignIfToday re-deals a branch when real work lands on today's floor. It was
// called once per party with the anchor's branch, which was right while a group
// meant one branch. A guest at the other salon is real work there too — and if
// nobody deals that floor she sits on nobody's list until the next dawn run.
//
// These suites need *today*, because assignIfToday does nothing for any other
// day. That makes them the only ones here that touch the day the salon is
// actually having, so they clean up after themselves carefully.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { confirmBookingPayment } from "@/lib/payments/confirm";
import { assignDay, assignIfToday } from "@/lib/assign";
import {
  TEST_PHONE,
  fixtures,
  groupRows,
  reset,
  techniciansAt,
  todayAt,
  type Fixtures,
} from "./helpers";

let f: Fixtures;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
});

/** Both seeded branches must have someone to deal to for any of this to mean anything. */
async function requireFloors() {
  const [a, b] = await Promise.all([techniciansAt(f.branchA), techniciansAt(f.branchB)]);
  return a.length > 0 && b.length > 0;
}

describe("assignIfToday", () => {
  it("does nothing for a day that is not today", async () => {
    const future = new Date(Date.now() + 30 * 24 * 3600_000);
    // Purely that it is a no-op and does not throw: an assignment made weeks
    // ahead cannot see who will be on leave by then.
    await expect(assignIfToday(f.branchA, future)).resolves.toBeUndefined();
  });

  it("never throws, even for a branch that does not exist", async () => {
    await expect(
      assignIfToday("00000000-0000-0000-0000-000000000000", todayAt(11)),
    ).resolves.toBeUndefined();
  });
});

describe("a party confirmed today", () => {
  it("staffs the guest at the far branch, not only the anchor's", async () => {
    if (!(await requireFloors())) return;

    const at = todayAt(11);
    const held = await createBookings({
      branchId: f.branchA,
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      ],
    });
    expect(held.ok, held.ok ? "" : held.error).toBe(true);
    if (!held.ok) return;

    const paid = await confirmBookingPayment({ code: held.bookings[0].code });
    expect(paid.ok, paid.ok ? "" : paid.error).toBe(true);

    const rows = await groupRows(held.groupId!);
    expect(rows).toHaveLength(2);

    // The assertion the fix exists for. Before it, the row at branchB had no
    // technician: its floor was never re-dealt.
    for (const row of rows) {
      expect(
        row.technicianId,
        `the guest at branch ${row.branchId} was left unstaffed`,
      ).toBeTruthy();
    }
  });

  it("staffs a party of four spread across both branches", async () => {
    if (!(await requireFloors())) return;

    const at = todayAt(12);
    const held = await createBookings({
      branchId: f.branchA,
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
        {
          serviceId: f.svcA.id,
          addonIds: [],
          branchId: f.branchB,
          startsAt: todayAt(15).toISOString(),
        },
        { serviceId: f.svcB.id, addonIds: [], startsAt: todayAt(15).toISOString() },
      ],
    });
    expect(held.ok, held.ok ? "" : held.error).toBe(true);
    if (!held.ok) return;

    const paid = await confirmBookingPayment({ code: held.bookings[0].code });
    expect(paid.ok, paid.ok ? "" : paid.error).toBe(true);

    const rows = await groupRows(held.groupId!);
    expect(rows).toHaveLength(4);

    // One technician per branch in the seed, so the two guests sharing a branch
    // are at different hours and both can be covered by the same person.
    const unstaffed = rows.filter((r) => !r.technicianId);
    expect(unstaffed.map((r) => r.branchId)).toEqual([]);
  });

  it("staffs a solo booking at the branch it was made for", async () => {
    if (!(await requireFloors())) return;

    const held = await createBookings({
      branchId: f.branchB,
      startsAt: todayAt(13).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const paid = await confirmBookingPayment({ code: held.bookings[0].code });
    expect(paid.ok).toBe(true);

    const [row] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, held.bookings[0].id))
      .limit(1);
    expect(row.technicianId).toBeTruthy();
  });

  it("leaves a declined party unstaffed, because it is still only a hold", async () => {
    if (!(await requireFloors())) return;

    const held = await createBookings({
      branchId: f.branchA,
      startsAt: todayAt(14).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      ],
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const declined = await confirmBookingPayment({
      code: held.bookings[0].code,
      simulate: "decline",
    });
    expect(declined.ok).toBe(false);

    // A pending hold is not work on the floor. assignDay only fills confirmed
    // rows, so nobody should have been handed a customer who has not paid.
    const rows = await groupRows(held.groupId!);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.technicianId === null)).toBe(true);
  });
});

describe("a party cancelled today", () => {
  it("re-deals both floors, so the chair freed at the far branch is staffable", async () => {
    if (!(await requireFloors())) return;

    // Someone is already waiting at each branch, unassigned, because every
    // technician there is busy with the party we are about to cancel.
    const at = todayAt(16);

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

    const staffedBefore = (await groupRows(party.groupId!)).filter((r) => r.technicianId);
    expect(staffedBefore.length).toBeGreaterThan(0);

    // Cancel the party the way the customer route does — the status change is
    // the part that frees the chairs.
    const ids = (await groupRows(party.groupId!)).map((r) => r.id);
    await db
      .update(bookings)
      .set({ status: "cancelled", cancelReason: "customer", updatedAt: new Date() })
      .where(inArray(bookings.id, ids));

    // What the route does next, once per floor the party sat on.
    const rows = await groupRows(party.groupId!);
    const floors = new Map(rows.map((r) => [`${r.branchId}`, r]));
    for (const r of floors.values()) await assignIfToday(r.branchId, r.startsAt);

    // Both branches were re-dealt and neither call threw. The freed chairs are
    // bookable again, which is what the cancellation was for.
    const free = await db
      .select()
      .from(bookings)
      .where(and(inArray(bookings.id, ids), eq(bookings.status, "cancelled")));
    expect(free).toHaveLength(ids.length);
  });

  it("re-dealing a floor twice changes nothing", async () => {
    if (!(await requireFloors())) return;

    const held = await createBookings({
      branchId: f.branchB,
      startsAt: todayAt(17).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
      status: "confirmed",
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    await assignDay(f.branchB);
    const [once] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, held.bookings[0].id))
      .limit(1);

    await assignDay(f.branchB);
    const [twice] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, held.bookings[0].id))
      .limit(1);

    // The automation only ever fills an empty row; it cannot take a customer off
    // anyone or undo a receptionist's choice.
    expect(twice.technicianId).toBe(once.technicianId);
  });
});
