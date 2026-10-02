// Wallet credit and gift cards at the booking checkout (docs/WALLET-PLAN.md,
// build step 4).
//
// The screen sends what credit it showed paying (`walletHalalas`); the server
// works it out again under the wallet's lock and refuses when they differ, so
// a balance another tab spent is never charged at full price in silence. A
// guest proves no wallet: she spends only what the gift card she typed brings,
// and only a card whose recipient email is her checkout's. A hold that lapses
// gives its spend back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, giftCards, giftCardTxns, walletTxns } from "@/lib/db/schema";
import { createBookings, releaseWebHold } from "@/lib/bookings";
import { giftCardLeftAfter, giftCardValue, walletBalance } from "@/lib/wallet";
import { bookingLines } from "@/lib/payments/lines";
import { buildBookingInvoice } from "@/lib/invoice/data";
import { vatIncludedIn } from "@/lib/money";
import { FUTURE, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;
let price: number;
const SARA = "sara-wallet@test.local";
const GUEST = "noura-wallet@test.local";
let saraId: string;

async function credit(ownerEmail: string, halalas: number) {
  await db
    .insert(walletTxns)
    .values({ customerId: saraId, ownerEmail, deltaHalalas: halalas, reason: "correction", note: "test" });
}

/** A card; with no recipient email (one the desk issued), the code alone is the card. */
async function card(code: string, halalas: number, recipientEmail: string | null) {
  await db.insert(giftCards).values({ code, initialHalalas: halalas, balanceHalalas: halalas, recipientEmail });
}

const cardRow = async (code: string) => (await db.select().from(giftCards).where(eq(giftCards.code, code)))[0];

/** Sara signed in, or a guest, booking svcA an hour apart per `slot`. */
function book(
  who: "sara" | "guest",
  extra: { walletHalalas?: number; giftCardCode?: string; email?: string } = {},
  slot = 0,
) {
  return createBookings({
    branchId: f.branchA,
    startsAt: new Date(FUTURE + slot * 3_600_000).toISOString(),
    customer: who === "sara" ? { phone: "0500000094", email: SARA } : { phone: "0500000095", email: extra.email ?? GUEST },
    customerId: who === "sara" ? saraId : null,
    source: "web",
    status: "pending",
    members: [{ serviceId: f.svcA.id, addonIds: [] }],
    walletHalalas: extra.walletHalalas,
    giftCardCode: extra.giftCardCode,
  });
}

const rowOf = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];
const spends = (email: string) =>
  db.select().from(walletTxns).where(and(eq(walletTxns.ownerEmail, email), eq(walletTxns.reason, "spend")));

beforeEach(async () => {
  f = await fixtures();
  price = f.svcA.priceHalalas;
  await reset(f.branchA, f.branchB);
  const [sara] = await db
    .insert(customers)
    .values({ phone: "0500000094", email: SARA, emailVerifiedAt: new Date() })
    .returning({ id: customers.id });
  saraId = sara.id;
});

afterEach(async () => {
  await reset(f.branchA, f.branchB);
  const cards = db.select({ id: giftCards.id }).from(giftCards).where(like(giftCards.code, "WALL-%"));
  await db.delete(giftCardTxns).where(inArray(giftCardTxns.giftCardId, cards));
  await db.delete(giftCards).where(like(giftCards.code, "WALL-%"));
});

describe("her credit at the booking checkout", () => {
  it("pays part of the bill, and the card is charged the rest", async () => {
    await credit(SARA, 5_000);
    const r = await book("sara", { walletHalalas: 5_000 });
    if (!r.ok) throw new Error(r.error);

    expect(r.totalHalalas).toBe(price - 5_000);
    expect(r.walletSpent).toBe(5_000);
    const row = await rowOf(r.bookings[0].id);
    expect(row.walletDiscountHalalas).toBe(5_000);
    expect(row.totalHalalas).toBe(price - 5_000);
    expect(row.vatHalalas).toBe(vatIncludedIn(price - 5_000));
    expect((await walletBalance(SARA)).available).toBe(0);
    expect((await spends(SARA)).map((s) => [s.deltaHalalas, s.bookingId])).toEqual([[-5_000, row.id]]);
  });

  it("spends only the amount she typed, and the rest stays hers", async () => {
    await credit(SARA, 20_000);
    const r = await book("sara", { walletHalalas: 5_000 });
    if (!r.ok) throw new Error(r.error);

    expect(r.totalHalalas).toBe(price - 5_000);
    expect((await walletBalance(SARA)).available).toBe(15_000);
  });

  it("covers the whole bill, and what is left stays hers", async () => {
    await credit(SARA, price + 10_000);
    const r = await book("sara", { walletHalalas: price });
    if (!r.ok) throw new Error(r.error);

    expect(r.totalHalalas).toBe(0);
    expect((await walletBalance(SARA)).available).toBe(10_000);
  });

  it("leaves at least 1 SAR for the card rather than a charge StreamPay refuses", async () => {
    await credit(SARA, price - 50);
    expect((await book("sara", { walletHalalas: price - 50 })).ok).toBe(false);

    const r = await book("sara", { walletHalalas: price - 100 });
    if (!r.ok) throw new Error(r.error);
    expect(r.totalHalalas).toBe(100);
  });

  it("refuses when the balance moved since the screen showed it, and writes nothing", async () => {
    await credit(SARA, 5_000);
    const r = await book("sara", { walletHalalas: 6_000 });

    expect(r).toMatchObject({ ok: false, error: "wallet-changed", walletBalance: 5_000 });
    expect(await db.select().from(bookings).where(eq(bookings.branchId, f.branchA))).toEqual([]);
    expect(await spends(SARA)).toEqual([]);
  });

  it("spends one balance once when two tabs check out at the same moment", async () => {
    await credit(SARA, 5_000);
    const [a, b] = await Promise.all([book("sara", { walletHalalas: 5_000 }, 0), book("sara", { walletHalalas: 5_000 }, 1)]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ error: "wallet-changed" });
    expect((await spends(SARA)).length).toBe(1);
    expect((await walletBalance(SARA)).total).toBe(0);
  });

  it("can't be spent by a guest who only typed the email it belongs to", async () => {
    await credit(GUEST, 5_000);
    expect(await book("guest", { walletHalalas: 5_000 })).toMatchObject({ ok: false, error: "wallet-changed" });
    expect((await walletBalance(GUEST)).available).toBe(5_000);
  });
});

describe("a gift card at the booking checkout", () => {
  it("pays with the code and her email, and the card is used up", async () => {
    await card("WALL-ETTE-ST00-0001", 5_000, GUEST);
    const r = await book("guest", { giftCardCode: "wall ette st00 0001", walletHalalas: 5_000 });
    if (!r.ok) throw new Error(r.error);

    expect(r.totalHalalas).toBe(price - 5_000);
    expect(await cardRow("WALL-ETTE-ST00-0001")).toMatchObject({ balanceHalalas: 0, status: "redeemed" });
    expect((await walletBalance(GUEST)).total).toBe(0);
  });

  it("keeps what the bill didn't use in her email's wallet", async () => {
    await card("WALL-ETTE-ST00-0002", price + 2_000, GUEST);
    const r = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0002", walletHalalas: price });
    if (!r.ok) throw new Error(r.error);

    expect(r.totalHalalas).toBe(0);
    expect((await walletBalance(GUEST)).available).toBe(2_000);
  });

  it("says what is left of the card, for her booking email, and nothing for a signed-in spend", async () => {
    await credit(GUEST, 3_000);
    await card("WALL-ETTE-ST00-0010", price + 2_000, GUEST);
    const r = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0010", walletHalalas: price }, 0);
    if (!r.ok) throw new Error(r.error);
    // 2,000 of the card; the 3,000 already on her email is not the card's.
    expect(await giftCardLeftAfter(r.bookings[0].id)).toBe(2_000);

    await credit(SARA, 5_000);
    const signedIn = await book("sara", { walletHalalas: 5_000 }, 1);
    if (!signedIn.ok) throw new Error(signedIn.error);
    expect(await giftCardLeftAfter(signedIn.bookings[0].id)).toBe(0);
  });

  it("is called a gift card on a guest's bill and email, and her own credit wallet credit", async () => {
    await card("WALL-ETTE-ST00-0011", 5_000, GUEST);
    const guest = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0011", walletHalalas: 5_000 }, 0);
    if (!guest.ok) throw new Error(guest.error);
    const guestRows = await db.select().from(bookings).where(eq(bookings.id, guest.bookings[0].id));
    expect((await bookingLines(guestRows)).discounts).toEqual([{ label: "Gift card", halalas: 5_000 }]);
    expect((await buildBookingInvoice([guest.bookings[0].id]))?.guests[0].discounts).toEqual([
      { kind: "giftCard", halalas: 5_000 },
    ]);

    await credit(SARA, 5_000);
    const own = await book("sara", { walletHalalas: 5_000 }, 1);
    if (!own.ok) throw new Error(own.error);
    const ownRows = await db.select().from(bookings).where(eq(bookings.id, own.bookings[0].id));
    expect((await bookingLines(ownRows)).discounts).toEqual([{ label: "Wallet credit", halalas: 5_000 }]);
    expect((await buildBookingInvoice([own.bookings[0].id]))?.guests[0].discounts).toEqual([
      { kind: "wallet", halalas: 5_000 },
    ]);
  });

  it("works with no other email, and the card is left as it was", async () => {
    await card("WALL-ETTE-ST00-0003", 5_000, GUEST);
    const r = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0003", walletHalalas: 5_000, email: "someone@test.local" });

    expect(r).toMatchObject({ ok: false, error: "gift-card-invalid" });
    expect(await cardRow("WALL-ETTE-ST00-0003")).toMatchObject({ balanceHalalas: 5_000, status: "active" });
  });

  it("brings back what is left of it when she types it again, and only to her email", async () => {
    await card("WALL-ETTE-ST00-0004", 5_000, null);
    const first = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0004", walletHalalas: 5_000 }, 0);
    if (!first.ok) throw new Error(first.error);
    // She goes back to change her service: the hold is let go, the card's value
    // sits in her email's wallet, and the code still brings it.
    await releaseWebHold(first.bookings[0].code, GUEST);

    expect(
      await book("guest", { giftCardCode: "WALL-ETTE-ST00-0004", walletHalalas: 5_000, email: "other@test.local" }, 1),
    ).toMatchObject({ ok: false, error: "gift-card-invalid" });
    const again = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0004", walletHalalas: 5_000 }, 2);
    expect(again).toMatchObject({ ok: true, walletSpent: 5_000 });
  });

  it("keeps bringing its leftover, and never the rest of that email's wallet", async () => {
    await credit(GUEST, 3_000);
    await card("WALL-ETTE-ST00-0009", price + 2_000, GUEST);
    const first = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0009", walletHalalas: price }, 0);
    if (!first.ok) throw new Error(first.error);

    // 2,000 of the card is left; the other 3,000 on her email is not the card's.
    expect(await giftCardValue("WALL-ETTE-ST00-0009", GUEST)).toEqual({ ok: true, halalas: 2_000 });
    const second = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0009", walletHalalas: 2_000 }, 1);
    expect(second).toMatchObject({ ok: true, walletSpent: 2_000 });

    // Used up: the code brings nothing, and the 3,000 stays where it is.
    expect(await book("guest", { giftCardCode: "WALL-ETTE-ST00-0009", walletHalalas: 0 }, 2)).toMatchObject({
      ok: false,
      error: "gift-card-invalid",
    });
    expect((await walletBalance(GUEST)).available).toBe(3_000);
  });

  it("tells a guest to sign in once the card is in an account's wallet", async () => {
    await card("WALL-ETTE-ST00-0010", 5_000, SARA);
    const signedIn = await book("sara", { giftCardCode: "WALL-ETTE-ST00-0010", walletHalalas: 5_000 }, 0);
    if (!signedIn.ok) throw new Error(signedIn.error);
    await releaseWebHold(signedIn.bookings[0].code, SARA);

    expect(
      await book("guest", { giftCardCode: "WALL-ETTE-ST00-0010", walletHalalas: 5_000, email: SARA }, 1),
    ).toMatchObject({ ok: false, error: "gift-card-claimed" });
  });

  it("works with any email when it was issued with no recipient email", async () => {
    await card("WALL-ETTE-ST00-0005", 5_000, null);
    const r = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0005", walletHalalas: 5_000 });
    expect(r.ok).toBe(true);
  });

  it("lets a guest spend only what the card brings, not the rest of that email's wallet", async () => {
    await credit(GUEST, 3_000);
    await card("WALL-ETTE-ST00-0006", 5_000, GUEST);

    expect(await book("guest", { giftCardCode: "WALL-ETTE-ST00-0006", walletHalalas: 8_000 })).toMatchObject({
      ok: false,
      error: "wallet-changed",
    });
    const r = await book("guest", { giftCardCode: "WALL-ETTE-ST00-0006", walletHalalas: 5_000 });
    if (!r.ok) throw new Error(r.error);
    expect((await walletBalance(GUEST)).available).toBe(3_000);
  });

  it("is previewed for the screen without being claimed", async () => {
    await card("WALL-ETTE-ST00-0008", 5_000, GUEST);

    expect(await giftCardValue("wall-ette-st00-0008", GUEST)).toEqual({ ok: true, halalas: 5_000 });
    expect(await giftCardValue("WALL-ETTE-ST00-0008", "someone@test.local")).toEqual({
      ok: false,
      error: "gift-card-invalid",
    });
    expect(await cardRow("WALL-ETTE-ST00-0008")).toMatchObject({ balanceHalalas: 5_000, status: "active" });
  });

});

describe("a hold that ends unpaid gives its credit back", () => {
  it("when she lets it go", async () => {
    await credit(SARA, 5_000);
    const r = await book("sara", { walletHalalas: 5_000 });
    if (!r.ok) throw new Error(r.error);

    expect(await releaseWebHold(r.bookings[0].code, SARA)).toBe(true);
    expect((await walletBalance(SARA)).available).toBe(5_000);
  });

  it("when it lapses and the sweep lets it go", async () => {
    await credit(SARA, 5_000);
    const r = await book("sara", { walletHalalas: 5_000 });
    if (!r.ok) throw new Error(r.error);
    await db
      .update(bookings)
      .set({ createdAt: new Date(Date.now() - 3 * 3_600_000) })
      .where(eq(bookings.id, r.bookings[0].id));

    // Any booking at the branch sweeps its lapsed holds first.
    expect((await book("guest", {}, 3)).ok).toBe(true);
    expect((await rowOf(r.bookings[0].id)).cancelReason).toBe("payment-timeout");
    expect((await walletBalance(SARA)).available).toBe(5_000);
  });
});
