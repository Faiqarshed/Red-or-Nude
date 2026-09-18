// Two people, one chair. Two tabs, one credit. Two taps, one card.
//
// Everything here runs requests genuinely in parallel and asserts the invariant
// that must hold however the race lands. These are the assertions that cannot be
// made by calling a function once, and they are where the interesting bugs are:
// a check that reads before it writes is correct every time you test it by hand.

import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, packServices, packTxns, packs, payments } from "@/lib/db/schema";
import { createBooking, createBookings, allocateTickets } from "@/lib/bookings";
import { confirmBookingPayment } from "@/lib/payments/confirm";
import { buyPack, packCredits, spendPackCredit } from "@/lib/packs";
import { utcToLocalDate } from "@/lib/availability";
import { FUTURE, TEST_PHONE, counters, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;
const madePacks: string[] = [];
const day = utcToLocalDate(new Date(FUTURE));

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

describe("chairs", () => {
  it("seats exactly as many as there are chairs, however the race lands", async () => {
    const attempts = f.chairsA + 3;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        createBooking({
          branchId: f.branchA,
          serviceId: f.svcA.id,
          addonIds: [],
          startsAt: new Date(FUTURE).toISOString(),
          customer: { phone: TEST_PHONE },
          source: "web",
        }),
      ),
    );

    const seated = results.filter((r) => r.ok);
    expect(seated).toHaveLength(f.chairsA);

    // And no chair is holding two of them.
    const rows = await db.select().from(bookings).where(eq(bookings.branchId, f.branchA));
    const chairs = rows.map((r) => r.stationId);
    expect(new Set(chairs).size).toBe(chairs.length);
  });

  it("never seats two parties in the same chair when both are split the same way", async () => {
    const both = await Promise.all([
      createBookings({
        branchId: f.branchA,
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE },
        source: "web",
        status: "pending",
        members: [
          { serviceId: f.svcA.id, addonIds: [] },
          { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
        ],
      }),
      createBookings({
        branchId: f.branchA,
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE },
        source: "web",
        status: "pending",
        members: [
          { serviceId: f.svcA.id, addonIds: [] },
          { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
        ],
      }),
    ]);

    const ok = both.filter((r) => r.ok);
    expect(ok.length).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(bookings)
      .where(inArray(bookings.branchId, [f.branchA, f.branchB]));

    // Overlapping bookings must never share a chair.
    const byChair = new Map<string, { s: number; e: number }[]>();
    for (const r of rows) {
      const at = byChair.get(r.stationId!) ?? [];
      for (const held of at) {
        const overlaps = r.startsAt.getTime() < held.e && held.s < r.endsAt.getTime();
        expect(overlaps, `chair ${r.stationId} double-booked`).toBe(false);
      }
      at.push({ s: r.startsAt.getTime(), e: r.endsAt.getTime() });
      byChair.set(r.stationId!, at);
    }
  });

  it("a party is all-or-nothing even when it loses the race", async () => {
    // Fill branch B to one free chair, then send two parties that both need it.
    for (let i = 0; i < f.chairsB - 1; i++) {
      const filled = await createBooking({
        branchId: f.branchB,
        serviceId: f.svcA.id,
        addonIds: [],
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE },
        source: "walk_in",
      });
      expect(filled.ok).toBe(true);
    }

    const parties = await Promise.all(
      [0, 1].map(() =>
        createBookings({
          branchId: f.branchA,
          startsAt: new Date(FUTURE).toISOString(),
          customer: { phone: TEST_PHONE },
          source: "web",
          status: "pending",
          members: [
            { serviceId: f.svcA.id, addonIds: [] },
            { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
          ],
        }),
      ),
    );

    // Only one of them could have had the last chair at B.
    expect(parties.filter((p) => p.ok)).toHaveLength(1);

    // The loser left nothing behind at either branch — no half-seated party.
    const groups = await db
      .select()
      .from(bookings)
      .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
    const byGroup = new Map<string, number>();
    for (const r of groups.filter((g) => g.groupId)) {
      byGroup.set(r.groupId!, (byGroup.get(r.groupId!) ?? 0) + 1);
    }
    for (const [, n] of byGroup) expect(n).toBe(2);
  });
});

describe("ticket numbers", () => {
  it("hands the same number to nobody twice under parallel load", async () => {
    const runs = 8;
    const before = await counters([f.branchA], day);

    const batches = await Promise.all(
      Array.from({ length: runs }, () =>
        db.transaction((tx) => allocateTickets(tx, f.branchA, day, 2)),
      ),
    );

    const all = batches.flat();
    expect(all).toHaveLength(runs * 2);
    expect(new Set(all).size, "a ticket number was issued twice").toBe(all.length);

    const after = await counters([f.branchA], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(runs * 2);
  });
});

describe("paying", () => {
  // This was a real double charge until `payments_booking_live_unique` landed:
  // both taps read the party as pending, both charged the card and both
  // confirmed, for exactly twice the bill. The status read could not stop it —
  // it is a read, and the other tab moves between it and the write.
  //
  // The rows that claim a party are now written before the charge, so the loser
  // is refused by the database with nothing yet taken from the customer.
  it("charges a party once when the button is tapped twice", async () => {
    const held = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
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

    const before = await counters([f.branchA, f.branchB], day);

    const [a, b] = await Promise.all([
      confirmBookingPayment({ code: held.bookings[0].code, method: "card" }),
      confirmBookingPayment({ code: held.bookings[0].code, method: "card" }),
    ]);

    // Exactly one of the two taps may confirm.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);

    // The loser is told why, and it is not "expired" — nothing has gone stale,
    // somebody else is simply already paying.
    const loser = a.ok ? b : a;
    expect(loser.ok ? "" : loser.error).toBe("in-progress");

    // And exactly one number came out of each queue, not two.
    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(1);
    expect(after[f.branchB] - before[f.branchB]).toBe(1);

    const rows = await db
      .select()
      .from(bookings)
      .where(eq(bookings.groupId, held.groupId!));
    expect(rows.every((r) => r.status === "confirmed")).toBe(true);
    expect(new Set(rows.map((r) => r.ticketNo)).size).toBe(rows.length);

    // The assertion this whole fix is for: she paid the bill, not twice the
    // bill. Counted off `payments` rather than the return value, because the
    // money is what the argument was about.
    const paid = await db
      .select()
      .from(payments)
      .where(
        inArray(
          payments.bookingId,
          rows.map((r) => r.id),
        ),
      );
    const taken = paid.filter((p) => p.status === "paid");
    expect(taken.reduce((sum, p) => sum + p.amountHalalas, 0)).toBe(
      rows.reduce((sum, r) => sum + r.totalHalalas, 0),
    );
    // One live row per booking, which is the rule the index states.
    expect(new Set(taken.map((p) => p.bookingId)).size).toBe(taken.length);
  });

  it("lets her try another card after one is declined", async () => {
    // The index must not wall a customer out of her own booking: a `failed` row
    // is outside its predicate, so the retry writes a fresh one beside it.
    const held = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const declined = await confirmBookingPayment({
      code: held.bookings[0].code,
      method: "card",
      simulate: "decline",
    });
    expect(declined.ok).toBe(false);
    expect(declined.ok ? "" : declined.error).toBe("payment-declined");

    const second = await confirmBookingPayment({ code: held.bookings[0].code, method: "card" });
    expect(second.ok, second.ok ? "" : second.error).toBe(true);
  });
});

describe("pack credits under parallel load", () => {
  async function customerWithOneCredit() {
    const [pack] = await db
      .insert(packs)
      .values({
        name: { ar: "باقة", en: "Race pack" },
        priceHalalas: 50_000,
        validDays: 90,
        active: true,
        sort: 950,
      })
      .returning({ id: packs.id });
    madePacks.push(pack.id);
    await db.insert(packServices).values({ packId: pack.id, serviceId: f.svcA.id, quantity: 1 });

    const [c] = await db
      .insert(customers)
      .values({ phone: TEST_PHONE, name: "Racer" })
      .returning({ id: customers.id });

    const bought = await buyPack(c.id, pack.id);
    if (!bought.ok) throw new Error("fixture pack could not be bought");
    return { customerId: c.id, customerPackId: bought.customerPackId };
  }

  const balance = async (customerId: string) =>
    (await packCredits(customerId))
      .filter((r) => r.serviceId === f.svcA.id)
      .reduce((sum, r) => sum + r.left, 0);

  it("a group booking cannot spend one at all, however many ask", async () => {
    const { customerId, customerPackId } = await customerWithOneCredit();

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        createBookings({
          branchId: f.branchA,
          startsAt: new Date(FUTURE).toISOString(),
          customer: { phone: TEST_PHONE },
          customerId,
          source: "web",
          status: "pending",
          members: [
            { serviceId: f.svcA.id, addonIds: [], customerPackId },
            { serviceId: f.svcA.id, addonIds: [], customerPackId },
          ],
        }),
      ),
    );

    expect(results.every((r) => !r.ok)).toBe(true);
    expect(await balance(customerId)).toBe(1);

    await db.delete(customers).where(eq(customers.id, customerId));
  });

  // The narrow half of the pack-credit problem, and the one a guard in code
  // could not reach: two tabs, both solo, both naming the one credit. The quote
  // read the ledger before either had written to it, so both were told yes, and
  // the unique index is keyed on the booking — two different bookings walk
  // straight past it.
  //
  // Closed by locking the purchase row inside the booking transaction and
  // recounting underneath it, so the second caller waits, counts, and finds
  // nothing.
  //
  // One booking at each branch, which matters more than it looks. reserveStations
  // takes `FOR UPDATE` on every chair at a branch, so two bookings at the *same*
  // branch are serialised by the chair lock whatever the pack code does — and an
  // earlier version of this test, written that way, went on passing with the
  // purchase lock deleted. Different branches lock disjoint sets of chairs, so
  // the only thing left holding these two apart is the lock under test.
  it("two solo bookings racing for one credit: only one gets it", async () => {
    const { customerId, customerPackId } = await customerWithOneCredit();

    const results = await Promise.all(
      [f.branchA, f.branchB].map((branchId) =>
        createBookings({
          branchId,
          startsAt: new Date(FUTURE + 3600_000).toISOString(),
          customer: { phone: TEST_PHONE },
          customerId,
          source: "web",
          status: "pending",
          members: [{ serviceId: f.svcA.id, addonIds: [], customerPackId }],
        }),
      ),
    );

    const seated = results.filter((r) => r.ok);
    const spends = await db
      .select()
      .from(packTxns)
      .where(eq(packTxns.customerPackId, customerPackId));
    const taken = spends.filter((r) => r.delta < 0).length;
    const left = await balance(customerId);

    // Which of the seated bookings were actually given away.
    const free = seated.length
      ? await db
          .select({ price: bookings.servicePriceHalalas })
          .from(bookings)
          .where(
            inArray(
              bookings.id,
              seated.flatMap((r) => (r.ok ? r.bookings.map((b) => b.id) : [])),
            ),
          )
      : [];

    await db.delete(customers).where(eq(customers.id, customerId));

    // Two outcomes are both correct, and which one happens is a matter of
    // microseconds: the loser is refused with `pack-credit-gone`, or her quote
    // ran late enough to see the credit already gone and she is simply charged
    // full price. Asserting either one specifically makes this test flaky, so it
    // asserts what must hold in both.
    //
    // She bought one credit. The ledger may not hand out more than that...
    expect(
      taken,
      `${seated.length} bookings were seated and ${taken} credits were spent from a pack holding 1`,
    ).toBeLessThanOrEqual(1);
    expect(left, "the balance went past zero").toBeGreaterThanOrEqual(0);

    // ...and no service is given away without a credit coming off for it. This
    // is the one that would catch a free appointment, whichever way the race fell.
    expect(
      free.filter((b) => b.price === 0).length,
      "a service was given away with no credit spent for it",
    ).toBe(taken);
  });

  // The lock itself, with the booking engine taken out of the picture.
  //
  // The end-to-end test above cannot prove the lock is load-bearing: the quote
  // that precedes it usually resolves the race on its own, and reserveStations
  // takes `FOR UPDATE` on every chair at a branch, which serialises anything
  // sharing one. This calls spendPackCredit directly, in two real transactions,
  // against one purchase holding one credit — so the lock is the only thing that
  // can decide it, and deleting the lock makes this fail.
  it("two transactions spending the same credit: the lock lets exactly one through", async () => {
    const { customerId, customerPackId } = await customerWithOneCredit();

    const seats = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE + 2 * 3600_000).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [] },
      ],
    });
    expect(seats.ok, seats.ok ? "" : seats.error).toBe(true);
    if (!seats.ok) return;

    // Two different bookings, so the per-booking unique index cannot be what
    // refuses the second one.
    const [first, second] = seats.bookings.map((b) => b.id);

    const both = await Promise.all(
      [first, second].map((bookingId) =>
        db.transaction((tx) => spendPackCredit(tx, customerPackId, f.svcA.id, bookingId)),
      ),
    );

    const after = await balance(customerId);
    await db.delete(customers).where(eq(customers.id, customerId));

    expect(both.filter(Boolean), "both transactions spent the one credit").toHaveLength(1);
    expect(after).toBe(0);
  });
});
