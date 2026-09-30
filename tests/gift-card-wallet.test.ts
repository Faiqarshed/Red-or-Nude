// Gift cards and the wallet (docs/WALLET-PLAN.md, build step 6).
//
// From launch a card is taxed when sold, needs its recipient's email, and is
// locked to it. It lands in her wallet the moment it is delivered when that
// email has an account, and when the email signs up otherwise. A card whose
// payment is charged back takes back only what is left in her wallet: the
// buyer's fraud is the salon's loss, never the recipient's debt. A typo in the
// recipient's email is the owner's to fix, with a reason, while it is unclaimed.

import "./as-staff";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, customers, giftCards, giftCardTxns, payments, settings, walletDecisions, walletTxns } from "@/lib/db/schema";
import { startPurchase, type GiftIntent } from "@/lib/payments/purchase";
import { giftCardLine } from "@/lib/payments/lines";
import { refundedOutside } from "@/lib/payments/refund";
import { fakeDriver } from "@/lib/payments/fake";
import { createAccount } from "@/lib/account/create";
import { walletBalance } from "@/lib/wallet";
import { fixtures, reset } from "./helpers";

const { changeGiftCardEmail } = await import("@/app/(admin)/admin/(shell)/gift-cards/actions");
const { POST } = await import("@/app/api/gift-cards/route");

const NOURA = "noura-gift@test.local";
const BUYER = "buyer-gift@test.local";

/** Launched a minute ago by default, so cards bought in the test count as after it. */
async function launch(when = new Date(Date.now() - 60_000)) {
  const at = when.toISOString();
  await db
    .insert(settings)
    .values({ key: "wallet_launched_at", value: at })
    .onConflictDoUpdate({ target: settings.key, set: { value: at } });
}

const intent = (recipientEmail: string, buyerEmail = BUYER): GiftIntent => ({
  kind: "gift_card",
  amountSar: 300,
  designId: null,
  buyerName: "Sara",
  buyerEmail,
  recipientName: "Noura",
  recipientEmail,
  message: null,
  lang: "en",
  attemptId: crypto.randomUUID(),
});

async function buy(recipientEmail: string, buyerEmail = BUYER) {
  const r = await startPurchase({
    intent: intent(recipientEmail, buyerEmail),
    amountHalalas: 30_000,
    lines: [giftCardLine(300, false)],
    title: "Gift card",
    payer: { email: buyerEmail },
    back: "/",
  });
  if (!r.ok || !("delivered" in r) || r.delivered.kind !== "gift_card") throw new Error("not delivered");
  return (await db.select().from(giftCards).where(eq(giftCards.code, r.delivered.code)))[0];
}

async function account(email: string, phone: string) {
  const [c] = await db.insert(customers).values({ phone, email, emailVerifiedAt: new Date() }).returning();
  return c;
}

const claimsOf = (cardId: string) =>
  db.select().from(walletTxns).where(and(eq(walletTxns.giftCardId, cardId), eq(walletTxns.reason, "gift-card")));

beforeEach(async () => {
  const f = await fixtures();
  await reset(f.branchA, f.branchB);
  await db.delete(walletDecisions);
});

afterEach(async () => {
  vi.restoreAllMocks();
  const mine = db
    .select({ id: giftCards.id })
    .from(giftCards)
    .where(inArray(giftCards.recipientEmail, [NOURA, "noura-typo@test.local"]));
  await db.delete(walletTxns).where(inArray(walletTxns.giftCardId, mine));
  await db.delete(walletTxns).where(eq(walletTxns.ownerEmail, NOURA));
  await db.delete(walletDecisions);
  await db.delete(payments).where(inArray(payments.giftCardId, mine));
  await db.delete(giftCardTxns).where(inArray(giftCardTxns.giftCardId, mine));
  await db.delete(giftCards).where(inArray(giftCards.recipientEmail, [NOURA, "noura-typo@test.local"]));
  const f = await fixtures();
  await reset(f.branchA, f.branchB);
  await db.delete(customers).where(like(customers.email, "noura-gift%"));
  await db.delete(settings).where(eq(settings.key, "wallet_launched_at"));
});

describe("buying a gift card", () => {
  it("needs the recipient's email", async () => {
    const res = await POST(
      new Request("http://test.local/api/gift-cards", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ amountSar: 300, recipientName: "Noura", buyerEmail: BUYER }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).issues).toContain("recipientEmail");
  });
});

describe("a gift card's tax", () => {
  it("is taken when it is sold, from launch; before it, the card is sold tax-free", () => {
    expect(giftCardLine(300, true).vatExempt).toBe(false);
    expect(giftCardLine(300, false).vatExempt).toBe(true);
  });
});

describe("a gift card into her wallet", () => {
  it("goes into it on delivery when her email has an account", async () => {
    await launch();
    await account(NOURA, "0500000097");
    const card = await buy(NOURA);

    expect(card).toMatchObject({ status: "redeemed", balanceHalalas: 0 });
    expect((await walletBalance(NOURA)).available).toBe(30_000);
  });

  it("waits as a code when her email has no account yet, and lands when she signs up", async () => {
    await launch();
    const card = await buy(NOURA);
    expect(card).toMatchObject({ status: "active", balanceHalalas: 30_000 });

    await createAccount({ email: NOURA, name: "Noura", phone: "0500000097", birthday: null, lang: "en" });
    expect((await walletBalance(NOURA)).available).toBe(30_000);
    expect(await claimsOf(card.id)).toHaveLength(1);
  });

  it("is not claimed at sign-up when it has expired", async () => {
    await launch();
    const card = await buy(NOURA);
    await db.update(giftCards).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(giftCards.id, card.id));

    await createAccount({ email: NOURA, name: "Noura", phone: "0500000097", birthday: null, lang: "en" });
    expect((await walletBalance(NOURA)).available).toBe(0);
  });

  it("stays a code at sign-up when it was sold before launch, as it was sold", async () => {
    const card = await buy(NOURA);
    await launch(new Date(Date.now() + 1_000));

    await createAccount({ email: NOURA, name: "Noura", phone: "0500000097", birthday: null, lang: "en" });
    expect((await db.select().from(giftCards).where(eq(giftCards.id, card.id)))[0].status).toBe("active");
    expect((await walletBalance(NOURA)).available).toBe(0);
  });

  it("is never moved before launch", async () => {
    await account(NOURA, "0500000097");
    const card = await buy(NOURA);
    expect(card).toMatchObject({ status: "active", balanceHalalas: 30_000 });
    expect((await walletBalance(NOURA)).available).toBe(0);
  });
});

describe("a gift card whose payment goes back to the buyer's card", () => {
  it("takes back only what is left in her wallet; the rest is the salon's loss", async () => {
    await launch();
    const noura = await account(NOURA, "0500000097");
    const card = await buy(NOURA);
    await db
      .insert(walletTxns)
      .values({ customerId: noura.id, ownerEmail: NOURA, deltaHalalas: -20_000, reason: "correction", note: "spent" });
    const [p] = await db.select().from(payments).where(eq(payments.giftCardId, card.id));

    // Part of it first, reported twice (a partial refund leaves the payment open,
    // so the second report is read again): 25,000 back, 10,000 of it still hers.
    vi.spyOn(fakeDriver, "refundedHalalas").mockResolvedValue(25_000);
    await refundedOutside(p.providerRef!);
    await refundedOutside(p.providerRef!);
    expect(await walletBalance(NOURA)).toEqual({ total: 0, available: 0 });
    expect((await db.select().from(walletDecisions)).map((c) => [c.kind, c.amountHalalas])).toEqual([
      ["gift-card-loss", 15_000],
    ]);

    // Then the rest: nothing left in her wallet, so it is all the salon's loss.
    vi.spyOn(fakeDriver, "refundedHalalas").mockResolvedValue(30_000);
    await refundedOutside(p.providerRef!);
    expect(await walletBalance(NOURA)).toEqual({ total: 0, available: 0 });
    const lost = (await db.select().from(walletDecisions)).reduce((sum, c) => sum + c.amountHalalas, 0);
    expect(lost).toBe(20_000);
  });

  it("can put the buyer below zero when she bought the card for herself", async () => {
    await launch();
    const noura = await account(NOURA, "0500000097");
    const card = await buy(NOURA, NOURA);
    await db
      .insert(walletTxns)
      .values({ customerId: noura.id, ownerEmail: NOURA, deltaHalalas: -20_000, reason: "correction", note: "spent" });
    const [p] = await db.select().from(payments).where(eq(payments.giftCardId, card.id));
    vi.spyOn(fakeDriver, "refundedHalalas").mockResolvedValue(30_000);

    await refundedOutside(p.providerRef!);

    expect((await walletBalance(NOURA)).total).toBe(-20_000);
    const cases = await db.select().from(walletDecisions);
    expect(cases.map((c) => c.kind)).toEqual(["negative-balance"]);
  });
});

describe("the owner fixing a recipient's email", () => {
  it("moves an unclaimed card to the right email, with a reason, audited", async () => {
    await launch();
    const card = await buy("noura-typo@test.local");

    expect(await changeGiftCardEmail({ id: card.id, email: NOURA, reason: "Buyer typed gmial" })).toEqual({ ok: true });
    expect((await db.select().from(giftCards).where(eq(giftCards.id, card.id)))[0].recipientEmail).toBe(NOURA);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entity, "gift_cards"), eq(auditLog.entityId, card.id)));
    expect(audit.action).toBe("change-email");
  });

  it("is refused without a reason, and once the card is in a wallet", async () => {
    await launch();
    await account(NOURA, "0500000097");
    const claimed = await buy(NOURA);
    expect(await changeGiftCardEmail({ id: claimed.id, email: "other@test.local", reason: "why" })).toEqual({
      ok: false,
      error: "claimed",
    });

    const card = await buy("noura-typo@test.local");
    expect(await changeGiftCardEmail({ id: card.id, email: NOURA, reason: " " })).toMatchObject({ ok: false });
  });
});
