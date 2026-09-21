// The awkward corners.
//
// Three kinds of edge are worth the trouble here, and they are the ones the
// ordinary suites cannot reach:
//
//   - the salon's day is not the UTC day. Riyadh runs three hours ahead with no
//     daylight saving, so every hour between midnight and 03:00 local belongs to
//     yesterday in UTC. Tickets are keyed on the local day and the same-day rule
//     is judged on the local day, so every one of those hours is a chance to key
//     something off the wrong one.
//   - a boundary is a `<` that should be a `<=`. Expiry at the exact instant,
//     a number rolling from A99 to B1, a bill landing on precisely zero.
//   - money reaching zero, which is a number the happy path never produces and
//     the code paths around it have never been asked about.

import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookings, customers, packServices, packTxns, packs } from "@/lib/db/schema";
import { allocateTickets, createBooking, createBookings } from "@/lib/bookings";
import { confirmBookingPayment } from "@/lib/payments/confirm";
import { buyPack, packCredits, quotePackCredit, spendPackCredit } from "@/lib/packs";
import { utcToLocalDate } from "@/lib/availability";
import { formatTicketNo } from "@/lib/tickets";
import { vatIncludedIn } from "@/lib/money";
import { TEST_PHONE, counters, fixtures, groupRows, reset, type Fixtures } from "./helpers";

let f: Fixtures;
const madePacks: string[] = [];

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

/**
 * A wall-clock time in the salon, as the UTC instant it actually is.
 *
 * Riyadh is UTC+3 all year — no daylight saving — so this is a subtraction and
 * not a timezone library. `riyadh(2031, 5, 14, 1, 0)` is 22:00 UTC on the 13th,
 * which is the whole point of the suite below.
 */
const riyadh = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h - 3, min));

const DAY = { y: 2031, m: 7, d: 9 };
const LOCAL_DAY = "2031-07-09";

describe("the salon's day is not the UTC day", () => {
  it("puts a booking just after local midnight on the local day", () => {
    // 00:30 in the salon is 21:30 the previous day in UTC. Everything keyed on
    // the day has to agree it is the 9th.
    const at = riyadh(DAY.y, DAY.m, DAY.d, 0, 30);
    expect(at.toISOString()).toContain("2031-07-08T21:30");
    expect(utcToLocalDate(at)).toBe(LOCAL_DAY);
  });

  it("takes that guest's number from the local day's queue, not yesterday's", async () => {
    const at = riyadh(DAY.y, DAY.m, DAY.d, 0, 30);
    const yesterday = utcToLocalDate(riyadh(DAY.y, DAY.m, DAY.d - 1, 12));
    expect(yesterday).not.toBe(LOCAL_DAY);

    const before = await counters([f.branchA], LOCAL_DAY);
    const beforeYesterday = await counters([f.branchA], yesterday);

    const made = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: at.toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(made.ok, made.ok ? "" : made.error).toBe(true);

    const after = await counters([f.branchA], LOCAL_DAY);
    const afterYesterday = await counters([f.branchA], yesterday);

    expect(after[f.branchA] - before[f.branchA]).toBe(1);
    expect(
      afterYesterday[f.branchA] - beforeYesterday[f.branchA],
      "the number came out of the UTC day's queue",
    ).toBe(0);
  });

  it("counts two guests either side of local midnight as two days", async () => {
    const refused = await createBookings({
      branchId: f.branchA,
      startsAt: riyadh(DAY.y, DAY.m, DAY.d, 23, 30).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        {
          serviceId: f.svcB.id,
          addonIds: [],
          // Half an hour later on the clock, and a different day in the salon.
          startsAt: riyadh(DAY.y, DAY.m, DAY.d + 1, 0, 30).toISOString(),
        },
      ],
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toBe("different-day");
  });

  it("counts two guests either side of UTC midnight as one day", async () => {
    // 01:00 and 03:00 in the salon. In UTC those are 22:00 and 00:00 — different
    // UTC days — but the salon is having one morning, and a party is judged on
    // the salon's day.
    const party = await createBookings({
      branchId: f.branchA,
      startsAt: riyadh(DAY.y, DAY.m, DAY.d, 1).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
      status: "confirmed",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        {
          serviceId: f.svcB.id,
          addonIds: [],
          startsAt: riyadh(DAY.y, DAY.m, DAY.d, 3).toISOString(),
        },
      ],
    });

    expect(party.ok, party.ok ? "" : party.error).toBe(true);
    if (!party.ok) return;

    const rows = await groupRows(party.groupId!);
    expect(rows).toHaveLength(2);
    // Their UTC dates differ; their salon day does not.
    expect(new Set(rows.map((r) => r.startsAt.toISOString().slice(0, 10))).size).toBe(2);
    expect(new Set(rows.map((r) => utcToLocalDate(r.startsAt))).size).toBe(1);
  });

  it("keeps a booking that runs past local midnight on the day it started", async () => {
    const at = riyadh(DAY.y, DAY.m, DAY.d, 23, 30);
    const before = await counters([f.branchA], LOCAL_DAY);

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

    const [row] = await db.select().from(bookings).where(eq(bookings.id, made.id)).limit(1);

    // The service is long enough to finish tomorrow, and her number is still
    // today's — she is standing in tonight's queue.
    expect(utcToLocalDate(row.endsAt)).not.toBe(utcToLocalDate(row.startsAt));
    const after = await counters([f.branchA], LOCAL_DAY);
    expect(after[f.branchA] - before[f.branchA]).toBe(1);
  });

  it("will not seat the next customer in a chair still occupied past midnight", async () => {
    const at = riyadh(DAY.y, DAY.m, DAY.d, 23, 30);
    // Fill every chair with something that runs over midnight.
    for (let i = 0; i < f.chairsA; i++) {
      const made = await createBooking({
        branchId: f.branchA,
        serviceId: f.svcA.id,
        addonIds: [],
        startsAt: at.toISOString(),
        customer: { phone: TEST_PHONE },
        source: "walk_in",
      });
      expect(made.ok).toBe(true);
    }

    // Fifteen minutes after midnight — a different day, the same chairs.
    const next = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: riyadh(DAY.y, DAY.m, DAY.d + 1, 0, 15).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });

    expect(next.ok, "a chair was let out from under a customer still in it").toBe(false);
  });
});

describe("numbers at the letter boundary", () => {
  it("rolls A99 into B1 rather than A100", () => {
    expect(formatTicketNo(1)).toBe("A1");
    expect(formatTicketNo(99)).toBe("A99");
    expect(formatTicketNo(100)).toBe("B1");
    expect(formatTicketNo(198)).toBe("B99");
    expect(formatTicketNo(199)).toBe("C1");
  });

  it("hands out a run that crosses the boundary without repeating itself", async () => {
    const day = "2031-07-20";
    // Walk the counter up to just under a boundary, then take a run across it.
    const before = await counters([f.branchA], day);
    const toBoundary = 99 - ((before[f.branchA] - 1) % 99) - 1;
    if (toBoundary > 0) await db.transaction((tx) => allocateTickets(tx, f.branchA, day, toBoundary));

    const across = await db.transaction((tx) => allocateTickets(tx, f.branchA, day, 3));
    expect(new Set(across).size, "a number repeated across the letter change").toBe(3);
    // The letter must actually change somewhere in that run.
    expect(new Set(across.map((t) => t[0])).size).toBeGreaterThan(1);
  });
});

describe("a bill that lands on exactly zero", () => {
  async function packForWholeService() {
    const [pack] = await db
      .insert(packs)
      .values({
        name: { ar: "باقة", en: "Edge pack" },
        priceHalalas: 50_000,
        validDays: 90,
        active: true,
        sort: 970,
      })
      .returning({ id: packs.id });
    madePacks.push(pack.id);
    await db.insert(packServices).values({ packId: pack.id, serviceId: f.svcA.id, quantity: 1 });

    const [c] = await db
      .insert(customers)
      .values({ phone: TEST_PHONE, name: "Zero" })
      .returning({ id: customers.id });
    const bought = await buyPack(c.id, pack.id);
    if (!bought.ok) throw new Error("fixture pack");
    return { customerId: c.id, customerPackId: bought.customerPackId };
  }

  it("charges nothing, and charges no VAT on nothing", async () => {
    const { customerId, customerPackId } = await packForWholeService();

    const made = await createBookings({
      branchId: f.branchA,
      startsAt: riyadh(DAY.y, DAY.m, DAY.d, 10).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      // No add-ons, no removal: the credit covers the whole of it.
      members: [{ serviceId: f.svcA.id, addonIds: [], customerPackId }],
    });
    expect(made.ok, made.ok ? "" : made.error).toBe(true);
    if (!made.ok) return;

    const [row] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, made.bookings[0].id))
      .limit(1);

    expect(row.totalHalalas).toBe(0);
    expect(row.servicePriceHalalas).toBe(0);
    expect(row.vatHalalas, "VAT was charged on a bill of nothing").toBe(0);
    expect(vatIncludedIn(0, 15)).toBe(0);

    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("still confirms and still issues a number when there is nothing to pay", async () => {
    const { customerId, customerPackId } = await packForWholeService();

    const held = await createBookings({
      branchId: f.branchA,
      startsAt: riyadh(DAY.y, DAY.m, DAY.d, 12).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcA.id, addonIds: [], customerPackId }],
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const paid = await confirmBookingPayment({ code: held.bookings[0].code });

    const [row] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, held.bookings[0].id))
      .limit(1);

    await db.delete(customers).where(eq(customers.id, customerId));

    // A prepaid appointment is still an appointment: she has a chair and a
    // number to be called by, whatever the gateway thinks of a zero charge.
    expect(paid.ok, paid.ok ? "" : `a fully prepaid booking could not confirm: ${paid.error}`).toBe(
      true,
    );
    expect(row.status).toBe("confirmed");
    expect(row.ticketNo).toBeTruthy();
  });
});

describe("expiry, to the instant", () => {
  async function packExpiringAt(validDays: number, boughtAt: Date) {
    const [pack] = await db
      .insert(packs)
      .values({
        name: { ar: "باقة", en: "Expiry pack" },
        priceHalalas: 50_000,
        validDays,
        active: true,
        sort: 980,
      })
      .returning({ id: packs.id });
    madePacks.push(pack.id);
    await db.insert(packServices).values({ packId: pack.id, serviceId: f.svcA.id, quantity: 1 });

    const [c] = await db
      .insert(customers)
      .values({ phone: TEST_PHONE, name: "Expiry" })
      .returning({ id: customers.id });
    const bought = await buyPack(c.id, pack.id, boughtAt);
    if (!bought.ok) throw new Error("fixture pack");

    return {
      customerId: c.id,
      customerPackId: bought.customerPackId,
      expiresAt: new Date(boughtAt.getTime() + validDays * 86_400_000),
    };
  }

  it("is dead on the deadline, not a moment after", async () => {
    const boughtAt = riyadh(DAY.y, DAY.m, DAY.d, 9);
    const { customerId, expiresAt } = await packExpiringAt(30, boughtAt);

    // One millisecond before: hers.
    const alive = await packCredits(customerId, new Date(expiresAt.getTime() - 1));
    expect(alive.filter((c) => c.serviceId === f.svcA.id)).toHaveLength(1);

    // On the deadline exactly: gone. A credit is dead the moment its deadline
    // passes, and "the moment it passes" includes the moment itself.
    const dead = await packCredits(customerId, expiresAt);
    expect(dead.filter((c) => c.serviceId === f.svcA.id)).toHaveLength(0);

    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("refuses to quote a credit on the deadline", async () => {
    const boughtAt = riyadh(DAY.y, DAY.m, DAY.d, 9);
    const { customerId, customerPackId, expiresAt } = await packExpiringAt(30, boughtAt);

    const justAlive = await quotePackCredit(
      customerId,
      customerPackId,
      f.svcA.id,
      new Date(expiresAt.getTime() - 1),
    );
    expect(justAlive.ok).toBe(true);

    const onTheLine = await quotePackCredit(customerId, customerPackId, f.svcA.id, expiresAt);
    expect(onTheLine.ok).toBe(false);

    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("refuses to spend a credit whose purchase has expired", async () => {
    const boughtAt = riyadh(DAY.y, DAY.m, DAY.d, 9);
    const { customerId, customerPackId, expiresAt } = await packExpiringAt(30, boughtAt);

    const seat = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: riyadh(DAY.y, DAY.m, DAY.d, 14).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(seat.ok).toBe(true);
    if (!seat.ok) return;

    // The spend is the authority, not the quote: a purchase that lapsed between
    // the two must not be spendable even though the quote said yes.
    const spent = await db.transaction((tx) =>
      spendPackCredit(tx, customerPackId, f.svcA.id, seat.id, expiresAt),
    );
    expect(spent, "an expired purchase was spent").toBe(false);

    const ledger = await db
      .select()
      .from(packTxns)
      .where(eq(packTxns.customerPackId, customerPackId));
    expect(ledger.filter((r) => r.delta < 0)).toHaveLength(0);

    await db.delete(customers).where(eq(customers.id, customerId));
  });
});

describe("odd shapes the engine still has to price", () => {
  it("does not bill the same add-on twice because the browser sent it twice", async () => {
    const addonRows = await db.select().from(addons).where(eq(addons.atCheckout, false));
    const addon = addonRows[0];
    expect(addon, "the seed has no ordinary add-on to double up").toBeTruthy();
    if (!addon) return;
    expect(addon.priceHalalas, "a free add-on would make this prove nothing").toBeGreaterThan(0);

    const once = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [addon.id],
      startsAt: riyadh(DAY.y, DAY.m, DAY.d, 15).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    await reset(f.branchA, f.branchB);

    const twice = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [addon.id, addon.id],
      startsAt: riyadh(DAY.y, DAY.m, DAY.d, 15).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;

    expect(twice.totalHalalas, "the same add-on was charged twice").toBe(once.totalHalalas);
  });

  it("seats a party of four at one branch only while there are chairs for them", async () => {
    const members = Array.from({ length: 4 }, () => ({
      serviceId: f.svcA.id,
      addonIds: [] as string[],
    }));

    const party = await createBookings({
      branchId: f.branchA,
      startsAt: riyadh(DAY.y, DAY.m, DAY.d, 16).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members,
    });

    if (f.chairsA >= 4) {
      expect(party.ok, party.ok ? "" : party.error).toBe(true);
      if (!party.ok) return;
      const rows = await groupRows(party.groupId!);
      expect(new Set(rows.map((r) => r.stationId)).size, "two guests share a chair").toBe(4);
    } else {
      expect(party.ok).toBe(false);
      expect(party.ok ? "" : party.error).toBe("slot-taken");
      const left = await db
        .select()
        .from(bookings)
        .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
      expect(left).toHaveLength(0);
    }
  });
});
