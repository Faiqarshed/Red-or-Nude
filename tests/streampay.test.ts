// The StreamPay integration's own invariants — the parts that hold without a
// network: what the receipt is built from, the webhook signature, and settle
// being safe to arrive at twice or too late. The gateway itself is exercised
// against their sandbox by hand (docs/PAYMENTS-STREAMPAY.md §Testing).

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookings, loyaltyTxns, payments, promoCodes, refunds } from "@/lib/db/schema";
import { loyaltyBalance } from "@/lib/loyalty";
import { spendableBalance } from "@/lib/rewards";
import { spendableCredits } from "@/lib/packs";
import { createBookings } from "@/lib/bookings";
import { bookingLines, giftCardLine } from "@/lib/payments/lines";
import { settleBookingPayment } from "@/lib/payments/confirm";
import { settlePurchase, startPurchase, type GiftIntent } from "@/lib/payments/purchase";
import { paymentProblems, reconcilePayments } from "@/lib/payments/reconcile";
import { getDriver } from "@/lib/payments";
import { declineReason } from "@/lib/payments/decline";
import { fakeDriver } from "@/lib/payments/fake";
import { verifyWebhookSignature } from "@/lib/payments/streampay";
import { GET as paymentReturn } from "@/app/api/payments/return/route";
import { POST as giftCards } from "@/app/api/gift-cards/route";
import type { Verdict } from "@/lib/payments";
import { FUTURE, TEST_PHONE, counters, fixtures, reset, taggedAddon, type Fixtures } from "./helpers";

const TAG = "streampay-test";
const CODE = "SPTEST10";
const day = new Date(FUTURE + 3 * 3600_000).toISOString().slice(0, 10);

let f: Fixtures;

async function cleanup() {
  await db.delete(promoCodes).where(eq(promoCodes.code, CODE));
  await db.delete(addons).where(like(addons.image, `${TAG}%`));
}

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
  await cleanup();
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
  await cleanup();
});

/** A pair with a coffee on one guest and a 10% code: every discount source at once. */
async function holdDiscountedPair() {
  const treat = await taggedAddon(TAG, "coffee", true, { priceHalalas: 1000 });
  await db.insert(promoCodes).values({ code: CODE, type: "percent", value: 10 });
  const held = await createBookings({
    branchId: f.branchA,
    startsAt: new Date(FUTURE).toISOString(),
    customer: { phone: TEST_PHONE, email: "sp@example.com" },
    source: "web",
    status: "pending",
    promoCode: CODE,
    members: [
      { serviceId: f.svcA.id, addonIds: [treat] },
      { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
    ],
  });
  if (!held.ok) throw new Error(held.error);
  const members = await db
    .select()
    .from(bookings)
    .where(inArray(bookings.id, held.bookings.map((b) => b.id)))
    .orderBy(bookings.createdAt, bookings.id);
  return { held, members };
}

/** The pending rows confirmBookingPayment would have written before a checkout. */
async function pendingAttempt(members: { id: string; totalHalalas: number }[]) {
  const ref = randomUUID();
  await db.insert(payments).values(
    members.map((m) => ({
      bookingId: m.id,
      provider: "fake",
      providerRef: ref,
      method: "card" as const,
      amountHalalas: m.totalHalalas,
      status: "pending" as const,
      raw: { linkId: "link-under-test", url: "https://example.test/pay" },
    })),
  );
  return ref;
}

const paidVerdict = (amountHalalas: number): Verdict => ({
  status: "paid",
  amountHalalas,
  method: "mada",
  raw: { paymentId: "pay-under-test" },
});

describe("the receipt StreamPay is sent", () => {
  it("adds up, to the halala, to what the booking charges", async () => {
    const { held, members } = await holdDiscountedPair();
    const { lines, discounts } = await bookingLines(members);

    const gross = lines.reduce((s, l) => s + l.priceHalalas * l.qty, 0);
    const off = discounts.reduce((s, d) => s + d.halalas, 0);
    expect(gross - off).toBe(held.totalHalalas);

    // Every source named on its own, and the code by its own name.
    expect(discounts.map((d) => d.label).sort()).toEqual([CODE, "Group discount"].sort());
    // The coffee is on the receipt, at its full price.
    expect(lines.some((l) => l.key.startsWith("product:addon:") && l.priceHalalas === 1000)).toBe(true);
  });

  it("keeps the promo and points shares apart from the group share", async () => {
    const { members } = await holdDiscountedPair();
    for (const m of members) {
      expect(m.promoDiscountHalalas).toBeGreaterThan(0);
      expect(m.pointsDiscountHalalas).toBe(0);
      expect(m.discountHalalas).toBeGreaterThan(m.promoDiscountHalalas);
    }
  });
});

describe("the webhook signature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event_type: "PAYMENT_SUCCEEDED" });
  const now = Date.now();
  const t = String(Math.floor(now / 1000));
  const sign = (payload: string, key = secret) =>
    `t=${t},v1=${createHmac("sha256", key).update(`${t}.${payload}`).digest("hex")}`;

  it("accepts StreamPay's own signature and refuses anything else", () => {
    process.env.STREAMPAY_WEBHOOK_SECRET = secret;
    expect(verifyWebhookSignature(body, sign(body), now)).toBe(true);
    // A body changed in transit, a different secret, no header at all.
    expect(verifyWebhookSignature(body + " ", sign(body), now)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, "someone-else"), now)).toBe(false);
    expect(verifyWebhookSignature(body, null, now)).toBe(false);
  });

  it("refuses a genuine delivery replayed long after it was sent", () => {
    process.env.STREAMPAY_WEBHOOK_SECRET = secret;
    expect(verifyWebhookSignature(body, sign(body), now + 6 * 60_000)).toBe(false);
  });

  it("refuses everything while no secret is configured", () => {
    delete process.env.STREAMPAY_WEBHOOK_SECRET;
    expect(verifyWebhookSignature(body, sign(body), now)).toBe(false);
  });
});

describe("the return page", () => {
  it("sends her back only to a path on this site", async () => {
    const target = async (back: string) =>
      (await (await paymentReturn(new Request(`http://x/api/payments/return?back=${encodeURIComponent(back)}`))).text())
        .match(/location\.replace\((".*?")\)/)![1];
    expect(await target("/gift-card/payment")).toBe('"/gift-card/payment"');
    for (const evil of ["//evil.com", "/\\evil.com", "https://evil.com", "evil.com"]) {
      expect(await target(evil)).toBe('"/"');
    }
  });

  it("tells the page when StreamPay says the payment failed, and only then", async () => {
    const ref = randomUUID();
    const back = async (status: string) =>
      (await (await paymentReturn(new Request(`http://x/api/payments/return?ref=${ref}&back=%2Fbooking%2Fpayment&status=${status}`))).text())
        .match(/location\.replace\((".*?")\)/)![1];
    expect(await back("failed")).toBe(`"/booking/payment?paid=${ref}&declined=1"`);
    expect(await back("paid")).toBe(`"/booking/payment?paid=${ref}"`);
    // The bank's reason rides along, for the message only.
    expect(await back("failed&message=3DS%3A%20Card%20authentication%20declined.")).toBe(
      `"/booking/payment?paid=${ref}&declined=1&why=3DS%3A%20Card%20authentication%20declined."`,
    );
  });

  it("names each kind of decline so she knows what failed", () => {
    expect(declineReason("3DS: Card authentication declined.")).toBe("authFailed");
    expect(declineReason("3DS: Authentication cancelled")).toBe("cancelled");
    expect(declineReason("3DS: Authentication rejected")).toBe("rejected");
    expect(declineReason("3DS: Authentication not available")).toBe("unavailable");
    expect(declineReason("Insufficient Funds")).toBe("insufficient");
    expect(declineReason("Expired Card")).toBe("expired");
    expect(declineReason("DECLINED: EXCEEDS WITHDRAWAL LIMIT")).toBe("limit");
    expect(declineReason("Card not enrolled in 3DS service")).toBe("notEnrolled");
    expect(declineReason("3DS: attempted but not available, please ensure that you have enabled Online Purchase from your bank portal.")).toBe("notEnrolled");
    expect(declineReason("3DS service error occurred")).toBe("unavailable");
    expect(declineReason("3DS: attempted but not available")).toBe("unavailable");
    expect(declineReason("Authentication rejected by issuer bank")).toBe("rejected");
    expect(declineReason("DECLINED: STOLEN CARD")).toBe("declined");
    expect(declineReason("Do not honor")).toBe("declined");
    expect(declineReason(null)).toBe("declined");
  });
});

describe("buying something twice by accident", () => {
  it("resumes the checkout already open for the same purchase instead of opening a second", async () => {
    const intent: GiftIntent = {
      kind: "gift_card", amountSar: 75, designId: null, buyerName: TAG, buyerEmail: null,
      recipientName: null, recipientEmail: null, message: null, lang: "en",
    };
    const ref = randomUUID();
    await db.insert(payments).values({
      provider: "fake", providerRef: ref, method: "card", amountHalalas: 7500, status: "pending",
      raw: { intent, linkId: "link-under-test", url: "https://checkout.test/x" },
    });
    // Still open at the gateway.
    vi.spyOn(fakeDriver, "verify").mockResolvedValueOnce({ status: "pending" });

    try {
      const again = await startPurchase({
        intent: { ...intent },
        amountHalalas: 7500,
        lines: [giftCardLine(75)],
        title: "Gift card",
        payer: { name: null, email: null },
        back: "/gift-card/payment",
      });
      expect(again).toEqual({ ok: true, checkout: { ref, url: "https://checkout.test/x" } });
      const rows = await db.select().from(payments).where(sql`${payments.raw} -> 'intent' ->> 'buyerName' = ${TAG}`);
      expect(rows).toHaveLength(1);
    } finally {
      await db.delete(payments).where(sql`${payments.raw} -> 'intent' ->> 'buyerName' = ${TAG}`);
    }
  });
});

describe("settling a payment", () => {
  it("confirms a party once when the return page and the webhook arrive together", async () => {
    const { held, members } = await holdDiscountedPair();
    const ref = await pendingAttempt(members);
    const before = await counters([f.branchA, f.branchB], day);

    const [a, b] = await Promise.all([
      settleBookingPayment(ref, paidVerdict(held.totalHalalas)),
      settleBookingPayment(ref, paidVerdict(held.totalHalalas)),
    ]);

    // Both answer with the tickets — the loser reads back what the winner issued.
    expect(a.ok && "tickets" in a).toBe(true);
    expect(b.ok && "tickets" in b).toBe(true);

    const after = await counters([f.branchA, f.branchB], day);
    expect(after[f.branchA] - before[f.branchA]).toBe(1);
    expect(after[f.branchB] - before[f.branchB]).toBe(1);

    const rows = await db.select().from(payments).where(eq(payments.providerRef, ref));
    expect(rows.every((r) => r.status === "paid" && r.method === "mada")).toBe(true);
    // What a refund will need later is kept on the row.
    expect((rows[0].raw as { paymentId?: string }).paymentId).toBe("pay-under-test");
  });

  it("refunds a payment that lands after the hold was given away", async () => {
    const { held, members } = await holdDiscountedPair();
    const ref = await pendingAttempt(members);

    // Swept while she was on her bank's page.
    await db
      .update(bookings)
      .set({ status: "cancelled", cancelReason: "payment-timeout" })
      .where(inArray(bookings.id, members.map((m) => m.id)));

    const res = await settleBookingPayment(ref, paidVerdict(held.totalHalalas));
    expect(res.ok ? "" : res.error).toBe("expired");

    const rows = await db.select().from(payments).where(eq(payments.providerRef, ref));
    expect(rows.every((r) => r.status === "refunded")).toBe(true);
    const back = await db.select().from(refunds).where(inArray(refunds.paymentId, rows.map((r) => r.id)));
    expect(back.reduce((s, r) => s + r.amountHalalas, 0)).toBe(held.totalHalalas);

    // And a second arrival — the webhook retrying — refunds nothing more.
    await settleBookingPayment(ref, paidVerdict(held.totalHalalas));
    const again = await db.select().from(refunds).where(inArray(refunds.paymentId, rows.map((r) => r.id)));
    expect(again).toHaveLength(back.length);
  });

  it("will not confirm on a payment for a different amount", async () => {
    const { held, members } = await holdDiscountedPair();
    const ref = await pendingAttempt(members);

    const res = await settleBookingPayment(ref, paidVerdict(held.totalHalalas - 100));
    expect(res.ok).toBe(false);

    const rows = await db.select().from(bookings).where(inArray(bookings.id, members.map((m) => m.id)));
    expect(rows.every((r) => r.status === "pending" && r.ticketNo === null)).toBe(true);
  });
});

describe("points and credits while a checkout is open", () => {
  it("keeps a lapsed hold's spend locked only while its checkout can still be paid", async () => {
    const { members } = await holdDiscountedPair();
    const [anchor] = members;
    const customerId = anchor.customerId!;

    // Twenty minutes old: past the 15-minute hold on its own.
    await db
      .update(bookings)
      .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
      .where(inArray(bookings.id, members.map((m) => m.id)));
    await db.insert(loyaltyTxns).values([
      { customerId, bookingId: null, deltaPoints: 100, reason: "test-grant" },
      { customerId, bookingId: anchor.id, deltaPoints: -50, reason: "redeem" },
    ]);

    // Nobody is paying: the hold is abandoned and the 50 come back.
    expect(await loyaltyBalance(customerId)).toBe(100);

    // She opened a checkout at the last minute and is still on it: they stay spent.
    await pendingAttempt(members);
    expect(await loyaltyBalance(customerId)).toBe(50);
  });

  it("follows the same rule in the pure functions", () => {
    const now = new Date(FUTURE);
    const lapsed = new Date(FUTURE - 20 * 60_000);
    const spend = { deltaPoints: -50, bookingStatus: "pending", bookingCreatedAt: lapsed };
    expect(spendableBalance([spend], 15, now)).toBe(0);
    expect(spendableBalance([{ ...spend, checkoutOpen: true }], 15, now)).toBe(-50);

    const credit = { delta: -1, reason: "booking", bookingStatus: "pending", bookingCancelReason: null, bookingCreatedAt: lapsed };
    expect(spendableCredits([credit], 15, now)).toBe(0);
    expect(spendableCredits([{ ...credit, checkoutOpen: true }], 15, now)).toBe(-1);
  });
});

describe("the safety net under the webhook", () => {
  const gift: GiftIntent = {
    kind: "gift_card", amountSar: 75, designId: null, buyerName: TAG, buyerEmail: null,
    recipientName: null, recipientEmail: null, message: null, lang: "en",
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  const ours = sql`${payments.raw} -> 'intent' ->> 'buyerName' = ${TAG}`;

  it("settles a checkout she paid for and never came back from — refunded, since the hold is gone", async () => {
    const { held, members } = await holdDiscountedPair();
    const ref = await pendingAttempt(members);
    // She paid on her bank's page, closed the tab, and the webhook never came.
    // Near the end of the look-back, so it is first in line whatever else is waiting.
    await db.update(payments).set({ createdAt: ago(7 * 24 * 60 - 5) }).where(eq(payments.providerRef, ref));
    await db
      .update(bookings)
      .set({ status: "cancelled", cancelReason: "payment-timeout" })
      .where(inArray(bookings.id, members.map((m) => m.id)));
    vi.spyOn(fakeDriver, "verify").mockResolvedValue(paidVerdict(held.totalHalalas));

    try {
      await reconcilePayments();
    } finally {
      vi.restoreAllMocks();
    }

    const rows = await db.select().from(payments).where(eq(payments.providerRef, ref));
    expect(rows.every((r) => r.status === "refunded")).toBe(true);
  });

  it("closes a checkout she walked away from", async () => {
    const { members } = await holdDiscountedPair();
    const ref = await pendingAttempt(members);
    // Near the end of the look-back, so it is first in line whatever else is waiting.
    await db.update(payments).set({ createdAt: ago(47 * 60) }).where(eq(payments.providerRef, ref));
    // fakeDriver.verify answers "failed": expired, never paid.
    await reconcilePayments();
    const rows = await db.select().from(payments).where(eq(payments.providerRef, ref));
    expect(rows.every((r) => r.status === "failed")).toBe(true);
  });

  it("leaves a checkout still inside its pay window alone", async () => {
    const { members } = await holdDiscountedPair();
    const ref = await pendingAttempt(members);
    await reconcilePayments();
    const rows = await db.select().from(payments).where(eq(payments.providerRef, ref));
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("refunds a paid purchase that was never delivered", async () => {
    const ref = randomUUID();
    await db.insert(payments).values({
      provider: "fake", providerRef: ref, method: "card", amountHalalas: 7500, status: "paid",
      raw: { intent: gift, linkId: "l", url: "https://checkout.test/x", paymentId: "p" }, updatedAt: ago(20),
    });
    try {
      await reconcilePayments();
      const [row] = await db.select().from(payments).where(eq(payments.providerRef, ref));
      expect(row.status).toBe("refunded");
    } finally {
      await db.delete(refunds).where(sql`${refunds.paymentId} in (select id from payments where ${ours})`);
      await db.delete(payments).where(ours);
    }
  });

  it("names money we hold for nothing in the daily report", async () => {
    const { held, members } = await holdDiscountedPair();
    const ref = await pendingAttempt(members);
    // Paid, then swept, and the refund never went through.
    await db.update(payments).set({ status: "paid", updatedAt: ago(30) }).where(eq(payments.providerRef, ref));
    await db
      .update(bookings)
      .set({ status: "cancelled", cancelReason: "payment-timeout" })
      .where(inArray(bookings.id, members.map((m) => m.id)));
    const owed = (await paymentProblems()).owedBookings.find((p) => p.ref === ref);
    expect(owed?.amount_halalas).toBe(held.totalHalalas);
  });

  it("does not tell a second caller 'not delivered' while the first is still delivering", async () => {
    const ref = randomUUID();
    await db.insert(payments).values({
      provider: "fake", providerRef: ref, method: "card", amountHalalas: 7500, status: "paid",
      raw: { intent: gift, linkId: "l", url: "https://checkout.test/x" },
    });
    try {
      expect(await settlePurchase(ref)).toEqual({ ok: true, checkout: { ref, url: "https://checkout.test/x" } });
      // Long past any delivery: now it is a real failure.
      await db.update(payments).set({ updatedAt: ago(5) }).where(eq(payments.providerRef, ref));
      expect(await settlePurchase(ref)).toEqual({ ok: false, error: "not-delivered" });
    } finally {
      await db.delete(payments).where(ours);
    }
  });

  it("links the gift card to its payment", async () => {
    const ref = randomUUID();
    await db.insert(payments).values({
      provider: "fake", providerRef: ref, method: "card", amountHalalas: 7500, status: "pending",
      raw: { intent: gift },
    });
    try {
      const res = await settlePurchase(ref, { status: "paid", amountHalalas: 7500, method: "mada", raw: {} });
      expect(res.ok && "delivered" in res).toBe(true);
      const [row] = await db.select().from(payments).where(eq(payments.providerRef, ref));
      expect(row.giftCardId).not.toBeNull();
    } finally {
      await db.delete(payments).where(ours);
    }
  });
});

describe("the payment driver", () => {
  it("refuses to run in production unless one is named", () => {
    const env = process.env as Record<string, string | undefined>;
    const [was, mode] = [env.PAYMENT_DRIVER, env.NODE_ENV];
    try {
      env.NODE_ENV = "production";
      delete env.PAYMENT_DRIVER;
      expect(() => getDriver()).toThrow(/PAYMENT_DRIVER/);
      env.PAYMENT_DRIVER = "fake";
      expect(getDriver().name).toBe("fake");
    } finally {
      env.PAYMENT_DRIVER = was;
      env.NODE_ENV = mode;
    }
  });
});

describe("buying a gift card", () => {
  const post = (body: object) =>
    giftCards(new Request("http://x/api/gift-cards", { method: "POST", body: JSON.stringify(body) }));
  const ok = { amountSar: 100, recipientName: "Sarah" };

  it("refuses what the builder refuses, before anything is charged", async () => {
    for (const bad of [
      { recipientEmail: "aefpwirjopoajirw" }, // no @
      { recipientName: "" },
      { recipientName: "12345" },
      { buyerName: "x" },
    ]) {
      const res = await post({ ...ok, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("sells only the amounts the salon lists, not any number typed in", async () => {
    const res = await post({ ...ok, amountSar: 737 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-amount" });
  });
});
