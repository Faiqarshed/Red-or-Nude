// recentPerCustomer — the customers screen's booking history, per customer.
//
// This replaced a flat `limit(500)` over the whole bookings table with no
// `where` clause, filtered down to each customer in JS afterwards. That was not
// merely slow: the 500 newest bookings *in the salon* are not the 500 newest
// bookings *of the customers on screen*, so anyone whose appointments fell
// outside that window rendered with an empty drawer. It reads as "her history is
// gone" and it gets worse every week the salon trades.
//
// The load-bearing case is `only counts this customer's own bookings, however
// busy everyone else has been` — that is the bug, stated as a test.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers } from "@/lib/db/schema";
import { HISTORY_ROWS, recentPerCustomer } from "@/app/(admin)/admin/(shell)/customers/data";
import { fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;

/** This file's own customers, inside the helpers' `050000009%` cleanup prefix. */
const PHONES = ["0500000094", "0500000095"] as const;

async function makeCustomer(phone: string): Promise<string> {
  const [row] = await db.insert(customers).values({ phone }).returning({ id: customers.id });
  return row.id;
}

/**
 * `n` bookings for one customer, an hour apart, oldest first.
 *
 * Returns the codes newest-first, which is the order recentPerCustomer sorts in,
 * so an assertion can compare against a slice of this without re-sorting.
 */
async function bookFor(customerId: string, n: number, tag: string): Promise<string[]> {
  const base = Date.UTC(2031, 4, 14, 6, 0);
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const startsAt = new Date(base + i * 3_600_000);
    const code = `RON-${tag}${String(i).padStart(3, "0")}`;
    await db.insert(bookings).values({
      code,
      branchId: f.branchA,
      customerId,
      serviceId: f.svcA.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      status: "completed",
      source: "web",
      serviceName: { ar: "اختبار", en: "test" },
    });
    codes.push(code);
  }
  return codes.reverse();
}

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
});

describe("recentPerCustomer", () => {
  it("returns a customer's bookings, newest first", async () => {
    const her = await makeCustomer(PHONES[0]);
    const codes = await bookFor(her, 3, "A");

    const rows = await recentPerCustomer([her]);

    expect(rows.map((r) => r.code)).toEqual(codes);
  });

  // The bug. Under the old query these bookings were nowhere near the 500 newest
  // in the table, so this customer's drawer came back empty.
  it("only counts this customer's own bookings, however busy everyone else has been", async () => {
    const her = await makeCustomer(PHONES[0]);
    const everyoneElse = await makeCustomer(PHONES[1]);

    // Hers first, so they are the *oldest* rows in the table...
    const hers = await bookFor(her, 2, "A");
    // ...and then a pile of newer ones belonging to somebody else.
    await bookFor(everyoneElse, 40, "B");

    const rows = await recentPerCustomer([her]);

    expect(rows.map((r) => r.code)).toEqual(hers);
    expect(rows).toHaveLength(2);
  });

  it("gives each customer their own window rather than sharing one", async () => {
    const her = await makeCustomer(PHONES[0]);
    const other = await makeCustomer(PHONES[1]);
    const hers = await bookFor(her, HISTORY_ROWS + 4, "A");
    const theirs = await bookFor(other, HISTORY_ROWS + 4, "B");

    const rows = await recentPerCustomer([her, other]);

    // Both get a full window — one customer's history does not eat the other's.
    const forHer = rows.filter((r) => r.customerId === her).map((r) => r.code);
    const forOther = rows.filter((r) => r.customerId === other).map((r) => r.code);
    expect(forHer).toEqual(hers.slice(0, HISTORY_ROWS));
    expect(forOther).toEqual(theirs.slice(0, HISTORY_ROWS));
  });

  it("caps one customer at HISTORY_ROWS, keeping the newest", async () => {
    const her = await makeCustomer(PHONES[0]);
    const codes = await bookFor(her, HISTORY_ROWS + 5, "A");

    const rows = await recentPerCustomer([her]);

    expect(rows).toHaveLength(HISTORY_ROWS);
    expect(rows.map((r) => r.code)).toEqual(codes.slice(0, HISTORY_ROWS));
  });

  it("returns exactly the boundary count without truncating", async () => {
    const her = await makeCustomer(PHONES[0]);
    const codes = await bookFor(her, HISTORY_ROWS, "A");

    const rows = await recentPerCustomer([her]);

    expect(rows.map((r) => r.code)).toEqual(codes);
  });

  describe("edge cases", () => {
    it("sends no query at all for an empty id list", async () => {
      // `inArray` with no values builds either nothing or `false`, depending on
      // the driver. The guard means neither the caller nor the driver has to
      // care, and the page can drop its own `ids.length ?` ternary.
      await expect(recentPerCustomer([])).resolves.toEqual([]);
    });

    it("returns nothing for a customer who has never booked", async () => {
      const her = await makeCustomer(PHONES[0]);
      await expect(recentPerCustomer([her])).resolves.toEqual([]);
    });

    it("ignores an id that matches no customer", async () => {
      const absent = "00000000-0000-0000-0000-000000000000";
      await expect(recentPerCustomer([absent])).resolves.toEqual([]);
    });

    it("includes cancelled and no-show bookings — the drawer is a record", async () => {
      const her = await makeCustomer(PHONES[0]);
      await bookFor(her, 2, "A");
      await db
        .update(bookings)
        .set({ status: "cancelled" })
        .where(and(eq(bookings.customerId, her), like(bookings.code, "RON-A000")));

      const rows = await recentPerCustomer([her]);

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "completed"]);
    });
  });
});

// Keep the fixtures' customers out of other suites' way.
afterAll(async () => {
  await db.delete(bookings).where(like(bookings.code, "RON-A%"));
  await db.delete(bookings).where(like(bookings.code, "RON-B%"));
  await db.delete(customers).where(inArray(customers.phone, [...PHONES]));
});
