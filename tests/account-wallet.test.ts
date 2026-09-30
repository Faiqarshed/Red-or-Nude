// The wallet on her account screen (docs/WALLET-PLAN.md, build step 3).
//
// Nothing shows before launch. After it: what she can spend, never a negative
// number, and her own email's last ten movements, newest first.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, settings, walletTxns } from "@/lib/db/schema";
import { accountWallet } from "@/lib/wallet";
import { fixtures, reset } from "./helpers";

const EMAIL = "wallet-screen@test.local";
let customerId: string;

async function launch() {
  const at = new Date().toISOString();
  await db
    .insert(settings)
    .values({ key: "wallet_launched_at", value: at })
    .onConflictDoUpdate({ target: settings.key, set: { value: at } });
}

/** One ledger row, `seconds` after a fixed moment so the order is certain. */
async function row(
  deltaHalalas: number,
  reason: "cancel-customer" | "spend" | "reversal" | "correction",
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
});

afterEach(async () => {
  await db.delete(settings).where(eq(settings.key, "wallet_launched_at"));
});

describe("the wallet on her account", () => {
  it("shows nothing before launch, even with credit in the ledger", async () => {
    await row(30_000, "cancel-customer", 1);
    expect(await accountWallet(EMAIL)).toBeNull();
  });

  it("after launch, shows what she can spend and her movements newest first", async () => {
    await launch();
    await row(30_000, "cancel-customer", 1);
    await row(-10_000, "spend", 2);

    expect(await accountWallet(EMAIL.toUpperCase())).toEqual({
      available: 20_000,
      history: [
        { reason: "spend", halalas: -10_000, at: "2026-01-01T09:00:02.000Z" },
        { reason: "cancel-customer", halalas: 30_000, at: "2026-01-01T09:00:01.000Z" },
      ],
    });
  });

  it("never shows a debt as a negative balance", async () => {
    await launch();
    await row(10_000, "cancel-customer", 1);
    await row(-10_000, "spend", 2);
    await row(-10_000, "reversal", 3);

    expect((await accountWallet(EMAIL))?.available).toBe(0);
  });

  it("shows only her own email's rows, and only the last ten", async () => {
    await launch();
    for (let s = 0; s < 12; s++) await row(100, "correction", s);
    await row(99_900, "correction", 30, "someone-else@test.local");

    const mine = await accountWallet(EMAIL);
    expect(mine?.available).toBe(1_200);
    expect(mine?.history).toHaveLength(10);
    expect(mine?.history.every((h) => h.halalas === 100)).toBe(true);
    expect(mine?.history[0].at).toBe("2026-01-01T09:00:11.000Z");
  });
});
