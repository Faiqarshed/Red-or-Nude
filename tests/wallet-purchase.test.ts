// Wallet credit on a purchase: a membership, a gift card, a treat for the chair
// (docs/WALLET-PLAN.md, build step 5).
//
// Signed in only. The spend is written with the pending payment, under the
// wallet's lock, and refused if the credit is not what the screen showed. A
// purchase the credit covers never reaches StreamPay. A checkout that fails, or
// one paid for and never delivered, gives the credit back; a payment written
// off and found paid later takes it again before it is delivered, or is not
// delivered and goes back to her card.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerPacks,
  customers,
  giftCards,
  giftCardTxns,
  packServices,
  packs,
  payments,
  settings,
  walletTxns,
} from "@/lib/db/schema";
import { settlePurchase, startPurchase, type Intent } from "@/lib/payments/purchase";
import { walletBalance } from "@/lib/wallet";
import { fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;
const SARA = "sara-purchase@test.local";
let saraId: string;
let packId: string;
const PRICE = 30_000;

async function launch() {
  const at = new Date(Date.now() - 60_000).toISOString();
  await db
    .insert(settings)
    .values({ key: "wallet_launched_at", value: at })
    .onConflictDoUpdate({ target: settings.key, set: { value: at } });
}

async function credit(halalas: number) {
  await db
    .insert(walletTxns)
    .values({ customerId: saraId, ownerEmail: SARA, deltaHalalas: halalas, reason: "correction", note: "test" });
}

function buy(walletHalalas: number, intent?: Intent, simulate?: "decline") {
  const i: Intent = intent ?? { kind: "pack", customerId: saraId, packId };
  const amount = i.kind === "gift_card" ? i.amountSar * 100 : PRICE;
  return startPurchase({
    intent: i,
    amountHalalas: amount,
    lines: [{ key: `product:test:${amount}`, name: "Test", priceHalalas: amount, qty: 1 }],
    title: "Test",
    payer: { email: SARA, customerId: saraId },
    back: "/",
    wallet: walletHalalas > 0 ? { customerId: saraId, email: SARA, halalas: walletHalalas } : undefined,
    simulate,
  });
}

const paymentsOfSara = () =>
  db.select().from(payments).where(inArray(payments.id, db.select({ id: walletTxns.paymentId }).from(walletTxns).where(eq(walletTxns.ownerEmail, SARA))));

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
  const [sara] = await db
    .insert(customers)
    .values({ phone: "0500000096", email: SARA, emailVerifiedAt: new Date() })
    .returning({ id: customers.id });
  saraId = sara.id;
  const [pack] = await db
    .insert(packs)
    .values({ name: { ar: "باقة", en: "Wallet pack" }, priceHalalas: PRICE, validDays: 90, active: true, sort: 901 })
    .returning({ id: packs.id });
  packId = pack.id;
  await db.insert(packServices).values({ packId, serviceId: f.svcA.id, quantity: 1 });
  await launch();
});

afterEach(async () => {
  const mine = await paymentsOfSara();
  const ids = mine.map((p) => p.id);
  await db.delete(walletTxns).where(eq(walletTxns.ownerEmail, SARA));
  if (ids.length) {
    const cards = mine.map((p) => p.giftCardId).filter((c): c is string => Boolean(c));
    await db.delete(payments).where(inArray(payments.id, ids));
    if (cards.length) {
      await db.delete(giftCardTxns).where(inArray(giftCardTxns.giftCardId, cards));
      await db.delete(giftCards).where(inArray(giftCards.id, cards));
    }
  }
  await db.delete(customerPacks).where(eq(customerPacks.packId, packId));
  await db.delete(packServices).where(eq(packServices.packId, packId));
  await db.delete(packs).where(eq(packs.id, packId));
  await reset(f.branchA, f.branchB);
  await db.delete(settings).where(eq(settings.key, "wallet_launched_at"));
});

describe("her credit on a purchase", () => {
  it("pays part of a membership, and the card is charged the rest", async () => {
    await credit(10_000);
    const r = await buy(10_000);
    expect(r).toMatchObject({ ok: true, delivered: { kind: "pack" } });

    const [p] = await paymentsOfSara();
    expect(p).toMatchObject({ status: "paid", amountHalalas: PRICE - 10_000 });
    expect((await walletBalance(SARA)).available).toBe(0);
  });

  it("covers the whole purchase with no charge at all", async () => {
    await credit(PRICE + 5_000);
    const r = await buy(PRICE);
    expect(r).toMatchObject({ ok: true, delivered: { kind: "pack" } });

    const [p] = await paymentsOfSara();
    expect(p).toMatchObject({ status: "paid", amountHalalas: 0 });
    expect((p.raw as { free?: boolean }).free).toBe(true);
    expect((await walletBalance(SARA)).available).toBe(5_000);
  });

  it("is refused when the credit moved since the screen showed it", async () => {
    await credit(10_000);
    expect(await buy(12_000)).toMatchObject({ ok: false, error: "wallet-changed", walletBalance: 10_000 });
    expect(await paymentsOfSara()).toEqual([]);
  });

  it("never leaves the card a charge under 1 SAR", async () => {
    await credit(PRICE);
    expect(await buy(PRICE - 50)).toMatchObject({ ok: false, error: "wallet-changed" });
    expect(await paymentsOfSara()).toEqual([]);
  });

  it("spends one balance once when two purchases start at the same moment", async () => {
    await credit(10_000);
    const giftFor = (n: number): Intent => ({
      kind: "gift_card",
      amountSar: 300,
      designId: null,
      buyerName: null,
      buyerEmail: SARA,
      recipientName: `Friend ${n}`,
      recipientEmail: `friend${n}@test.local`,
      message: null,
      lang: "en",
      attemptId: crypto.randomUUID(),
    });
    const [a, b] = await Promise.all([buy(10_000, giftFor(1)), buy(10_000, giftFor(2))]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((await walletBalance(SARA)).total).toBe(0);
  });

  it("gives the credit back when the card is declined", async () => {
    await credit(10_000);
    expect(await buy(10_000, undefined, "decline")).toMatchObject({ ok: false, error: "payment-declined" });
    expect((await walletBalance(SARA)).available).toBe(10_000);
  });

  it("gives the credit back, and the card's part to the card, when it can't be delivered", async () => {
    await credit(10_000);
    await db.update(packs).set({ active: false }).where(eq(packs.id, packId));
    expect(await buy(10_000)).toMatchObject({ ok: false, error: "not-delivered" });

    const [p] = await paymentsOfSara();
    expect(p.status).toBe("refunded");
    expect((await walletBalance(SARA)).available).toBe(10_000);
  });

  it("gives it back, and marks it refunded, when credit paid it all and it can't be delivered", async () => {
    await credit(PRICE);
    await db.update(packs).set({ active: false }).where(eq(packs.id, packId));
    expect(await buy(PRICE)).toMatchObject({ ok: false, error: "not-delivered" });

    const [p] = await paymentsOfSara();
    expect(p).toMatchObject({ status: "refunded", amountHalalas: 0 });
    expect((await walletBalance(SARA)).available).toBe(PRICE);
  });

  it("issues a gift card for its whole value when credit paid part of it", async () => {
    await credit(10_000);
    const r = await buy(10_000, {
      kind: "gift_card",
      amountSar: 300,
      designId: null,
      buyerName: null,
      buyerEmail: SARA,
      recipientName: "Noura",
      recipientEmail: "noura-purchase@test.local",
      message: null,
      lang: "en",
      attemptId: crypto.randomUUID(),
    });
    expect(r).toMatchObject({ ok: true, delivered: { kind: "gift_card" } });

    const [p] = await paymentsOfSara();
    const [card] = await db.select().from(giftCards).where(eq(giftCards.id, p.giftCardId!));
    expect(card).toMatchObject({ initialHalalas: 30_000, balanceHalalas: 30_000 });
  });

  it("is refused before launch", async () => {
    await db.delete(settings).where(eq(settings.key, "wallet_launched_at"));
    await credit(10_000);
    expect(await buy(10_000)).toMatchObject({ ok: false, error: "wallet-unavailable" });
  });
});

describe("a payment written off, then found paid", () => {
  /** Declined (credit given back), then revived as revivePayment does it. */
  async function declinedThenPaid() {
    await buy(10_000, undefined, "decline");
    const [p] = await paymentsOfSara();
    await db.update(payments).set({ status: "pending" }).where(eq(payments.id, p.id));
    return settlePurchase(p.providerRef!, { status: "paid", amountHalalas: p.amountHalalas, method: "card", raw: {} });
  }

  it("takes the credit again and delivers", async () => {
    await credit(10_000);
    expect(await declinedThenPaid()).toMatchObject({ ok: true, delivered: { kind: "pack" } });
    expect((await walletBalance(SARA)).available).toBe(0);
  });

  it("is not delivered, and the card goes back, when the credit was spent meanwhile", async () => {
    await credit(10_000);
    await buy(10_000, undefined, "decline");
    // Spent on something else while this one was written off.
    await db
      .insert(walletTxns)
      .values({ customerId: saraId, ownerEmail: SARA, deltaHalalas: -10_000, reason: "correction", note: "spent" });
    const [p] = await paymentsOfSara();
    await db.update(payments).set({ status: "pending" }).where(eq(payments.id, p.id));

    const r = await settlePurchase(p.providerRef!, { status: "paid", amountHalalas: p.amountHalalas, method: "card", raw: {} });
    expect(r).toMatchObject({ ok: false, error: "not-delivered" });
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0].status).toBe("refunded");
    expect(await db.select().from(customerPacks).where(and(eq(customerPacks.packId, packId)))).toEqual([]);
    expect((await walletBalance(SARA)).total).toBe(0);
  });
});
