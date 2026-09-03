// The two ways this codebase keeps a balance, and the ways each can drift.
//
// Gift cards carry a stored `balance_halalas` beside a `gift_card_txns` ledger,
// and the schema says "never edit balance without a row here". Loyalty has no
// balance column at all: the number is a filtered SUM over `loyalty_txns`, and
// the filter is what makes points come back on their own — a cancellation, an
// abandoned checkout and a declined payment each release them with no
// compensating write.
//
// So the two need opposite tests. For gift cards: prove the stored number and
// the ledger cannot diverge, including under concurrent redemption. For
// loyalty: prove every way a booking can die releases its points, and that the
// balance never depends on the sweep having run — the comment at
// lib/rewards.ts:127 is explicit that this is the clause people miss.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, giftCards, loyaltyTxns } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { resetAppContext } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);

const fx = new Fixtures();
beforeEach(resetAppContext);
afterEach(() => fx.cleanup());

// ------------------------------------------------------------ gift cards ----

async function card(balance = 50_000) {
  const { tag } = await import("../helpers/fixtures");
  const [row] = await db
    .insert(giftCards)
    .values({
      code: `GCT${tag().toUpperCase()}`,
      initialHalalas: balance,
      balanceHalalas: balance,
    })
    .returning();
  fx.claim(giftCards, row.id);
  return row;
}

/** The invariant: the stored balance is initial + every ledger movement. */
async function assertBalanceMatchesLedger(id: string) {
  const { ledgerBalance } = await import("@/lib/giftcards");
  const [row] = await db.select().from(giftCards).where(eq(giftCards.id, id));
  expect(
    row.balanceHalalas,
    "the stored balance and the ledger disagree — one was written without the other",
  ).toBe(row.initialHalalas + (await ledgerBalance(id)));
}

describe("a gift card's stored balance and its ledger", () => {
  it("move together on a redemption", async () => {
    const gc = await card(50_000);
    const { adjustGiftCardBalance } = await import("@/lib/giftcards");

    const result = await adjustGiftCardBalance(gc.id, -20_000, "redeemed at checkout");
    expect(result).toEqual({ ok: true, balanceHalalas: 30_000 });
    await assertBalanceMatchesLedger(gc.id);
  });

  it("refuse an overdraw, and write nothing at all when they do", async () => {
    const gc = await card(10_000);
    const { adjustGiftCardBalance, ledgerBalance } = await import("@/lib/giftcards");

    const result = await adjustGiftCardBalance(gc.id, -10_001, "one halala too far");
    expect(result).toEqual({ ok: false, error: "insufficient" });

    // Negative space: the refusal must leave no ledger row behind either.
    expect(await ledgerBalance(gc.id), "a refused redemption still wrote a ledger row").toBe(0);
    await assertBalanceMatchesLedger(gc.id);
  });

  it("survive two redemptions of the last riyal fired together", async () => {
    // The `for update` lock in adjustGiftCardBalance is the only thing stopping
    // both from reading 10 000 and both succeeding.
    const gc = await card(10_000);
    const { adjustGiftCardBalance } = await import("@/lib/giftcards");

    const [a, b] = await Promise.all([
      adjustGiftCardBalance(gc.id, -10_000, "race a"),
      adjustGiftCardBalance(gc.id, -10_000, "race b"),
    ]);

    expect([a.ok, b.ok].filter(Boolean), "the card was spent twice").toHaveLength(1);
    const [row] = await db.select().from(giftCards).where(eq(giftCards.id, gc.id));
    expect(row.balanceHalalas).toBe(0);
    await assertBalanceMatchesLedger(gc.id);
  });

  it("hold under eight concurrent partial redemptions", async () => {
    // Eight attempts at 20 000 against 100 000: exactly five may succeed.
    const gc = await card(100_000);
    const { adjustGiftCardBalance } = await import("@/lib/giftcards");

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => adjustGiftCardBalance(gc.id, -20_000, `slice ${i}`)),
    );
    expect(results.filter((r) => r.ok), "more was spent than the card held").toHaveLength(5);

    const [row] = await db.select().from(giftCards).where(eq(giftCards.id, gc.id));
    expect(row.balanceHalalas).toBe(0);
    await assertBalanceMatchesLedger(gc.id);
  });

  it("flip to redeemed at zero and back to active when topped up", async () => {
    const gc = await card(10_000);
    const { adjustGiftCardBalance } = await import("@/lib/giftcards");

    await adjustGiftCardBalance(gc.id, -10_000, "spent");
    let [row] = await db.select().from(giftCards).where(eq(giftCards.id, gc.id));
    expect(row.status).toBe("redeemed");

    await adjustGiftCardBalance(gc.id, 5_000, "goodwill top-up");
    [row] = await db.select().from(giftCards).where(eq(giftCards.id, gc.id));
    expect(row.status, "a topped-up card stayed marked redeemed").toBe("active");
    await assertBalanceMatchesLedger(gc.id);
  });

  it("refuse a zero or fractional movement", async () => {
    const gc = await card();
    const { adjustGiftCardBalance, ledgerBalance } = await import("@/lib/giftcards");

    for (const delta of [0, 0.5, -0.5, NaN, Infinity]) {
      expect(
        await adjustGiftCardBalance(gc.id, delta, "nonsense"),
        `a delta of ${delta} was accepted`,
      ).toEqual({ ok: false, error: "failed" });
    }
    expect(await ledgerBalance(gc.id)).toBe(0);
  });

  it("refuse a card that does not exist", async () => {
    const { adjustGiftCardBalance } = await import("@/lib/giftcards");
    expect(
      await adjustGiftCardBalance("00000000-0000-0000-0000-000000000000", -100, "ghost"),
    ).toEqual({ ok: false, error: "not-found" });
  });
});

describe("gift card codes", () => {
  it("are long enough and random enough not to be walked", async () => {
    const { makeGiftCardCode } = await import("@/lib/giftcards");
    const codes = new Set(Array.from({ length: 2_000 }, () => makeGiftCardCode()));
    // Possession of the code is the entire authorization — it is a bearer
    // instrument — so a collision is two people holding one balance.
    expect(codes.size, "makeGiftCardCode collided inside 2000 draws").toBe(2_000);
    for (const c of codes) expect(c.length).toBeGreaterThanOrEqual(8);
  });
});

// --------------------------------------------------------------- loyalty ----

/** A ledger row against a booking in a given state, and the balance after it. */
async function ledgerWith(status: string, deltaPoints: number, createdAt?: Date) {
  const branch = await fx.branch();
  const svc = await fx.service();
  const cust = await fx.customer();
  const bkg = await fx.booking({
    branchId: branch.id,
    serviceId: svc.id,
    status: status as never,
    ...(createdAt ? { createdAt } : {}),
  });
  const [txn] = await db
    .insert(loyaltyTxns)
    .values({ customerId: cust.id, bookingId: bkg.id, deltaPoints, reason: "earned" })
    .returning();
  fx.claim(loyaltyTxns, txn.id);

  const { loyaltyBalance } = await import("@/lib/loyalty");
  return { balance: await loyaltyBalance(cust.id), customerId: cust.id, bookingId: bkg.id };
}

describe("points come back on their own", () => {
  it("counts points earned on a completed booking", async () => {
    const { balance } = await ledgerWith("completed", 120);
    expect(balance).toBe(120);
  });

  it("stops counting them the moment the booking is cancelled", async () => {
    const { balance } = await ledgerWith("cancelled", 120);
    expect(balance, "a cancelled booking kept its points").toBe(0);
  });

  it("stops counting them for a no-show", async () => {
    const { balance } = await ledgerWith("no_show", 120);
    expect(balance).toBe(0);
  });

  it("counts a fresh pending hold, which is still alive", async () => {
    // Inside the hold window the booking may yet be paid for, and a retry keeps
    // its debit — "correct, not a leak", per lib/rewards.ts:133.
    const { balance } = await ledgerWith("pending", 120, new Date());
    expect(balance).toBe(120);
  });

  it("releases points locked by a hold that sat unpaid past its window", async () => {
    // The clause the comment says is easy to miss: without a clock here, points
    // spent on a declined payment stay locked until an unrelated stranger
    // happens to book at the same branch. Two days old is well past any window.
    const { balance } = await ledgerWith("pending", 120, new Date(Date.now() - 2 * 86_400_000));
    expect(balance, "the balance depends on the sweep having run").toBe(0);
  });

  it("releases what a cancellation had spent, without a compensating row", async () => {
    // The redemption direction: a negative row against a cancelled booking must
    // stop subtracting, so the customer gets their points back by the same rule.
    const branch = await fx.branch();
    const svc = await fx.service();
    const cust = await fx.customer();
    const earned = await fx.booking({ branchId: branch.id, serviceId: svc.id, status: "completed" });
    const spent = await fx.booking({ branchId: branch.id, serviceId: svc.id, status: "confirmed" });

    const rows = await db
      .insert(loyaltyTxns)
      .values([
        { customerId: cust.id, bookingId: earned.id, deltaPoints: 200, reason: "earned" },
        { customerId: cust.id, bookingId: spent.id, deltaPoints: -150, reason: "reward" },
      ])
      .returning();
    for (const r of rows) fx.claim(loyaltyTxns, r.id);

    const { loyaltyBalance } = await import("@/lib/loyalty");
    expect(await loyaltyBalance(cust.id)).toBe(50);

    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, spent.id));
    expect(
      await loyaltyBalance(cust.id),
      "cancelling a redemption did not return the points",
    ).toBe(200);
  });

  it("revokes what a cancelled booking earned", async () => {
    // The same rule read the other way: cancelling a paid booking takes back
    // the points it minted, with no refund path anywhere.
    const branch = await fx.branch();
    const svc = await fx.service();
    const cust = await fx.customer();
    const bkg = await fx.booking({ branchId: branch.id, serviceId: svc.id, status: "completed" });
    const [txn] = await db
      .insert(loyaltyTxns)
      .values({ customerId: cust.id, bookingId: bkg.id, deltaPoints: 200, reason: "earned" })
      .returning();
    fx.claim(loyaltyTxns, txn.id);

    const { loyaltyBalance } = await import("@/lib/loyalty");
    expect(await loyaltyBalance(cust.id)).toBe(200);
    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, bkg.id));
    expect(await loyaltyBalance(cust.id)).toBe(0);
  });

  it("counts a movement attached to no booking at all", async () => {
    // `bookingStatus === null` is "not attached to a booking", which is alive —
    // a goodwill grant from the desk must not evaporate.
    const cust = await fx.customer();
    const [txn] = await db
      .insert(loyaltyTxns)
      .values({ customerId: cust.id, bookingId: null, deltaPoints: 500, reason: "goodwill" })
      .returning();
    fx.claim(loyaltyTxns, txn.id);

    const { loyaltyBalance } = await import("@/lib/loyalty");
    expect(await loyaltyBalance(cust.id)).toBe(500);
  });

  it("gives a customer with no ledger a balance of zero, not an error", async () => {
    const cust = await fx.customer();
    const { loyaltyBalance } = await import("@/lib/loyalty");
    expect(await loyaltyBalance(cust.id)).toBe(0);
  });
});

describe("spending points", () => {
  it("refuses a rung the balance cannot reach", async () => {
    const cust = await fx.customer();
    const { quoteReward } = await import("@/lib/loyalty");
    const quote = await quoteReward(cust.id, 500, 100_000);
    expect(quote.ok, "a customer spent points they do not have").toBe(false);
  });

  it("refuses zero, negative and fractional point amounts", async () => {
    const cust = await fx.customer();
    const { quoteReward } = await import("@/lib/loyalty");
    for (const points of [0, -100, 0.5, -0.5]) {
      const quote = await quoteReward(cust.id, points, 100_000);
      expect(quote.ok, `${points} points was accepted as a reward`).toBe(false);
    }
  });

  it("never discounts more than the bill", async () => {
    // A discount larger than the total is a negative charge, which is a refund
    // the customer awarded themselves.
    const { rewardFor, rewardDiscount, REWARDS } = await import("@/lib/rewards");
    for (const reward of REWARDS) {
      for (const total of [0, 1, 100, 25_000]) {
        const discount = rewardDiscount(reward, total);
        expect(discount, `reward ${reward.points} discounted more than a ${total} bill`)
          .toBeLessThanOrEqual(total);
        expect(discount).toBeGreaterThanOrEqual(0);
      }
    }
    expect(rewardFor(-1)).toBeNull();
  });

  it("writes no ledger row for a non-positive spend", async () => {
    const branch = await fx.branch();
    const svc = await fx.service();
    const cust = await fx.customer();
    const bkg = await fx.booking({ branchId: branch.id, serviceId: svc.id });
    const { spendPoints } = await import("@/lib/loyalty");

    for (const points of [0, -50]) {
      await spendPoints(db as never, cust.id, bkg.id, points);
    }
    const rows = await db
      .select()
      .from(loyaltyTxns)
      .where(eq(loyaltyTxns.customerId, cust.id));
    expect(rows, "a zero or negative spend wrote a ledger row").toHaveLength(0);
  });
});
