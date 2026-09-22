// A pack credit belongs to one woman's own appointment.
//
// Packs are sold and spent on the solo screen; a pack paying for a group
// booking is out of this phase (docs/SCOPE-ENHANCEMENT.md §8). That was written
// down and enforced by the screen alone, which is not enforcement: the engine
// quoted every guest against the ledger independently and priced them all at
// once, so two guests naming the same purchase both saw the one credit, both
// went to zero, and both wrote a `-1`.
//
// The balance is `SUM(delta)`, so the damage is visible as a negative number —
// which is what most of these assert. A balance below zero is a credit the
// salon gave away and nobody bought.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerPacks, customers, packServices, packTxns, packs } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { buyPack, membershipsLeft, packCredits, packsSpentOn, quotePackCredit } from "@/lib/packs";
import { renderMembershipEmail } from "@/lib/membership-email";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;
let customerId: string;
let packId: string;
const made: string[] = [];

/** A pack holding exactly one credit for one service — the whole hinge. */
async function onePack(quantity = 1) {
  const [pack] = await db
    .insert(packs)
    .values({
      name: { ar: "باقة الاختبار", en: "Test pack" },
      priceHalalas: 50_000,
      validDays: 90,
      active: true,
      sort: 900,
    })
    .returning({ id: packs.id });

  await db
    .insert(packServices)
    .values({ packId: pack.id, serviceId: f.svcA.id, quantity });

  made.push(pack.id);
  return pack.id;
}

/** What she actually has left for the service, straight off the ledger. */
async function balance(serviceId = f.svcA.id) {
  const rows = await packCredits(customerId);
  return rows
    .filter((r) => r.serviceId === serviceId)
    .reduce((sum, r) => sum + r.left, 0);
}

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);

  const [c] = await db
    .insert(customers)
    .values({ phone: TEST_PHONE, name: "Pack tester" })
    .returning({ id: customers.id });
  customerId = c.id;

  packId = await onePack(1);
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
  if (made.length) await db.delete(packs).where(inArray(packs.id, made));
});

describe("buying a pack", () => {
  it("grants exactly what the pack holds", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);

    expect(await balance()).toBe(1);
  });

  it("quotes the credit she owns", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const quote = await quotePackCredit(customerId, bought.customerPackId, f.svcA.id);
    expect(quote.ok).toBe(true);
  });

  it("refuses a credit that is not hers", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const [stranger] = await db
      .insert(customers)
      .values({ phone: "0500000091", name: "Somebody else" })
      .returning({ id: customers.id });

    const quote = await quotePackCredit(stranger.id, bought.customerPackId, f.svcA.id);
    expect(quote.ok).toBe(false);

    await db.delete(customers).where(eq(customers.id, stranger.id));
  });
});

describe("a credit on a solo booking", () => {
  it("pays for the service and spends exactly one", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const made = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId },
      ],
    });

    expect(made.ok, made.ok ? "" : made.error).toBe(true);
    if (!made.ok) return;

    expect(await balance()).toBe(0);
  });


  it("tells her which membership the credit came off, and what is left on it", async () => {
    const bought = await buyPack(customerId, await onePack(3));
    if (!bought.ok) throw new Error(bought.reason);
    const party = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId }],
    });
    if (!party.ok) throw new Error(party.error);

    const spent = await packsSpentOn(party.bookings.map((b) => b.id));
    expect(spent).toEqual([bought.customerPackId]);
    const [left] = await membershipsLeft(customerId, spent);
    expect(left.lines).toEqual([expect.objectContaining({ left: 2, granted: 3 })]);

    // The purchase email says the same numbers.
    const { text } = renderMembershipEmail({ customerName: "Pack tester", lang: "en", priceHalalas: 50_000, taxInvoiceUrl: null, membership: left });
    expect(text).toContain("2 of 3 left");
  });

  it("leaves the balance alone when no credit was offered", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);

    const made = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
    });

    expect(made.ok).toBe(true);
    expect(await balance()).toBe(1);
  });
});

describe("a credit on a group booking is forbidden", () => {
  it("refuses two guests sharing one purchase", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const refused = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId },
        { serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId },
      ],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("pack-not-in-group");
  });

  it("never lets the balance go below zero", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId },
        { serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId },
      ],
    });

    // The assertion the whole guard exists for. She bought one credit; one is
    // what she may spend, and a group booking may not spend it at all.
    expect(await balance()).toBe(1);

    const spends = await db
      .select()
      .from(packTxns)
      .where(eq(packTxns.customerPackId, bought.customerPackId));
    expect(spends.filter((r) => r.delta < 0)).toHaveLength(0);
  });

  it("refuses even when only one guest of four names a pack", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const refused = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [] },
        { serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId },
        { serviceId: f.svcB.id, addonIds: [] },
      ],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("pack-not-in-group");
    expect(await balance()).toBe(1);
  });

  it("refuses before anything is written, seating nobody", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const refused = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      ],
    });
    expect(refused.ok).toBe(false);

    const { bookings } = await import("@/lib/db/schema");
    const rows = await db
      .select()
      .from(bookings)
      .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
    expect(rows, "a refused party leaves no chairs held").toHaveLength(0);
  });

  it("still lets a group book normally when no pack is named", async () => {
    const made = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      customerId,
      source: "web",
      status: "pending",
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
      ],
    });

    expect(made.ok, made.ok ? "" : made.error).toBe(true);
  });
});

describe("the ledger is the only balance", () => {
  it("has no stored balance column to drift from it", async () => {
    const bought = await buyPack(customerId, packId);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const [row] = await db
      .select()
      .from(customerPacks)
      .where(eq(customerPacks.id, bought.customerPackId))
      .limit(1);

    // A purchase snapshots what it cost and when it dies, and nothing else.
    // What is left is summed from pack_txns, never read off this row.
    expect(Object.keys(row)).not.toContain("left");
    expect(Object.keys(row)).not.toContain("balance");
    expect(Object.keys(row)).not.toContain("remaining");
  });
});
