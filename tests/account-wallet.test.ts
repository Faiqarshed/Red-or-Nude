// The wallet on her account screen (docs/WALLET-PLAN.md, build step 3).
//
// What she can spend, never a negative number, and her own email's last ten
// movements, newest first.

import { beforeEach, describe, expect, it, vi } from "vitest";

let signedIn: { email: string } | null = null;
vi.mock("@/lib/account/guard", () => ({ currentCustomer: async () => signedIn }));

import { db } from "@/lib/db";
import { customers, walletTxns } from "@/lib/db/schema";
import { accountWallet } from "@/lib/wallet";
import { GET } from "@/app/api/wallet/quote/route";
import { fixtures, reset } from "./helpers";

const EMAIL = "wallet-screen@test.local";
let customerId: string;

/** One ledger row, `seconds` after a fixed moment so the order is certain. */
async function row(
  deltaHalalas: number,
  reason: (typeof walletTxns.$inferInsert)["reason"],
  seconds: number,
  ownerEmail = EMAIL,
) {
  await db.insert(walletTxns).values({
    customerId,
    ownerEmail,
    deltaHalalas,
    reason,
    note: reason === "correction" ? "test" : null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 9, 0, seconds)),
  });
}

beforeEach(async () => {
  const f = await fixtures();
  await reset(f.branchA, f.branchB);
  const [c] = await db.insert(customers).values({ phone: "0500000093", email: EMAIL }).returning({ id: customers.id });
  customerId = c.id;
  signedIn = null;
});

describe("the wallet on her account", () => {
  it("shows what she can spend and her movements newest first", async () => {
    await row(30_000, "cancel-customer", 1);
    await row(-10_000, "spend", 2);

    expect(await accountWallet(EMAIL.toUpperCase())).toEqual({
      available: 20_000,
      sources: { giftCards: 0, refunds: 30_000, spent: -10_000, adjustments: 0 },
      history: [
        { reason: "spend", halalas: -10_000, at: "2026-01-01T09:00:02.000Z" },
        { reason: "cancel-customer", halalas: 30_000, at: "2026-01-01T09:00:01.000Z" },
      ],
      count: 2,
    });
  });

  it("splits what she holds by where it came from", async () => {
    await row(30_000, "gift-card", 1);
    await row(11_500, "cancel-customer", 2);
    await row(500, "chair-credit", 3);
    await row(-20_000, "spend", 4);
    await row(5_000, "release", 5);
    await row(-1_000, "correction", 6);

    expect((await accountWallet(EMAIL))?.sources).toEqual({
      giftCards: 30_000,
      refunds: 12_000,
      spent: -15_000,
      adjustments: -1_000,
    });
  });

  it("never shows a debt as a negative balance", async () => {
    await row(10_000, "cancel-customer", 1);
    await row(-10_000, "spend", 2);
    await row(-10_000, "reversal", 3);

    expect((await accountWallet(EMAIL))?.available).toBe(0);
  });

  it("shows only her own email's rows, the last ten, and how many there are in all", async () => {
    for (let s = 0; s < 12; s++) await row(100, "correction", s);
    await row(99_900, "correction", 30, "someone-else@test.local");

    const mine = await accountWallet(EMAIL);
    expect(mine?.available).toBe(1_200);
    expect(mine?.history).toHaveLength(10);
    expect(mine?.history.every((h) => h.halalas === 100)).toBe(true);
    expect(mine?.history[0].at).toBe("2026-01-01T09:00:11.000Z");
    // The header lists a few and says how many more; the account lists them all.
    expect(mine?.count).toBe(12);
    expect((await accountWallet(EMAIL, 50))?.history).toHaveLength(12);
  });
});

describe("the wallet in the header", () => {
  it("is the signed-in email's wallet, and nothing for a guest", async () => {
    await row(30_000, "gift-card", 1);
    await row(99_900, "correction", 2, "someone-else@test.local");

    expect(await (await GET()).json()).toEqual({ signedIn: false, available: 0 });

    signedIn = { email: EMAIL };
    expect(await (await GET()).json()).toMatchObject({
      signedIn: true,
      available: 30_000,
      sources: { giftCards: 30_000 },
      history: [{ reason: "gift-card", halalas: 30_000 }],
    });
  });
});
