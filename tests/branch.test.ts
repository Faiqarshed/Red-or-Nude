// What this branch added, asserted feature by feature.
//
// The existing suites already cover the chair race, ticket queues, party holds,
// pack credits, the cancel route and the day boundary. This one takes the rest
// of the branch: the discount stack and the order it runs in, the flat refill,
// the reward ladder, the floor's colours, and the field rules that keep a form
// and its server action agreeing.
//
// Dates carry their own clock wherever one is involved — a suite that reads the
// wall clock passes in March and fails in April.

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { addons, bookings, payments, services } from "@/lib/db/schema";
import { createBooking, createBookings, bookingSummaries, releaseWebHold } from "@/lib/bookings";
import { confirmBookingPayment } from "@/lib/payments/confirm";
import { buildBookingInvoice } from "@/lib/invoice/data";
import { renderInvoiceEmail } from "@/lib/invoice/template";
import { halalasToSar, sarToHalalas, shareAmount, splitGroupPrice, vatIncludedIn } from "@/lib/money";
import { promoDiscount, normalizePromoCode } from "@/lib/promo";
import {
  milestonesReached,
  pointsEarned,
  redeemable,
  rewardDiscount,
  rewardRefusal,
  type LoyaltyRules,
} from "@/lib/rewards";
import { statusPulse } from "@/lib/booking-pulse";
import { formatTicketNo } from "@/lib/tickets";
import { maskEmail } from "@/lib/otp";
import {
  formatNational,
  latinDigits,
  toNationalDigits,
  toStoredPhone,
  validateSaudiMobile,
} from "@/lib/phone";
import { checkBirthday, checkEmail, checkNote, checkPersonName } from "@/lib/admin/validate";
import { validationMessages } from "@/lib/validation-messages";
import { utcToLocalDate } from "@/lib/availability";
import { getSettings } from "@/lib/settings";
import { FUTURE, TEST_PHONE, fixtures, reset, groupRows, type Fixtures } from "./helpers";

const v = validationMessages.en;
const DAY = 86_400_000;

let f: Fixtures;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

// ---------------------------------------------------------------------------

describe("the discount stack, in the order it runs", () => {
  it("gives a group its discount and a solo booking none", async () => {
    const { group_discount_percent: percent } = await getSettings(["group_discount_percent"]);

    const solo = splitGroupPrice([20_000], 0);
    expect(solo[0].discountHalalas).toBe(0);
    expect(solo[0].totalHalalas).toBe(20_000);

    const pair = splitGroupPrice([20_000, 20_000], percent);
    const discount = pair.reduce((s, p) => s + p.discountHalalas, 0);
    expect(discount).toBe(Math.round(40_000 * percent / 100));
    // The guests' totals still add to the bill, to the halala.
    expect(pair.reduce((s, p) => s + p.totalHalalas, 0)).toBe(40_000 - discount);
  });

  it("rounds the group discount once, off the combined bill", () => {
    // Three guests at an odd price: rounding each share separately would lose or
    // invent a halala, which is why shareAmount exists.
    const grosses = [3_333, 3_333, 3_334];
    const split = splitGroupPrice(grosses, 10);
    const total = grosses.reduce((a, b) => a + b, 0);
    expect(split.reduce((s, p) => s + p.discountHalalas, 0)).toBe(Math.round(total * 0.1));
    expect(split.reduce((s, p) => s + p.totalHalalas, 0)).toBe(total - Math.round(total * 0.1));
  });

  it("never over- or under-allocates a shared amount, whatever the weights", () => {
    const cases: [number[], number][] = [
      [[1], 7],
      [[1, 1, 1], 100],
      [[1, 2, 97], 33],
      [[5_000, 5_000, 5_001], 999],
      [[0, 10_000], 500],
    ];
    for (const [weights, amount] of cases) {
      const shares = shareAmount(weights, amount);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(shares.every((s) => s >= 0)).toBe(true);
    }
    // Nothing to share, or nothing to share it over.
    expect(shareAmount([1, 1], 0)).toEqual([0, 0]);
    expect(shareAmount([0, 0], 100)).toEqual([0, 0]);
  });

  it("takes VAT out of the discounted total rather than adding it on", () => {
    // Prices are shown VAT-inclusive, so the customer pays exactly what she saw.
    const total = 23_000;
    const vat = vatIncludedIn(total, 15);
    expect(vat).toBe(total - Math.round((total * 100) / 115));
    expect(total - vat + vat).toBe(total);
    // Never more than the total it came out of.
    expect(vat).toBeLessThan(total);
    expect(vatIncludedIn(0, 15)).toBe(0);
  });

  it("caps a promo at the bill, so a code can never hand money back", () => {
    const fixed = { type: "fixed" as const, value: 50_000, minTotalHalalas: 0, startsAt: null, endsAt: null, maxUses: null, uses: 0, active: true };
    expect(promoDiscount(fixed, 20_000)).toBe(20_000);
    expect(promoDiscount(fixed, 0)).toBe(0);

    const percent = { ...fixed, type: "percent" as const, value: 100 };
    expect(promoDiscount(percent, 20_000)).toBe(20_000);
    expect(promoDiscount({ ...percent, value: 10 }, 20_001)).toBe(Math.round(20_001 * 0.1));
  });

  it("reads a code in any casing and any spacing", () => {
    expect(normalizePromoCode("  eid25 ")).toBe("EID25");
    expect(normalizePromoCode("Sara")).toBe("SARA");
  });
});

// ---------------------------------------------------------------------------

/** The salon's defaults, so these read as the rule the client actually stated. */
const RULES: LoyaltyRules = {
  firstSar: 199,
  stepSar: 200,
  stepPoints: 50,
  pointHalalas: 20,
};

describe("the milestone rule", () => {
  // The client's rule, in their own numbers: "spend 199, get 50 points worth 10
  // riyals — and if a person spends 350 we still give 50, because they haven't
  // touched 399".
  it("awards at 199 and every 200 after, and nothing in between", () => {
    expect(pointsEarned(sarToHalalas(198.99), RULES)).toBe(0);
    expect(pointsEarned(sarToHalalas(199), RULES)).toBe(50);
    expect(pointsEarned(sarToHalalas(350), RULES)).toBe(50);
    expect(pointsEarned(sarToHalalas(398.99), RULES)).toBe(50);
    expect(pointsEarned(sarToHalalas(399), RULES)).toBe(100);
    expect(pointsEarned(sarToHalalas(599), RULES)).toBe(150);
  });

  it("never earns from a bill that reaches nothing", () => {
    expect(pointsEarned(0, RULES)).toBe(0);
    expect(pointsEarned(-1, RULES)).toBe(0);
    expect(pointsEarned(sarToHalalas(1), RULES)).toBe(0);
  });

  it("is always a whole, non-negative number of points", () => {
    for (const sar of [0, 1, 198.99, 199, 199.01, 350, 399, 1234.56, 99_999]) {
      const earned = pointsEarned(sarToHalalas(sar), RULES);
      expect(Number.isInteger(earned)).toBe(true);
      expect(earned).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses to divide by a zeroed setting rather than returning Infinity", () => {
    expect(pointsEarned(sarToHalalas(500), { ...RULES, stepSar: 0 })).toBe(0);
    expect(pointsEarned(sarToHalalas(500), { ...RULES, firstSar: 0 })).toBe(0);
    expect(milestonesReached(sarToHalalas(500), { ...RULES, stepSar: 0 })).toBe(0);
  });

  // Per-bill accrual is a deliberate choice, not an oversight — see the
  // ponytail note in lib/rewards.ts. This pins the consequence so that if
  // anybody ever moves to lifetime accrual, they do it knowingly.
  it("is per bill, so two visits earn more than one bill of the same size", () => {
    const twice = pointsEarned(sarToHalalas(199), RULES) * 2;
    const once = pointsEarned(sarToHalalas(398), RULES);
    expect(twice).toBe(100);
    expect(once).toBe(50);
  });
});

describe("spending points", () => {
  it("only accepts whole steps", () => {
    expect(rewardRefusal(50, 10_000, RULES)).toBeNull();
    expect(rewardRefusal(100, 10_000, RULES)).toBeNull();
    // Not a multiple of the step, however affordable.
    expect(rewardRefusal(37, 10_000, RULES)).toBe("unknown");
    expect(rewardRefusal(75, 10_000, RULES)).toBe("unknown");
    expect(rewardRefusal(0, 10_000, RULES)).toBe("unknown");
    expect(rewardRefusal(-50, 10_000, RULES)).toBe("unknown");
    expect(rewardRefusal(50.5, 10_000, RULES)).toBe("unknown");
  });

  it("names a balance that cannot reach the amount", () => {
    expect(rewardRefusal(50, 49, RULES)).toBe("locked");
    // Exactly enough is enough.
    expect(rewardRefusal(50, 50, RULES)).toBeNull();
    expect(rewardRefusal(100, 99, RULES)).toBe("locked");
  });

  it("prices 50 points at exactly 10 riyals", () => {
    expect(rewardDiscount(50, sarToHalalas(200), RULES)).toBe(sarToHalalas(10));
    expect(rewardDiscount(100, sarToHalalas(200), RULES)).toBe(sarToHalalas(20));
  });

  it("caps a reward at the bill, as a promo is capped", () => {
    expect(rewardDiscount(50, 0, RULES)).toBe(0);
    expect(rewardDiscount(50, -500, RULES)).toBe(0);
    // 100 points is 20 SAR, but the bill is only 5 — it must never refund.
    expect(rewardDiscount(100, sarToHalalas(5), RULES)).toBe(sarToHalalas(5));
  });

  it("offers nothing it would waste, and nothing she cannot afford", () => {
    // Balance below one step: nothing on offer.
    expect(redeemable(49, sarToHalalas(500), RULES)).toEqual([]);
    // Plenty of points, small bill: stops at the step that covers it.
    expect(redeemable(500, sarToHalalas(10), RULES)).toEqual([50]);
    // 150 points is 30 SAR — the first step that *covers* a 25 SAR bill, and
    // so the last one worth showing. The ones past it are pure waste.
    expect(redeemable(500, sarToHalalas(25), RULES)).toEqual([50, 100, 150]);
    // Bounded by the balance too.
    expect(redeemable(100, sarToHalalas(1_000), RULES)).toEqual([50, 100]);
    // Nothing to discount.
    expect(redeemable(500, 0, RULES)).toEqual([]);
  });
});

;

// ---------------------------------------------------------------------------

describe("a refill is a flat price, whatever the service costs", () => {
  async function servedBooking(email: string) {
    await db.update(services).set({ refillDays: 30 }).where(eq(services.id, f.svcA.id));
    const made = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: new Date(Date.now() - DAY).toISOString(),
      customer: { phone: TEST_PHONE, email },
      source: "web",
    });
    if (!made.ok) throw new Error(made.error);
    await db.update(bookings).set({ status: "completed" }).where(eq(bookings.id, made.id));
    return made.code;
  }

  it("charges the flat refill price rather than a percentage of the service", async () => {
    const { refill_price_halalas: flat, vat_percent } = await getSettings([
      "refill_price_halalas",
      "vat_percent",
    ]);
    const code = await servedBooking("refill@example.com");

    const result = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(Date.now() + DAY).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "refill@example.com" },
      source: "web",
      status: "pending",
      refillOfCode: code,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The whole point of the flat price: it does not track the service price.
    expect(result.totalHalalas).toBe(flat);
    expect(result.totalHalalas).not.toBe(f.svcA.priceHalalas);

    const [row] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, result.bookings[0].id));
    expect(row.servicePriceHalalas).toBe(flat);
    expect(row.refillOfBookingId).not.toBeNull();
    // VAT still comes out of the discounted total, not on top of it.
    expect(row.vatHalalas).toBe(vatIncludedIn(flat, vat_percent));
    expect(row.subtotalHalalas + row.vatHalalas).toBe(row.totalHalalas);
  });

  it("refuses an appointment past the window, and says so differently from a lapsed offer", async () => {
    const code = await servedBooking("window@example.com");

    const tooLate = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(Date.now() + 60 * DAY).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "window@example.com" },
      source: "web",
      status: "pending",
      refillOfCode: code,
    });
    // The offer stands; the date is outside it. A different answer from "gone".
    expect(tooLate).toMatchObject({ ok: false, error: "refill-window" });

    const noSuchCode = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(Date.now() + DAY).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "window@example.com" },
      source: "web",
      status: "pending",
      refillOfCode: "RON-NOPE1",
    });
    expect(noSuchCode).toMatchObject({ ok: false, error: "refill-expired" });
  });

  it("is one guest and the same service, never a party", async () => {
    const code = await servedBooking("solo@example.com");

    const asGroup = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(Date.now() + DAY).toISOString(),
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcA.id, addonIds: [] },
      ],
      customer: { phone: TEST_PHONE, email: "solo@example.com" },
      source: "web",
      status: "pending",
      refillOfCode: code,
    });
    expect(asGroup).toMatchObject({ ok: false, error: "invalid-service" });

    const wrongService = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(Date.now() + DAY).toISOString(),
      members: [{ serviceId: f.svcB.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "solo@example.com" },
      source: "web",
      status: "pending",
      refillOfCode: code,
    });
    expect(wrongService).toMatchObject({ ok: false, error: "invalid-service" });
  });

  it("spends the window once, so a second refill finds nothing", async () => {
    const code = await servedBooking("once@example.com");

    const first = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(Date.now() + DAY).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "once@example.com" },
      source: "web",
      status: "pending",
      refillOfCode: code,
    });
    expect(first.ok).toBe(true);

    const second = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(Date.now() + 2 * DAY).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "once@example.com" },
      source: "web",
      status: "pending",
      refillOfCode: code,
    });
    // `bookings_refill_of_unique` decides it, not a read two requests could pass.
    expect(second).toMatchObject({ ok: false, error: "refill-expired" });
  });
});

// ---------------------------------------------------------------------------

describe("a checkout treat is 10 riyals however the bill is discounted", () => {
  it("keeps an at-checkout add-on out of the group discount entirely", async () => {
    const [treat] = await db
      .select()
      .from(addons)
      .where(eq(addons.atCheckout, true))
      .limit(1);
    if (!treat) return; // no upsell seeded

    const { group_discount_percent: percent } = await getSettings(["group_discount_percent"]);
    if (!percent) return;

    const withTreat = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      members: [
        { serviceId: f.svcA.id, addonIds: [treat.id] },
        { serviceId: f.svcA.id, addonIds: [] },
      ],
      customer: { phone: TEST_PHONE, email: "treat@example.com" },
      source: "web",
      status: "pending",
    });
    expect(withTreat.ok).toBe(true);
    if (!withTreat.ok) return;

    await reset(f.branchA, f.branchB);

    const without = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcA.id, addonIds: [] },
      ],
      customer: { phone: TEST_PHONE, email: "treat@example.com" },
      source: "web",
      status: "pending",
    });
    expect(without.ok).toBe(true);
    if (!without.ok) return;

    // Ten riyals is ten riyals: the treat adds its full price, undiscounted.
    expect(withTreat.totalHalalas - without.totalHalalas).toBe(treat.priceHalalas);
  });
});

// ---------------------------------------------------------------------------

describe("a party is one bill and one unit", () => {
  it("holds every guest to the party's day and refuses two days", async () => {
    const day = new Date(FUTURE);
    const nextDay = new Date(FUTURE + DAY);

    const split = await createBookings({
      branchId: f.branchA,
      startsAt: day.toISOString(),
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        { serviceId: f.svcA.id, addonIds: [], startsAt: nextDay.toISOString() },
      ],
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
    });
    expect(split).toMatchObject({ ok: false, error: "different-day" });
  });

  it("lets each guest take her own branch and hour on that one day", async () => {
    const at = new Date(FUTURE);
    const later = new Date(FUTURE + 3 * 3_600_000);
    expect(utcToLocalDate(at)).toBe(utcToLocalDate(later));

    const party = await createBookings({
      branchId: f.branchA,
      startsAt: at.toISOString(),
      members: [
        { serviceId: f.svcA.id, addonIds: [] },
        {
          serviceId: f.svcA.id,
          addonIds: [],
          branchId: f.branchB,
          startsAt: later.toISOString(),
        },
      ],
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
    });
    expect(party.ok).toBe(true);
    if (!party.ok) return;

    const rows = await groupRows(party.groupId!);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.branchId).sort()).toEqual([f.branchA, f.branchB].sort());
    expect(rows.every((r) => r.groupId === party.groupId)).toBe(true);
    // One customer across the party — which is what makes one reference open it.
    expect(new Set(rows.map((r) => r.customerId)).size).toBe(1);
  });

  it("opens the whole party from any one guest's reference", async () => {
    const party = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      members: [
        { serviceId: f.svcA.id, addonIds: [], guestName: "Noura" },
        { serviceId: f.svcA.id, addonIds: [], guestName: "Sara" },
      ],
      customer: { phone: TEST_PHONE, email: "party@example.com" },
      source: "web",
      status: "pending",
    });
    expect(party.ok).toBe(true);
    if (!party.ok) return;

    const summaries = await bookingSummaries({ code: party.bookings[1].code });
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.groupSize === 2)).toBe(true);
  });

  it("sends a booking confirmation that links StreamPay's tax invoice, not a second one", async () => {
    const party = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "vat@example.com" },
      source: "web",
      status: "pending",
    });
    if (!party.ok) throw new Error(party.error);
    const [b] = party.bookings;
    const url = "https://streampay.sa/s/test-invoice";
    await db.insert(payments).values({
      bookingId: b.id, provider: "streampay", providerRef: randomUUID(), method: "mada",
      amountHalalas: b.totalHalalas, status: "paid", raw: { invoiceUrl: url },
    });

    const invoice = await buildBookingInvoice([b.id]);
    expect(invoice?.taxInvoiceUrl).toBe(url);
    const { html, text } = renderInvoiceEmail(invoice!);
    expect(html).toContain(url);
    expect(text).toContain(url);
    // No second set of VAT figures to disagree with StreamPay's.
    expect(html).not.toMatch(/VAT no\.|Subtotal \(excl\. VAT\)|Tax Invoice/);
  });

  it("leaves out a checkout she opened and walked away from", async () => {
    const party = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "pending",
    });
    if (!party.ok) throw new Error(party.error);
    const made = party.bookings[0];
    // Fresh: still hers to pay, so still listed.
    expect(await bookingSummaries({ code: made.code })).toHaveLength(1);

    // Past the payment window with no checkout open: gone, before and after the sweep.
    await db.update(bookings).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(bookings.code, made.code));
    expect(await bookingSummaries({ code: made.code })).toHaveLength(0);
    await db.update(bookings).set({ status: "cancelled", cancelReason: "payment-timeout" }).where(eq(bookings.code, made.code));
    expect(await bookingSummaries({ code: made.code })).toHaveLength(0);

    // A cancellation the salon made still shows.
    await db.update(bookings).set({ cancelReason: "salon" }).where(eq(bookings.code, made.code));
    expect(await bookingSummaries({ code: made.code })).toHaveLength(1);
  });

  it("never returns a name, a phone, an address or a chair to a reference holder", async () => {
    const made = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE, name: "Private Person", email: "private@example.com" },
      source: "web",
    });
    if (!made.ok) throw new Error(made.error);

    const [summary] = await bookingSummaries({ code: made.code });
    // The shape is a privacy boundary, not a view model.
    const keys = Object.keys(summary);
    for (const leaked of ["name", "customerName", "phone", "email", "stationId", "notes"]) {
      expect(keys).not.toContain(leaked);
    }
    expect(JSON.stringify(summary)).not.toContain("Private Person");
    expect(JSON.stringify(summary)).not.toContain("private@example.com");
  });
});

// ---------------------------------------------------------------------------

describe("going back from checkout gives the chair up", () => {
  it("releases an unpaid hold to the address that made it, and nobody else", async () => {
    const made = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "held@example.com" },
      source: "web",
      status: "pending",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const code = made.bookings[0].code;

    // Wrong address: the same "no" an unknown code gets.
    expect(await releaseWebHold(code, "someone@example.com")).toBe(false);
    // Right address, any casing.
    expect(await releaseWebHold(code, "Held@Example.com")).toBe(true);

    const [row] = await db.select().from(bookings).where(eq(bookings.code, code));
    expect(row.status).toBe("cancelled");
    // Let go early is the same thing the sweep writes, so credits and points
    // come back under rules that already exist.
    expect(row.cancelReason).toBe("payment-timeout");

    // Releasing twice is not an error and changes nothing.
    expect(await releaseWebHold(code, "held@example.com")).toBe(false);
  });

  it("will not release a confirmed booking, only a hold", async () => {
    const made = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: TEST_PHONE, email: "paid@example.com" },
      source: "web",
      status: "pending",
    });
    if (!made.ok) throw new Error(made.error);

    const paid = await confirmBookingPayment({ code: made.bookings[0].code });
    expect(paid.ok).toBe(true);

    expect(await releaseWebHold(made.bookings[0].code, "paid@example.com")).toBe(false);
    const [row] = await db.select().from(bookings).where(eq(bookings.code, made.bookings[0].code));
    expect(row.status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------

describe("the floor's colours track the service, not the paperwork", () => {
  it("lights a checked-in customer as waiting", () => {
    expect(statusPulse({ status: "checked_in" })).toContain("animate-row-checkin");
  });

  it("pulses only while the technician has not finished", () => {
    expect(statusPulse({ status: "in_progress" })).toContain("animate-running-pulse");
    // Finished mid-service: the light settles even though the ticket is open.
    expect(statusPulse({ status: "in_progress", finishedAt: "2031-05-14T09:00:00Z" })).not.toContain(
      "animate-running-pulse",
    );
  });

  it("changes nothing when the desk finally closes the ticket", () => {
    const finished = statusPulse({ status: "in_progress", finishedAt: "2031-05-14T09:00:00Z" });
    const closed = statusPulse({ status: "completed", finishedAt: "2031-05-14T09:00:00Z" });
    expect(closed).toBe(finished);
  });

  it("keeps quiet for the states with no light of their own", () => {
    for (const status of ["pending", "confirmed", "cancelled", "no_show"] as const) {
      expect(statusPulse({ status })).toBe("");
    }
  });

  it("respects a reader who asked for no motion", () => {
    for (const status of ["checked_in", "in_progress"] as const) {
      expect(statusPulse({ status })).toContain("motion-reduce:animate-none");
    }
  });
});

// ---------------------------------------------------------------------------

describe("ticket numbers read aloud", () => {
  it("rolls into a letter rather than growing a digit", () => {
    expect(formatTicketNo(1)).toBe("A1");
    // Ninety-nine to a letter, not a hundred: A99 is the 99th and B1 the 100th.
    expect(formatTicketNo(99)).toBe("A99");
    expect(formatTicketNo(100)).toBe("B1");
    expect(formatTicketNo(198)).toBe("B99");
    expect(formatTicketNo(199)).toBe("C1");
    // And it wraps rather than growing a second letter.
    expect(formatTicketNo(99 * 26 + 1)).toBe("A1");
  });
});

// ---------------------------------------------------------------------------

describe("a Saudi mobile, however it was pasted", () => {
  it("lands on one stored shape from every spelling people use", () => {
    for (const typed of [
      "0512345678",
      "512345678",
      "+966512345678",
      "966512345678",
      "00966512345678",
      "+966 51 234 5678",
      "051-234-5678",
    ]) {
      expect(toStoredPhone(typed)).toBe("0512345678");
    }
  });

  it("reads an Arabic keyboard", () => {
    expect(latinDigits("٠٥١٢٣٤٥٦٧٨")).toBe("0512345678");
    expect(toStoredPhone("٠٥١٢٣٤٥٦٧٨")).toBe("0512345678");
  });

  it("names which rule a number broke", () => {
    expect(validateSaudiMobile("")).toBe("required");
    expect(validateSaudiMobile("05123")).toBe("length");
    // 01x-04x are landlines and cannot receive what this number exists for.
    expect(validateSaudiMobile("0412345678")).toBe("prefix");
    expect(validateSaudiMobile("0512345678")).toBeNull();
  });

  it("drops digits past the ninth rather than reordering them", () => {
    expect(toNationalDigits("05123456789999")).toBe("512345678");
  });

  it("groups for reading without changing what is submitted", () => {
    expect(formatNational("0512345678")).toBe("51 234 5678");
    expect(toStoredPhone(formatNational("0512345678"))).toBe("0512345678");
  });
});

// ---------------------------------------------------------------------------

describe("the admin form says which field is wrong", () => {
  it("accepts a real name in either script and refuses what is not one", () => {
    expect(checkPersonName(v, "Name", "Noura Al Saud")).toBeUndefined();
    expect(checkPersonName(v, "Name", "نورة السعود")).toBeUndefined();
    expect(checkPersonName(v, "Name", "", { required: true })).toBeDefined();
    // Not a name: digits and markup have no business in one.
    expect(checkPersonName(v, "Name", "<script>")).toBeDefined();
  });

  it("accepts an address and refuses a shape that is not one", () => {
    expect(checkEmail(v, "Email", "sara@example.com")).toBeUndefined();
    expect(checkEmail(v, "Email", "sara@")).toBeDefined();
    expect(checkEmail(v, "Email", "sara example.com")).toBeDefined();
    expect(checkEmail(v, "Email", "", { required: true })).toBeDefined();
    // Optional by default, so a blank one passes unless asked for.
    expect(checkEmail(v, "Email", "")).toBeUndefined();
  });

  it("bounds a note rather than writing an unbounded string to the row", () => {
    expect(checkNote(v, "Reason", "Customer rang to cancel", { max: 200 })).toBeUndefined();
    expect(checkNote(v, "Reason", "x".repeat(201), { max: 200 })).toBeDefined();
    expect(checkNote(v, "Reason", "", { required: true, max: 200 })).toBeDefined();
  });

  it("will not take a birthday in the future or from before anyone alive", () => {
    const today = "2031-05-14";
    expect(checkBirthday(v, "Birthday", "1995-03-02", today)).toBeUndefined();
    // The range ends yesterday, so today itself is already too new.
    expect(checkBirthday(v, "Birthday", "2031-05-13", today)).toBeUndefined();
    expect(checkBirthday(v, "Birthday", today, today)).toBeDefined();
    expect(checkBirthday(v, "Birthday", "2031-05-15", today)).toBeDefined();
    expect(checkBirthday(v, "Birthday", "1830-01-01", today)).toBeDefined();
    // Blank is allowed — a customer who would rather not say still gets an account.
    expect(checkBirthday(v, "Birthday", "", today)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("small helpers with money or privacy behind them", () => {
  it("masks an address enough to recognise and not enough to harvest", () => {
    expect(maskEmail("sara@gmail.com")).toBe("s•••@gmail.com");
    expect(maskEmail("a@b.com")).toBe("a•@b.com");
    expect(maskEmail("notanemail")).toBe("•••");
  });

  it("converts riyals and halalas without losing a halala", () => {
    expect(sarToHalalas(99)).toBe(9_900);
    expect(sarToHalalas(0.01)).toBe(1);
    expect(sarToHalalas(10.005)).toBe(1_001); // rounded, not truncated
    expect(halalasToSar(9_900)).toBe(99);
    for (const sar of [0, 1, 49.5, 99.99, 2_000]) {
      expect(halalasToSar(sarToHalalas(sar))).toBeCloseTo(sar, 2);
    }
  });
});
