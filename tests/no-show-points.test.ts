// A no-show is a booking she paid for, so its points are hers either way:
// what she earned on it counts, and what she spent on it stays spent
// (CLAUDE.md, "Cancel, reschedule, no-show"). isDead used to treat a no-show
// like a cancellation, voiding both. Only a cancellation, where her money comes
// back to her, still takes earned points back.

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, loyaltyTxns } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { loyaltyBalance } from "@/lib/loyalty";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;
let customerId: string;
let bookingId: string;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
  const [c] = await db.insert(customers).values({ phone: TEST_PHONE }).returning({ id: customers.id });
  customerId = c.id;
  const made = await createBookings({
    branchId: f.branchA,
    startsAt: new Date(FUTURE).toISOString(),
    customer: { phone: TEST_PHONE },
    customerId,
    source: "web",
    status: "confirmed",
    members: [{ serviceId: f.svcA.id, addonIds: [] }],
  });
  if (!made.ok) throw new Error(made.error);
  bookingId = made.bookings[0].id;

  // 100 points from long ago, 50 of them spent on this booking.
  await db.insert(loyaltyTxns).values([
    { customerId, deltaPoints: 100, reason: "test" },
    { customerId, bookingId, deltaPoints: -50, reason: "reward" },
  ]);
});

const end = (set: Partial<typeof bookings.$inferInsert>) =>
  db.update(bookings).set(set).where(eq(bookings.id, bookingId));

describe("points spent on a booking", () => {
  it("stay spent when the desk marks her a no-show", async () => {
    await end({ status: "no_show" });
    expect(await loyaltyBalance(customerId)).toBe(50);
  });

  it("stay spent when the sweep flagged her and the desk closed it", async () => {
    // sweepNoShows, then resolveNoShow.
    await end({ status: "cancelled", noShowAt: new Date(), noShowResolvedAt: new Date() });
    expect(await loyaltyBalance(customerId)).toBe(50);
  });

  it("come back when she cancels", async () => {
    await end({ status: "cancelled" });
    expect(await loyaltyBalance(customerId)).toBe(100);
  });

});

describe("points earned on a booking", () => {
  beforeEach(async () => {
    await db.insert(loyaltyTxns).values({ customerId, bookingId, deltaPoints: 50, reason: "earned" });
  });

  it("count when the desk marks her a no-show: she paid for it", async () => {
    await end({ status: "no_show" });
    expect(await loyaltyBalance(customerId)).toBe(100);
  });

  it("count when the sweep flagged her and the desk closed it", async () => {
    await end({ status: "cancelled", noShowAt: new Date(), noShowResolvedAt: new Date() });
    expect(await loyaltyBalance(customerId)).toBe(100);
  });

  it("go when she cancels, as her spend comes back", async () => {
    await end({ status: "cancelled" });
    expect(await loyaltyBalance(customerId)).toBe(100);
  });
});
