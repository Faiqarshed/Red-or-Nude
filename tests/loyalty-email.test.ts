// Points earned signed out reach the account with that email.
//
// An account is never found from a typed email, so an account holder who
// books as a guest gets a guest record under her own address, and the points
// that booking earns land there. Her account now counts them. Spending still
// needs her to sign in: only a signed-in checkout spends, on the account.

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, loyaltyTxns } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { loyaltyBalance } from "@/lib/loyalty";
import { FUTURE, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;
const PHONE = "0500000094";

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

/** A confirmed guest booking under `email` that earned `points`. */
async function earnedAsGuest(email: string, points: number, slot = 0) {
  const made = await createBookings({
    branchId: f.branchA,
    startsAt: new Date(FUTURE + slot * 3_600_000).toISOString(),
    customer: { phone: PHONE, email },
    source: "web",
    status: "confirmed",
    members: [{ serviceId: f.svcA.id, addonIds: [] }],
  });
  if (!made.ok) throw new Error(made.error);
  const [b] = await db.select().from(bookings).where(eq(bookings.id, made.bookings[0].id));
  await db.insert(loyaltyTxns).values({ customerId: b.customerId!, bookingId: b.id, deltaPoints: points, reason: "earned" });
  return b;
}

const account = async (email: string) =>
  (await db.insert(customers).values({ phone: PHONE, email, emailVerifiedAt: new Date() }).returning())[0];

describe("points earned signed out", () => {
  it("count on the account with that email", async () => {
    const sara = await account("sara@test.local");
    await earnedAsGuest("Sara@Test.local", 50);

    expect(await loyaltyBalance(sara.id)).toBe(50);
  });

  it("do not count on anyone else's account", async () => {
    const noura = await account("noura@test.local");
    await earnedAsGuest("sara@test.local", 50);

    expect(await loyaltyBalance(noura.id)).toBe(0);
  });

  it("add to what the account earned itself", async () => {
    const sara = await account("sara@test.local");
    await db.insert(loyaltyTxns).values({ customerId: sara.id, deltaPoints: 100, reason: "test" });
    await earnedAsGuest("sara@test.local", 50);

    expect(await loyaltyBalance(sara.id)).toBe(150);
  });

  it("leave a guest record counting only its own", async () => {
    await account("sara@test.local");
    await db.insert(loyaltyTxns).values({
      customerId: (await account("other@test.local")).id,
      deltaPoints: 100,
      reason: "test",
    });
    const b = await earnedAsGuest("sara@test.local", 50);

    expect(await loyaltyBalance(b.customerId!)).toBe(50);
  });
});
