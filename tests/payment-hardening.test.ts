// The payment hardening (docs/PAYMENT-HARDENING-PLAN.md): each test is one of
// the ways money could be lost, charged twice, or left with nothing, and pins
// the fix for it. Numbers match the plan.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, giftCardValues, giftCards, loyaltyTxns, payments, refunds, stations } from "@/lib/db/schema";
import { createBookings, heldState, releaseWebHold } from "@/lib/bookings";
import { getDayAvailability, utcToLocalDate, utcToLocalTime } from "@/lib/availability";
import { settleBookingPayment } from "@/lib/payments/confirm";
import { CHAIR_CREDIT_MAX_HALALAS, settlePurchase, startPurchase, type GiftIntent, type TreatIntent } from "@/lib/payments/purchase";
import { compareWithGateway, reconcilePayments } from "@/lib/payments/reconcile";
import { settlePayment } from "@/lib/payments/settle";
import { fakeDriver } from "@/lib/payments/fake";
import { streampayDriver } from "@/lib/payments/streampay";
import { giftCardLine } from "@/lib/payments/lines";
import { POST as webhook } from "@/app/api/payments/streampay/webhook/route";
import { POST as giftCards_ } from "@/app/api/gift-cards/route";
import type { Verdict } from "@/lib/payments";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

const TAG = "hardening-test";
let f: Fixtures;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.delete(payments).where(sql`${payments.raw} -> 'intent' ->> 'buyerName' = ${TAG}`);
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
});

const ago = (min: number) => new Date(Date.now() - min * 60_000);

const paid = (amountHalalas: number): Verdict => ({
  status: "paid",
  amountHalalas,
  method: "mada",
  raw: { paymentId: "pay-under-test" },
});

/** One guest, held, with a checkout open on it. */
async function heldWithCheckout(startsAt = new Date(FUTURE)) {
  const held = await createBookings({
    branchId: f.branchA,
    startsAt: startsAt.toISOString(),
    customer: { phone: TEST_PHONE, email: "hardening@example.com" },
    source: "web",
    status: "pending",
    members: [{ serviceId: f.svcA.id, addonIds: [] }],
  });
  if (!held.ok) throw new Error(held.error);
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, held.bookings[0].id));
  const ref = randomUUID();
  await db.insert(payments).values({
    bookingId: booking.id,
    provider: "fake",
    providerRef: ref,
    method: "card",
    amountHalalas: booking.totalHalalas,
    status: "pending",
    raw: { linkId: "link-under-test", url: "https://example.test/pay" },
  });
  return { booking, ref };
}

const rowsOf = (ref: string) => db.select().from(payments).where(eq(payments.providerRef, ref));
const bookingOf = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];

describe("#6 StreamPay not answering", () => {
  it("reads as still pending, never as failed", async () => {
    const { ref } = await heldWithCheckout();
    vi.spyOn(fakeDriver, "verify").mockRejectedValue(new Error("timeout"));
    expect(await settlePayment(ref)).toEqual({ status: "pending", unverified: true });
    expect((await rowsOf(ref))[0].status).toBe("pending");
  });

  it("answers the webhook 503, so StreamPay sends it again", async () => {
    const { ref } = await heldWithCheckout();
    vi.spyOn(fakeDriver, "verify").mockRejectedValue(new Error("timeout"));
    process.env.STREAMPAY_WEBHOOK_SECRET = "whsec_test";
    const body = JSON.stringify({ event_type: "PAYMENT_SUCCEEDED", data: { metadata: { ref } } });
    const t = String(Math.floor(Date.now() / 1000));
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
    const res = await webhook(new Request("http://x", { method: "POST", body, headers: { "x-webhook-signature": sig } }));
    expect(res.status).toBe(503);
  });
});

describe("#3 money on a payment we had written off", () => {
  it("confirms the booking when her chair is still hers", async () => {
    const { booking, ref } = await heldWithCheckout();
    await db.update(payments).set({ status: "failed", createdAt: ago(20) }).where(eq(payments.providerRef, ref));
    vi.spyOn(fakeDriver, "verify").mockResolvedValue(paid(booking.totalHalalas));

    await reconcilePayments();

    expect((await rowsOf(ref))[0].status).toBe("paid");
    expect((await bookingOf(booking.id)).status).toBe("confirmed");
  });

  it("refunds it when the chair was given away meanwhile", async () => {
    const { booking, ref } = await heldWithCheckout();
    await db.update(payments).set({ status: "failed", createdAt: ago(20) }).where(eq(payments.providerRef, ref));
    await db.update(bookings).set({ status: "cancelled", cancelReason: "payment-timeout" }).where(eq(bookings.id, booking.id));
    vi.spyOn(fakeDriver, "verify").mockResolvedValue(paid(booking.totalHalalas));

    await reconcilePayments();

    expect((await rowsOf(ref))[0].status).toBe("refunded");
  });

  it("leaves a written-off payment alone when StreamPay still says unpaid", async () => {
    const { ref } = await heldWithCheckout();
    await db.update(payments).set({ status: "failed", createdAt: ago(20) }).where(eq(payments.providerRef, ref));
    // fakeDriver.verify answers "failed".
    await reconcilePayments();
    const [row] = await rowsOf(ref);
    expect(row.status).toBe("failed");
    // Stamped, so the back-off waits before asking again.
    expect((row.raw as { checkedAt?: string }).checkedAt).toBeTruthy();
  });
});

describe("streampay verify and refund", () => {
  const env = process.env as Record<string, string | undefined>;
  beforeEach(() => {
    env.STREAMPAY_API_KEY = "k";
    env.STREAMPAY_API_SECRET = "s";
  });
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("never writes off a status it does not know, or a completed link", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(reply({ data: [{ id: "i", payments: [{ id: "p", current_status: "AUTHORIZED", amount_in_smallest_unit: 100 }] }] }));
    expect(await streampayDriver.verify({ linkId: "l" })).toEqual({ status: "pending" });

    fetch.mockResolvedValueOnce(reply({ data: [] })).mockResolvedValueOnce(reply({ id: "l", status: "COMPLETED" }));
    expect(await streampayDriver.verify({ linkId: "l" })).toEqual({ status: "pending" });

    fetch.mockResolvedValueOnce(reply({ data: [] })).mockResolvedValueOnce(reply({ id: "l", status: "INACTIVE" }));
    expect(await streampayDriver.verify({ linkId: "l" })).toEqual({ status: "failed" });
  });

  it("does not refund again what has already gone back", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply({ amount_refunded: "75.00" }));
    const out = await streampayDriver.refund({ raw: { paymentId: "p" }, amountHalalas: 7500 });
    expect(out.status).toBe("refunded");
    // Asked, and did not send a second refund.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("counts a refund whose answer was lost as done, once StreamPay shows it", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply({ amount_refunded: "0" }))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(reply({ amount_refunded: "75.00" }));
    const out = await streampayDriver.refund({ raw: { paymentId: "p" }, amountHalalas: 7500 });
    expect(out.status).toBe("refunded");
  });

  it("takes a refund reply with no status field as the refund it is", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply({ amount_refunded: "0" }))
      .mockResolvedValueOnce(reply({ id: "r", amount_refunded: "75.00", refunded_at: new Date().toISOString() }));
    const out = await streampayDriver.refund({ raw: { paymentId: "p" }, amountHalalas: 7500 });
    expect(out.status).toBe("refunded");
  });
});

describe("#11 paid after the appointment began", () => {
  it("refunds instead of confirming a time already gone", async () => {
    const { booking, ref } = await heldWithCheckout();
    // Her appointment started an hour ago; the payment was started 20 minutes ago.
    await db
      .update(bookings)
      .set({ startsAt: ago(60), endsAt: ago(60 - 45) })
      .where(eq(bookings.id, booking.id));
    await db.update(payments).set({ createdAt: ago(20) }).where(eq(payments.providerRef, ref));

    const res = await settleBookingPayment(ref, paid(booking.totalHalalas));
    expect(res.ok).toBe(false);
    expect((await rowsOf(ref))[0].status).toBe("refunded");
    expect((await bookingOf(booking.id)).status).toBe("pending");
  });
});

describe("#4 her chair is not given away while her payment is in", () => {
  it("asks StreamPay before sweeping a lapsed hold that has a checkout", async () => {
    const { booking, ref } = await heldWithCheckout();
    // Hold and pay window both over; she paid in the last seconds.
    await db.update(bookings).set({ createdAt: ago(20) }).where(eq(bookings.id, booking.id));
    await db.update(payments).set({ createdAt: ago(12) }).where(eq(payments.providerRef, ref));
    vi.spyOn(fakeDriver, "verify").mockResolvedValue(paid(booking.totalHalalas));

    // Someone else books at the branch: the sweep runs.
    const other = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE + 4 * 3_600_000).toISOString(),
      customer: { phone: "0500000096" },
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcB.id, addonIds: [] }],
    });
    expect(other.ok).toBe(true);
    expect((await bookingOf(booking.id)).status).toBe("confirmed");
  });
});

describe("H1 a lapsed hold frees its slot", () => {
  it("shows the chair free once the hold has lapsed with no checkout open", async () => {
    const held = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
    });
    if (!held.ok) throw new Error(held.error);
    const at = new Date(FUTURE);
    const free = async () =>
      (await getDayAvailability(f.branchA, utcToLocalDate(at), f.svcA.durationMin, new Date(FUTURE - 86_400_000))).find(
        (s) => s.time === utcToLocalTime(at),
      )!.freeStationIds;

    const chair = held.bookings[0].stationId;
    expect(await free()).not.toContain(chair);
    await db.update(bookings).set({ createdAt: ago(20) }).where(eq(bookings.id, held.bookings[0].id));
    expect(await free()).toContain(chair);
  });
});

describe("#2 coming back to a hold she is paying for", () => {
  it("keeps the hold and says why", async () => {
    const { booking } = await heldWithCheckout();
    expect(await releaseWebHold(booking.code, "hardening@example.com")).toBe(false);
    expect(await heldState(booking.code, "hardening@example.com")).toBe("paying");
    // Not hers: says nothing.
    expect(await heldState(booking.code, "someone@example.com")).toBeNull();
  });

  it("says booked once it is paid", async () => {
    const { booking, ref } = await heldWithCheckout();
    await settleBookingPayment(ref, paid(booking.totalHalalas));
    expect(await heldState(booking.code, "hardening@example.com")).toBe("booked");
  });
});

describe("#9 strangers buying the same gift card", () => {
  it("never resume each other's checkout", async () => {
    const intent: GiftIntent = {
      kind: "gift_card", amountSar: 75, designId: null, buyerName: TAG, buyerEmail: null,
      recipientName: "Mom", recipientEmail: null, message: null, lang: "en", attemptId: randomUUID(),
    };
    const theirs = randomUUID();
    await db.insert(payments).values({
      provider: "fake", providerRef: theirs, method: "card", amountHalalas: 7500, status: "pending",
      raw: { intent, linkId: "link-under-test", url: "https://checkout.test/x" },
    });
    vi.spyOn(fakeDriver, "verify").mockResolvedValue({ status: "pending" });

    const mine = await startPurchase({
      intent: { ...intent, attemptId: randomUUID() },
      amountHalalas: 7500,
      lines: [giftCardLine(75)],
      title: "Gift card",
      payer: {},
      back: "/gift-card/payment",
    });
    // A new purchase of her own (the fake driver pays it on the spot), not theirs.
    expect("checkout" in mine && mine.checkout.ref === theirs).toBe(false);
  });
});

describe("#12 a chair purchase paid after her visit ended", () => {
  async function lateTreat(amountHalalas: number) {
    const { booking } = await heldWithCheckout();
    await db.update(bookings).set({ status: "completed" }).where(eq(bookings.id, booking.id));
    const intent: TreatIntent = {
      kind: "treat",
      bookingId: booking.id,
      items: [{ addonId: randomUUID(), name: { ar: "قهوة", en: "coffee" }, priceHalalas: amountHalalas, durationMin: 0 }],
    };
    const ref = randomUUID();
    await db.insert(payments).values({
      provider: "fake", providerRef: ref, method: "card", amountHalalas, status: "pending",
      raw: { intent, linkId: "link-under-test", url: "https://checkout.test/x" }, createdAt: ago(20),
    });
    await settlePurchase(ref, paid(amountHalalas));
    return (await rowsOf(ref))[0];
  }

  it(`owes up to ${CHAIR_CREDIT_MAX_HALALAS / 100} SAR as wallet credit, not a card refund`, async () => {
    const row = await lateTreat(CHAIR_CREDIT_MAX_HALALAS);
    expect(row.status).toBe("paid");
    expect((row.raw as { owedCredit?: number }).owedCredit).toBe(CHAIR_CREDIT_MAX_HALALAS);
    expect(row.treatBookingId).toBeNull();
  });

  it("refunds anything more to her card", async () => {
    const row = await lateTreat(CHAIR_CREDIT_MAX_HALALAS + 500);
    expect(row.status).toBe("refunded");
  });
});

describe("#5 a refund made outside the app", () => {
  it("records it and freezes the gift card it bought", async () => {
    const intent: GiftIntent = {
      kind: "gift_card", amountSar: 75, designId: null, buyerName: TAG, buyerEmail: null,
      recipientName: "Mom", recipientEmail: null, message: null, lang: "en",
    };
    const ref = randomUUID();
    await db.insert(payments).values({
      provider: "fake", providerRef: ref, method: "card", amountHalalas: 7500, status: "pending", raw: { intent },
    });
    await settlePurchase(ref, paid(7500));
    const [before] = await rowsOf(ref);
    expect(before.giftCardId).not.toBeNull();

    vi.spyOn(fakeDriver, "refundedHalalas").mockResolvedValue(7500);
    process.env.STREAMPAY_WEBHOOK_SECRET = "whsec_test";
    const body = JSON.stringify({ event_type: "PAYMENT_REFUNDED", data: { metadata: { ref } } });
    const t = String(Math.floor(Date.now() / 1000));
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
    await webhook(new Request("http://x", { method: "POST", body, headers: { "x-webhook-signature": sig } }));

    const [after] = await rowsOf(ref);
    expect(after.status).toBe("refunded");
    const [card] = await db.select().from(giftCards).where(eq(giftCards.id, before.giftCardId!));
    expect(card.status).toBe("cancelled");
    const back = await db.select().from(refunds).where(eq(refunds.paymentId, after.id));
    expect(back.map((r) => r.reason)).toEqual(["outside-app"]);
  });
});

describe("#16 the same points from two tabs", () => {
  it("lets only one booking spend them", async () => {
    const [customer] = await db.insert(customers).values({ phone: "0500000097" }).returning();
    await db.insert(loyaltyTxns).values({ customerId: customer.id, bookingId: null, deltaPoints: 50, reason: "test-grant" });
    const book = (hours: number) =>
      createBookings({
        branchId: f.branchA,
        startsAt: new Date(FUTURE + hours * 3_600_000).toISOString(),
        customer: { phone: "0500000097" },
        customerId: customer.id,
        source: "web",
        status: "pending",
        redeemPoints: 50,
        members: [{ serviceId: f.svcA.id, addonIds: [] }],
      });

    const results = await Promise.all([book(0), book(3)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: "reward-invalid" });
  });
});

describe("the overlap rule", () => {
  it("refuses two live bookings that overlap on one chair", async () => {
    const [chair] = await db.select({ id: stations.id }).from(stations).where(eq(stations.branchId, f.branchA)).limit(1);
    const [customer] = await db.insert(customers).values({ phone: "0500000098" }).returning();
    const row = (code: string, startMin: number) => ({
      code, branchId: f.branchA, customerId: customer.id, stationId: chair.id, serviceId: f.svcA.id,
      startsAt: new Date(FUTURE + startMin * 60_000), endsAt: new Date(FUTURE + (startMin + 60) * 60_000),
      status: "confirmed" as const, source: "web" as const, serviceName: { ar: "اختبار", en: "test" },
    });
    await db.insert(bookings).values(row("RON-OVL1", 0));
    await expect(db.insert(bookings).values(row("RON-OVL2", 30))).rejects.toThrow();
    // Back to back is fine.
    await db.insert(bookings).values(row("RON-OVL3", 60));
    await db.delete(bookings).where(inArray(bookings.code, ["RON-OVL1", "RON-OVL3"]));
  });
});

describe("#1 gift card limits", () => {
  it("refuses the sixth new checkout in an hour from one address", async () => {
    const [value] = await db.select().from(giftCardValues).where(eq(giftCardValues.active, true)).limit(1);
    expect(value, "the seed needs an active gift card amount").toBeTruthy();
    // A fresh address each run, with the port Azure adds: the limit is counted
    // in the database, so a rerun within the hour must not inherit this one's.
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const post = () =>
      giftCards_(
        new Request("http://x/api/gift-cards", {
          method: "POST",
          headers: { "x-forwarded-for": `${ip}:${1000 + Math.floor(Math.random() * 9000)}` },
          body: JSON.stringify({ amountSar: value.amountHalalas / 100, recipientName: "Sarah", buyerName: TAG }),
        }),
      );
    for (let i = 0; i < 5; i++) expect((await post()).ok).toBe(true);
    expect((await post()).status).toBe(429);
  });
});

describe("#5 + #22 the daily comparison with StreamPay", () => {
  it("records a refund we missed, and names a payment we never recorded", async () => {
    const intent: GiftIntent = {
      kind: "gift_card", amountSar: 75, designId: null, buyerName: TAG, buyerEmail: null,
      recipientName: "Mom", recipientEmail: null, message: null, lang: "en",
    };
    const ref = randomUUID();
    const paymentId = `pay-${randomUUID()}`;
    await db.insert(payments).values({
      provider: "fake", providerRef: ref, method: "card", amountHalalas: 7500, status: "pending", raw: { intent },
    });
    await settlePurchase(ref, { status: "paid", amountHalalas: 7500, method: "mada", raw: { paymentId } });

    vi.spyOn(fakeDriver, "listPayments").mockResolvedValue([
      { id: paymentId, state: "refunded", amountHalalas: 7500 },
      { id: "pay-nobody-knows", state: "paid", amountHalalas: 12000 },
    ]);
    vi.spyOn(fakeDriver, "refundedHalalas").mockResolvedValue(7500);

    const out = await compareWithGateway();

    expect((await rowsOf(ref))[0].status).toBe("refunded");
    expect(out.unknown.map((u) => u.amount_halalas)).toEqual([12000]);
  });
});
