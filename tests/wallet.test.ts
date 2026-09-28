// The wallet's ground floor: who a guest is, and a ledger that cannot be spent
// twice (docs/WALLET-PLAN.md, build step 1).
//
// A guest is her email. The customer row used to be one per phone, with the
// email overwritten by every booking, so credit tagged from it could name the
// wrong person. Each booking now carries the email it was made under.
//
// The balance is SUM(delta) over one customer and one email. Every spend goes
// through spendWallet, under the customer row lock, and every repeat of a
// write is refused by a unique index rather than by a read before it.

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, walletTxns } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { releaseSpend, spendWallet, walletBalance } from "@/lib/wallet";
import { FUTURE, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;

const PHONE = "0500000091";
const OTHER_PHONE = "0500000092";

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

/** One web booking, an hour apart per `slot` so no two share a chair. */
async function book(
  customer: { phone: string; email?: string; name?: string },
  slot = 0,
  customerId?: string,
) {
  const r = await createBookings({
    branchId: f.branchA,
    startsAt: new Date(FUTURE + slot * 3_600_000).toISOString(),
    customer,
    customerId,
    source: "web",
    status: "pending",
    members: [{ serviceId: f.svcA.id, addonIds: [] }],
  });
  if (!r.ok) throw new Error(`booking refused: ${r.error}`);
  const [row] = await db.select().from(bookings).where(eq(bookings.id, r.bookings[0].id));
  return row;
}

async function credit(customerId: string, ownerEmail: string, halalas: number) {
  await db
    .insert(walletTxns)
    .values({ customerId, ownerEmail, deltaHalalas: halalas, reason: "correction", note: "test" });
}

const testCustomers = () =>
  db.select().from(customers).where(like(customers.phone, "050000009%"));

describe("a guest is her email", () => {
  it("keeps two people who share a phone apart", async () => {
    const sara = await book({ phone: PHONE, email: "sara@test.local", name: "Sara" }, 0);
    const noura = await book({ phone: PHONE, email: "noura@test.local", name: "Noura" }, 1);

    expect(sara.customerId).not.toBe(noura.customerId);
    expect(sara.customerEmail).toBe("sara@test.local");
    expect(noura.customerEmail).toBe("noura@test.local");

    // Noura's booking left Sara's row alone.
    const [saraRow] = await db.select().from(customers).where(eq(customers.id, sara.customerId!));
    expect(saraRow.email).toBe("sara@test.local");
  });

  it("finds a returning guest by her email, whatever phone she typed", async () => {
    const first = await book({ phone: PHONE, email: "Sara@Test.local" }, 0);
    const again = await book({ phone: OTHER_PHONE, email: "sara@test.local" }, 1);

    expect(again.customerId).toBe(first.customerId);
    expect(first.customerEmail).toBe("sara@test.local");
  });

  it("gives an old walk-in record her email instead of making a new one", async () => {
    const [walkIn] = await db
      .insert(customers)
      .values({ phone: PHONE, name: "Fatima" })
      .returning();

    const online = await book({ phone: PHONE, email: "fatima@test.local" });

    expect(online.customerId).toBe(walkIn.id);
    const rows = await testCustomers();
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("fatima@test.local");
  });

  it("prefers her email's record over a walk-in record with her phone", async () => {
    const emailed = await book({ phone: OTHER_PHONE, email: "fatima@test.local" }, 0);
    const [walkIn] = await db.insert(customers).values({ phone: PHONE }).returning();

    const online = await book({ phone: PHONE, email: "fatima@test.local" }, 1);

    expect(online.customerId).toBe(emailed.customerId);
    const [untouched] = await db.select().from(customers).where(eq(customers.id, walkIn.id));
    expect(untouched.email).toBeNull();
  });

  it("makes one record when the same new email books twice at once", async () => {
    const both = await Promise.all([
      book({ phone: PHONE, email: "race@test.local" }, 0),
      book({ phone: OTHER_PHONE, email: "race@test.local" }, 1),
    ]);

    expect(both[0].customerId).toBe(both[1].customerId);
    expect(await testCustomers()).toHaveLength(1);
  });

  it("tags a signed-in booking with her account's email, not the form's", async () => {
    const [account] = await db
      .insert(customers)
      .values({ phone: PHONE, email: "account@test.local", emailVerifiedAt: new Date() })
      .returning();

    const row = await book({ phone: PHONE, email: "typed@test.local" }, 0, account.id);

    expect(row.customerId).toBe(account.id);
    expect(row.customerEmail).toBe("account@test.local");
  });
});

describe("the ledger", () => {
  async function guest(email = "sara@test.local", slot = 0) {
    const b = await book({ phone: PHONE, email }, slot);
    return { customerId: b.customerId!, bookingId: b.id };
  }

  it("counts only the rows of her email, and never shows a debt", async () => {
    const { customerId } = await guest();
    await credit(customerId, "sara@test.local", 30_000);
    await credit(customerId, "someone-else@test.local", 99_900);

    expect(await walletBalance(customerId, "Sara@Test.local")).toEqual({ total: 30_000, available: 30_000 });

    await credit(customerId, "sara@test.local", -45_000);
    expect(await walletBalance(customerId, "sara@test.local")).toEqual({ total: -15_000, available: 0 });
  });

  it("spends what she has and refuses a halala more", async () => {
    const { customerId, bookingId } = await guest();
    await credit(customerId, "sara@test.local", 10_000);

    const refused = await db.transaction((tx) =>
      spendWallet(tx, customerId, "sara@test.local", 10_001, { bookingId }),
    );
    expect(refused).toBeNull();
    expect((await walletBalance(customerId, "sara@test.local")).total).toBe(10_000);

    const spent = await db.transaction((tx) =>
      spendWallet(tx, customerId, "sara@test.local", 10_000, { bookingId }),
    );
    expect(spent).toEqual(expect.any(String));
    const [row] = await db.select().from(walletTxns).where(eq(walletTxns.id, spent!));
    expect(row).toMatchObject({ deltaHalalas: -10_000, reason: "spend", bookingId });
    expect(await walletBalance(customerId, "sara@test.local")).toEqual({ total: 0, available: 0 });
  });

  it("lets only one of two checkouts at once spend one balance", async () => {
    const { customerId, bookingId } = await guest("sara@test.local", 0);
    const second = await book({ phone: PHONE, email: "sara@test.local" }, 1);
    await credit(customerId, "sara@test.local", 30_000);

    const results = await Promise.all(
      [bookingId, second.id].map((id) =>
        db.transaction((tx) => spendWallet(tx, customerId, "sara@test.local", 30_000, { bookingId: id })),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await walletBalance(customerId, "sara@test.local")).toEqual({ total: 0, available: 0 });
  });

  it("refuses a second spend on the same booking", async () => {
    const { customerId, bookingId } = await guest();
    await credit(customerId, "sara@test.local", 50_000);

    await db.transaction((tx) => spendWallet(tx, customerId, "sara@test.local", 10_000, { bookingId }));
    await expect(
      db.transaction((tx) => spendWallet(tx, customerId, "sara@test.local", 10_000, { bookingId })),
    ).rejects.toThrow();
    expect((await walletBalance(customerId, "sara@test.local")).total).toBe(40_000);
  });

  it("gives a spend back once, however many times it is released", async () => {
    const { customerId, bookingId } = await guest();
    await credit(customerId, "sara@test.local", 20_000);
    const spent = await db.transaction((tx) =>
      spendWallet(tx, customerId, "sara@test.local", 15_000, { bookingId }),
    );

    await db.transaction((tx) => releaseSpend(tx, spent!));
    await db.transaction((tx) => releaseSpend(tx, spent!));

    const releases = await db
      .select()
      .from(walletTxns)
      .where(and(eq(walletTxns.reason, "release"), eq(walletTxns.reversesId, spent!)));
    expect(releases).toHaveLength(1);
    expect(releases[0].deltaHalalas).toBe(15_000);
    expect((await walletBalance(customerId, "sara@test.local")).total).toBe(20_000);
  });

  it("takes a released spend again once, for a checkout that turned up paid", async () => {
    const { customerId, bookingId } = await guest();
    await credit(customerId, "sara@test.local", 20_000);
    const spent = await db.transaction((tx) =>
      spendWallet(tx, customerId, "sara@test.local", 15_000, { bookingId }),
    );
    await db.transaction((tx) => releaseSpend(tx, spent!));
    const [release] = await db.select().from(walletTxns).where(eq(walletTxns.reversesId, spent!));

    const again = await db.transaction((tx) =>
      spendWallet(tx, customerId, "sara@test.local", 15_000, { bookingId, reSpendOf: release.id }),
    );
    expect(again).toEqual(expect.any(String));
    expect((await walletBalance(customerId, "sara@test.local")).total).toBe(5_000);

    await expect(
      db.transaction((tx) =>
        spendWallet(tx, customerId, "sara@test.local", 5_000, { bookingId, reSpendOf: release.id }),
      ),
    ).rejects.toThrow();
  });
});
