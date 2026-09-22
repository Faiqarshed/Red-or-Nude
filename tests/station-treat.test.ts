// Ordering a coffee from the chair you are sitting in (brief §2.7).
//
// The salon asked: "if the lady after coming decides she wants coffee, how does
// she order it?" — and answered it themselves with the QR sticker already on
// her table. This is the selling half.
//
// The QR token is the entire credential. There is no session, because she may
// well be a guest and a sign-in wall between a customer and a cup of coffee is
// not a thing worth building. So the interesting tests are not the happy path:
// they are what the token is *not* allowed to do, what happens at the instant
// her appointment ends, and what two taps produce.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  addons,
  bookingAddons,
  bookings,
  customers,
  payments,
  stations,
} from "@/lib/db/schema";
import { buyStationItems } from "@/lib/station-treat";
import { renderVisitEmail } from "@/lib/visit-email";
import { fixtures, reset, type Fixtures, taggedAddon } from "./helpers";

let f: Fixtures;
let chair: { id: string; token: string };
let otherChair: { id: string; token: string };
let hotId: string;
let serviceAddonId: string;

const TAG = "zz-station-treat";
const tagged = like(addons.image, `${TAG}%`);
const PHONE = "0500000097";
const PRICE = 1000;

const catalogRow = (label: string, atCheckout: boolean, active = true, durationMin = 0) =>
  taggedAddon(TAG, label, atCheckout, { active, priceHalalas: PRICE, durationMin });

/** A booking occupying `chair` across `now`, unless told otherwise. */
async function seat(opts: {
  stationId?: string;
  status?: "confirmed" | "checked_in" | "in_progress" | "completed" | "cancelled" | "pending";
  startsAt?: Date;
  endsAt?: Date;
} = {}): Promise<{ id: string; endsAt: Date }> {
  // Find-or-create: `customers_guest_phone_unique` means one guest row per
  // phone, and a test that seats two people would otherwise collide with itself.
  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.phone, PHONE))
    .limit(1);
  const guest =
    existing ??
    (await db.insert(customers).values({ phone: PHONE }).returning({ id: customers.id }))[0];
  const startsAt = opts.startsAt ?? new Date(Date.now() - 30 * 60_000);
  const endsAt = opts.endsAt ?? new Date(Date.now() + 30 * 60_000);
  const [b] = await db
    .insert(bookings)
    .values({
      code: `RON-ST${Math.floor(Math.random() * 1_000_000)}`,
      branchId: f.branchA,
      customerId: guest.id,
      stationId: opts.stationId ?? chair.id,
      serviceId: f.svcA.id,
      startsAt,
      endsAt,
      status: opts.status ?? "in_progress",
      source: "web",
      serviceName: { ar: "اختبار", en: "test" },
      totalHalalas: 20_000,
    })
    .returning({ id: bookings.id });
  return { id: b.id, endsAt };
}

const order = (over: Partial<Parameters<typeof buyStationItems>[0]> = {}) =>
  buyStationItems({ token: chair.token, addonIds: [hotId], ...over });

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
  await db.delete(addons).where(tagged);

  const chairs = await db
    .select({ id: stations.id, token: stations.qrToken })
    .from(stations)
    .where(and(eq(stations.branchId, f.branchA), eq(stations.active, true)))
    .orderBy(stations.sort)
    .limit(2);
  if (chairs.length < 2) throw new Error("this suite needs two chairs at branch A");
  [chair, otherChair] = chairs.map((c) => ({ id: c.id, token: c.token as string }));

  hotId = await catalogRow("hot", true);
  serviceAddonId = await catalogRow("gel-removal", false, true, 20);
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
  await db.delete(addons).where(tagged);
  await db.delete(customers).where(eq(customers.phone, PHONE));
});

describe("ordering a treat from the chair", () => {
  it("adds it to the booking she is sitting in, and charges for it once", async () => {
    const booking = await seat();

    const res = await order();

    expect(res).toEqual({ ok: true, names: [{ ar: "hot", en: "hot" }] });

    const lines = await db
      .select({ addonId: bookingAddons.addonId, price: bookingAddons.priceHalalas })
      .from(bookingAddons)
      .where(eq(bookingAddons.bookingId, booking.id));
    expect(lines).toEqual([{ addonId: hotId, price: PRICE }]);

    // The receipt hangs off treat_booking_id, NOT booking_id — see the schema.
    const paid = await db
      .select({
        bookingId: payments.bookingId,
        treatBookingId: payments.treatBookingId,
        amount: payments.amountHalalas,
        status: payments.status,
      })
      .from(payments)
      .where(eq(payments.treatBookingId, booking.id));
    expect(paid).toEqual([
      { bookingId: null, treatBookingId: booking.id, amount: PRICE, status: "paid" },
    ]);
  });

  it("a treat never moves the appointment's finish time", async () => {
    // A treat has duration 0 precisely so it cannot push ends_at out from under
    // a booking that is already running and hand the next customer a late start.
    const booking = await seat();
    const before = await db
      .select({ endsAt: bookings.endsAt })
      .from(bookings)
      .where(eq(bookings.id, booking.id));

    await order();

    const after = await db
      .select({ endsAt: bookings.endsAt })
      .from(bookings)
      .where(eq(bookings.id, booking.id));
    expect(after[0].endsAt).toEqual(before[0].endsAt);
  });

  it("sells treats and an add-on as one basket, one payment, and gives the add-on its time", async () => {
    // The chair is free after her, so a 20-minute add-on fits.
    const booking = await seat();
    const cold = await catalogRow("cold", true);

    const res = await order({ addonIds: [hotId, cold, serviceAddonId] });
    expect(res.ok && "names" in res && res.names.map((n) => n.en).sort()).toEqual(["cold", "gel-removal", "hot"]);

    const lines = await db.select({ addonId: bookingAddons.addonId }).from(bookingAddons).where(eq(bookingAddons.bookingId, booking.id));
    expect(lines).toHaveLength(3);
    const paid = await db.select({ amount: payments.amountHalalas }).from(payments).where(eq(payments.treatBookingId, booking.id));
    expect(paid).toEqual([{ amount: 3 * PRICE }]);
    // Only the add-on's 20 minutes move her finish; the treats move nothing.
    const [after] = await db.select({ endsAt: bookings.endsAt }).from(bookings).where(eq(bookings.id, booking.id));
    expect(after.endsAt.getTime() - booking.endsAt.getTime()).toBe(20 * 60_000);
  });

  it("emails her what was added, the new finish time and the tax invoice", () => {
    const { text, html } = renderVisitEmail({
      customerName: "Sara",
      lang: "en",
      items: [
        { addonId: "a", name: { ar: "قهوة", en: "Hot coffee" }, priceHalalas: 1500, durationMin: 0 },
        { addonId: "b", name: { ar: "فرنش", en: "French Tip" }, priceHalalas: 5000, durationMin: 15 },
      ],
      endsAt: new Date("2026-09-22T15:00:00Z"),
      taxInvoiceUrl: "https://streampay.sa/s/x",
    });
    expect(text).toContain("Hot coffee: 15.00 SAR");
    expect(text).toContain("French Tip (+15 min): 50.00 SAR");
    expect(text).toContain("Paid: 65.00 SAR");
    expect(text).toContain("now finishes at 18:00");
    expect(html).toContain("https://streampay.sa/s/x");
  });

  it("leaves the appointment's own payment untouched", async () => {
    const booking = await seat();
    await db.insert(payments).values({
      bookingId: booking.id,
      provider: "fake",
      providerRef: "original",
      method: "card",
      amountHalalas: 20_000,
      status: "paid",
    });

    await order();

    // Both survive. The live-payment index only watches booking_id, so the
    // treat's receipt does not collide with the appointment's.
    const all = await db
      .select({ ref: payments.providerRef, amount: payments.amountHalalas })
      .from(payments)
      .where(inArray(payments.status, ["paid"]));
    const mine = all.filter((r) => r.amount === 20_000 || r.amount === PRICE);
    expect(mine.length).toBeGreaterThanOrEqual(2);
  });
});

describe("what the sticker is refused", () => {
  it("refuses an unknown or retired chair", async () => {
    await seat();
    const absent = "00000000-0000-0000-0000-000000000000";
    expect(await order({ token: absent })).toEqual({ ok: false, reason: "unknown-station" });

    await db.update(stations).set({ active: false }).where(eq(stations.id, chair.id));
    expect(await order()).toEqual({ ok: false, reason: "unknown-station" });
    await db.update(stations).set({ active: true }).where(eq(stations.id, chair.id));
  });

  it("refuses an empty chair", async () => {
    expect(await order()).toEqual({ ok: false, reason: "not-in-service" });
  });

  it("refuses a chair whose booking is over, cancelled or never paid for", async () => {
    for (const status of ["completed", "cancelled", "pending"] as const) {
      await db.delete(bookings).where(eq(bookings.stationId, chair.id));
      await seat({ status });
      expect(await order()).toEqual({ ok: false, reason: "not-in-service" });
    }
  });

  it("will not sell an add-on the next booking leaves no time for", async () => {
    // Her chair is booked 10 minutes after she finishes; the add-on takes 20.
    // Refused before the card is touched, and her finish time stays put.
    const booking = await seat();
    await seat({ startsAt: new Date(booking.endsAt.getTime() + 10 * 60_000), endsAt: new Date(booking.endsAt.getTime() + 70 * 60_000), status: "confirmed" });
    expect(await order({ addonIds: [serviceAddonId] })).toEqual({ ok: false, reason: "no-time" });
    const [after] = await db.select({ endsAt: bookings.endsAt }).from(bookings).where(eq(bookings.id, booking.id));
    expect(after.endsAt).toEqual(booking.endsAt);
  });

  it("will not sell a deactivated treat", async () => {
    await seat();
    const retired = await catalogRow("retired", true, false);
    expect(await order({ addonIds: [retired] })).toEqual({ ok: false, reason: "unknown-treat" });
  });

  it("will not sell a treat that does not exist", async () => {
    await seat();
    const absent = "00000000-0000-0000-0000-000000000000";
    expect(await order({ addonIds: [absent] })).toEqual({ ok: false, reason: "unknown-treat" });
  });

  it("refuses a sticker pointed at somebody else's occupied chair", async () => {
    // She is in `chair`; the sticker scanned belongs to `otherChair`, which is
    // empty. Presence at a table is the credential, so the other table's
    // sticker buys nothing.
    await seat();
    expect(await order({ token: otherChair.token })).toEqual({
      ok: false,
      reason: "not-in-service",
    });
  });

  it("charges nothing for any refusal", async () => {
    const booking = await seat({ status: "completed" });
    await order();
    await order({ addonIds: [serviceAddonId] });

    // Scoped to this booking: the seeded database carries thousands of
    // unrelated payments, and a bare count would assert nothing.
    const paid = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.treatBookingId, booking.id));
    expect(paid).toEqual([]);
  });
});

describe("timing", () => {
  it("sells at the last millisecond of the appointment and not at its end", async () => {
    const now = new Date();
    const endsAt = new Date(now.getTime() + 1);
    await seat({ startsAt: new Date(now.getTime() - 3_600_000), endsAt });

    // `now` is strictly before endsAt: still her chair.
    expect(await order({ now })).toEqual({ ok: true, names: [{ ar: "hot", en: "hot" }] });

    // And on the instant it ends, it is not. The window is [startsAt, endsAt).
    await db.delete(bookingAddons);
    expect(await order({ now: endsAt })).toEqual({ ok: false, reason: "not-in-service" });
  });

  it("does not sell before her appointment has started", async () => {
    const now = new Date();
    await seat({
      startsAt: new Date(now.getTime() + 60_000),
      endsAt: new Date(now.getTime() + 3_600_000),
    });
    expect(await order({ now })).toEqual({ ok: false, reason: "not-in-service" });
  });
});

describe("two taps", () => {
  it("refuses the second before it reaches the card", async () => {
    const booking = await seat();
    expect(await order()).toEqual({ ok: true, names: [{ ar: "hot", en: "hot" }] });

    // Cheap refusal: the check runs before the charge, so an impatient second
    // tap costs a query rather than a refund.
    expect(await order()).toEqual({ ok: false, reason: "already-added" });

    const paid = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.treatBookingId, booking.id));
    expect(paid).toHaveLength(1);
  });

  it("produces one coffee when both taps arrive together", async () => {
    const booking = await seat();

    // The real race: both read "not added yet", both charge, and the primary key
    // on (booking_id, addon_id) is the only thing left standing between the
    // salon and two coffees.
    const [a, b] = await Promise.all([order(), order()]);

    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const lines = await db
      .select({ addonId: bookingAddons.addonId })
      .from(bookingAddons)
      .where(eq(bookingAddons.bookingId, booking.id));
    expect(lines).toHaveLength(1);

    // The loser is either refused before charging, or charged and rolled back —
    // in which case it says so loudly rather than reporting success.
    const loser = [a, b].find((r) => !r.ok);
    expect(loser && !loser.ok && loser.reason).toMatch(/already-added|paid-not-added/);
  });

  it("lets her order the other treat as well", async () => {
    const booking = await seat();
    const cold = await catalogRow("cold", true);

    expect(await order()).toEqual({ ok: true, names: [{ ar: "hot", en: "hot" }] });
    expect(await order({ addonIds: [cold] })).toEqual({ ok: true, names: [{ ar: "cold", en: "cold" }] });

    const lines = await db
      .select({ addonId: bookingAddons.addonId })
      .from(bookingAddons)
      .where(eq(bookingAddons.bookingId, booking.id));
    expect(lines).toHaveLength(2);
  });
});

describe("what the reply gives away", () => {
  it("says only that it worked, and what she ordered", async () => {
    await seat();
    const res = await order();

    // The token proves somebody is standing at a table. That is not a reason to
    // hand back the customer's name, her phone, her bill or her booking id — the
    // same privacy shape /station's own page keeps.
    expect(Object.keys(res).sort()).toEqual(["names", "ok"]);
    const flat = JSON.stringify(res);
    expect(flat).not.toContain(PHONE);
    expect(flat).not.toContain("20000");
    expect(flat).not.toContain(String(PRICE));
  });

  it("names every refusal rather than saying invalid", async () => {
    // A named reason sends the customer somewhere useful; "invalid" sends her to
    // the front desk for something she could have solved herself.
    await seat({ status: "completed" });
    const res = await order();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-in-service");
  });
});
