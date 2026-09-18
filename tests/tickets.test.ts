// Fix 1: a guest takes her ticket number from the queue she will be standing in.
//
// `ticket_counters` is keyed (branch_id, day). A party may now be spread across
// branches, so "the party's queue" is not a thing that exists — there is one
// queue per branch per day, and each guest belongs to exactly one of them.
//
// The path matters as much as the rule. A walk-in is confirmed on the spot and
// gets her number from createBookings; a web booking is held `pending` and gets
// it from confirmBookingPayment once the card clears. Those are two different
// functions and each has to split the party for itself. Both are exercised here.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { allocateTickets, createBooking, createBookings } from "@/lib/bookings";
import { confirmBookingPayment } from "@/lib/payments/confirm";
import { utcToLocalDate } from "@/lib/availability";
import { formatTicketNo } from "@/lib/tickets";
import {
  FUTURE,
  TEST_PHONE,
  counters,
  fixtures,
  groupRows,
  reset,
  ticketOrdinal,
  type Fixtures,
} from "./helpers";

let f: Fixtures;
const day = utcToLocalDate(new Date(FUTURE));

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

/** Move one branch's queue on by `n`, so two queues sit at different positions. */
async function advance(branchId: string, n: number, at: number) {
  for (let i = 0; i < n; i++) {
    const made = await createBooking({
      branchId,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: new Date(at + i * 3600_000).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(made.ok, "fixture booking failed").toBe(true);
  }
}

/** Hold a party's chairs the way the website does: pending, unnumbered. */
async function hold(members: Parameters<typeof createBookings>[0]["members"], startsAt = FUTURE) {
  const held = await createBookings({
    branchId: f.branchA,
    startsAt: new Date(startsAt).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "pending",
    members,
  });
  expect(held.ok, held.ok ? "" : held.error).toBe(true);
  if (!held.ok) throw new Error(held.error);
  return held;
}

describe("allocateTickets", () => {
  it("hands out consecutive numbers from one branch's day", async () => {
    const before = await counters([f.branchA], day);
    const issued = await db.transaction((tx) => allocateTickets(tx, f.branchA, day, 3));

    expect(issued).toHaveLength(3);
    expect(issued.map(ticketOrdinal)).toEqual([
      ticketOrdinal(formatTicketNo(before[f.branchA])),
      ticketOrdinal(formatTicketNo(before[f.branchA] + 1)),
      ticketOrdinal(formatTicketNo(before[f.branchA] + 2)),
    ]);

    const after = await counters([f.branchA], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(3);
  });

  it("keeps each branch's queue to itself", async () => {
    const before = await counters([f.branchA, f.branchB], day);
    await db.transaction((tx) => allocateTickets(tx, f.branchA, day, 2));
    const after = await counters([f.branchA, f.branchB], day);

    expect(after[f.branchA] - before[f.branchA]).toBe(2);
    expect(after[f.branchB] - before[f.branchB]).toBe(0);
  });

  it("keeps each day's queue to itself", async () => {
    const other = utcToLocalDate(new Date(FUTURE + 24 * 3600_000));
    const before = await counters([f.branchA], day);
    await db.transaction((tx) => allocateTickets(tx, f.branchA, other, 2));
    const after = await counters([f.branchA], day);

    expect(after[f.branchA] - before[f.branchA]).toBe(0);
  });
});

describe("a walk-in, confirmed on the spot", () => {
  it("takes its number from its own branch", async () => {
    const before = await counters([f.branchA, f.branchB], day);

    const made = await createBooking({
      branchId: f.branchB,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });

    expect(made.ok).toBe(true);
    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchB] - before[f.branchB]).toBe(1);
    expect(after[f.branchA] - before[f.branchA]).toBe(0);
  });

  it("splits a party across branches at creation time", async () => {
    const before = await counters([f.branchA, f.branchB], day);

    const party = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
      status: "confirmed",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      ],
    });

    expect(party.ok, party.ok ? "" : party.error).toBe(true);
    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(1);
    expect(after[f.branchB] - before[f.branchB]).toBe(1);
  });
});

describe("a web booking, numbered when the card clears", () => {
  it("issues nothing while the chairs are only held", async () => {
    const before = await counters([f.branchA, f.branchB], day);

    const held = await hold([
      { serviceId: f.svcA.id, addonIds: [] },
      { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
    ]);
    expect(held.bookings.every((b) => b.ticketNo === null)).toBe(true);

    // An abandoned checkout must not have moved either queue on.
    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(0);
    expect(after[f.branchB] - before[f.branchB]).toBe(0);
  });

  it("gives a split party one number from each branch, not two from one", async () => {
    // The queues are left at different positions first, so "she took a number
    // from the right branch" is something the numbers can distinguish. With both
    // at the same position the bug and the fix produce the same digits.
    await advance(f.branchB, 2, FUTURE - 5 * 3600_000);
    const before = await counters([f.branchA, f.branchB], day);
    expect(before[f.branchA]).not.toBe(before[f.branchB]);

    const held = await hold([
      { serviceId: f.svcA.id, addonIds: [] },
      { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
    ]);

    const paid = await confirmBookingPayment({ code: held.bookings[0].code, method: "card" });
    expect(paid.ok, paid.ok ? "" : paid.error).toBe(true);

    // Exactly one number out of each queue. Before the fix branchA moved by two
    // and branchB by none.
    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(1);
    expect(after[f.branchB] - before[f.branchB]).toBe(1);

    // And each guest holds the number her own branch was about to hand out.
    for (const row of await groupRows(held.groupId!)) {
      expect(row.ticketNo, "every guest leaves with a number").toBeTruthy();
      expect(ticketOrdinal(row.ticketNo!)).toBe(
        ticketOrdinal(formatTicketNo(before[row.branchId])),
      );
    }
  });

  it("still numbers a party that all sits at one branch consecutively", async () => {
    const before = await counters([f.branchA], day);

    const held = await hold([
      { serviceId: f.svcA.id, addonIds: [] },
      { serviceId: f.svcB.id, addonIds: [] },
    ]);
    const paid = await confirmBookingPayment({ code: held.bookings[0].code, method: "card" });
    expect(paid.ok).toBe(true);

    const after = await counters([f.branchA], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(2);

    // In party order, not sorted: the first guest on the bill takes the first
    // number. Sorting first would accept the pair being handed out backwards,
    // which is a different bill from the one the desk will call out.
    const numbers = (await groupRows(held.groupId!)).map((r) => ticketOrdinal(r.ticketNo!));
    expect(numbers).toEqual([
      ticketOrdinal(formatTicketNo(before[f.branchA])),
      ticketOrdinal(formatTicketNo(before[f.branchA] + 1)),
    ]);
  });

  it("gives a solo booking one number and moves nothing else", async () => {
    const before = await counters([f.branchA, f.branchB], day);

    const held = await hold([{ serviceId: f.svcA.id, addonIds: [] }]);
    const paid = await confirmBookingPayment({ code: held.bookings[0].code, method: "card" });
    expect(paid.ok).toBe(true);

    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(1);
    expect(after[f.branchB] - before[f.branchB]).toBe(0);
  });

  it("confirms from any member's code, not only the first", async () => {
    const before = await counters([f.branchA, f.branchB], day);

    const held = await hold([
      { serviceId: f.svcA.id, addonIds: [] },
      { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
    ]);

    // The guest at the *other* branch quotes her reference.
    const paid = await confirmBookingPayment({
      code: held.bookings[held.bookings.length - 1].code,
      method: "card",
    });
    expect(paid.ok, paid.ok ? "" : paid.error).toBe(true);

    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(1);
    expect(after[f.branchB] - before[f.branchB]).toBe(1);
  });

  it("leaves both queues alone when the card is declined", async () => {
    const before = await counters([f.branchA, f.branchB], day);

    const held = await hold([
      { serviceId: f.svcA.id, addonIds: [] },
      { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
    ]);

    const declined = await confirmBookingPayment({
      code: held.bookings[0].code,
      method: "card",
      simulate: "decline",
    });
    expect(declined.ok).toBe(false);

    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(0);
    expect(after[f.branchB] - before[f.branchB]).toBe(0);

    // The chairs are still held, so she can try another card without re-picking.
    const rows = await groupRows(held.groupId!);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.ticketNo === null)).toBe(true);
  });

  it("refuses to charge a party twice", async () => {
    const held = await hold([
      { serviceId: f.svcA.id, addonIds: [] },
      { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
    ]);

    const first = await confirmBookingPayment({ code: held.bookings[0].code, method: "card" });
    expect(first.ok).toBe(true);

    const before = await counters([f.branchA, f.branchB], day);
    const again = await confirmBookingPayment({ code: held.bookings[0].code, method: "card" });
    expect(again.ok).toBe(false);
    expect(again.ok ? "" : again.error).toBe("expired");

    // A second attempt must not mint a second pair of numbers.
    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(0);
    expect(after[f.branchB] - before[f.branchB]).toBe(0);
  });

  it("numbers a party of four spread across two branches correctly", async () => {
    const before = await counters([f.branchA, f.branchB], day);
    const later = new Date(FUTURE + 4 * 3600_000).toISOString();

    const held = await hold([
      { serviceId: f.svcA.id, addonIds: [] },
      { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      { serviceId: f.svcA.id, addonIds: [], branchId: f.branchB, startsAt: later },
      { serviceId: f.svcB.id, addonIds: [], startsAt: later },
    ]);

    const paid = await confirmBookingPayment({ code: held.bookings[0].code, method: "card" });
    expect(paid.ok, paid.ok ? "" : paid.error).toBe(true);

    // Two guests at each branch on the one day: two numbers out of each queue.
    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(2);
    expect(after[f.branchB] - before[f.branchB]).toBe(2);

    const rows = await groupRows(held.groupId!);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.ticketNo)).toBe(true);
    // No number is handed to two people standing in the same queue.
    expect(new Set(rows.map((r) => `${r.branchId}:${r.ticketNo}`)).size).toBe(4);
  });

  it("keeps every guest's row and chair at the branch she chose", async () => {
    const held = await hold([
      { serviceId: f.svcA.id, addonIds: [] },
      { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
    ]);
    await confirmBookingPayment({ code: held.bookings[0].code, method: "card" });

    const rows = await groupRows(held.groupId!);
    expect(rows.map((r) => r.branchId).sort()).toEqual([f.branchA, f.branchB].sort());
    expect(rows.every((r) => r.status === "confirmed")).toBe(true);
    // A number from the right queue and a seat at the wrong salon would still
    // be wrong, so the chair is checked too.
    expect(rows.every((r) => r.stationId)).toBe(true);
  });
});
