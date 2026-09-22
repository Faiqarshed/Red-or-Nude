import "server-only";

// Buying for the visit you are in, from the chair you are sitting in (brief §2.7).
//
// The salon's question was "if the lady after coming decides she wants coffee,
// how does she order it?", and their answer was the QR sticker already on her
// table. /station/[token] resolves that sticker to a chair and finds the booking
// running on it; this sells her things for that visit, as one basket and one
// payment, rather than booking her another one.
//
// Two kinds of thing, both catalogue add-ons:
//   • treats (`at_checkout`) — no duration, always allowed while she is seated
//   • service add-ons — they lengthen her appointment, so only when the chair is
//     free for that long after her. The end is moved at delivery, under the same
//     chair lock a new booking takes (lib/payments/purchase.ts), so the time she
//     was offered cannot be sold twice.
//
// **The token is the whole credential, and that is deliberate.** There is no
// session here — she may well be a guest — and requiring one would put a sign-in
// wall between a customer and a cup of coffee. What the token proves is physical
// presence at a table in the salon, which is the same thing the sticker proves,
// and the worst a stolen token buys is something charged to the thief's own card
// for a chair they are not sitting in. So the token is never allowed to *read*
// anything: the reply carries no price, no name, no phone and no email — only
// that it worked and what she ordered.
//
// Money first, delivery second, as for a pack or a gift card: nothing is added
// until the payment is verified.

import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookingAddons, bookings, stations } from "@/lib/db/schema";
import { stationFreeWindow } from "@/lib/availability";
import { startPurchase } from "@/lib/payments/purchase";
import { productName } from "@/lib/payments/lines";

export type TreatRefusal =
  /** No such sticker, or a chair the salon has retired. */
  | "unknown-station"
  /** Nobody is in that chair right now, so there is no visit to add to. */
  | "not-in-service"
  /** No such add-on, or it is inactive. */
  | "unknown-treat"
  /** She already has one of these on this visit. */
  | "already-added"
  /** The add-ons need more time than the chair is free after her. */
  | "no-time"
  /** The gateway said no. Her card, not our problem to retry for her. */
  | "declined"
  /** Charged, and then it could not be added. See lib/payments/purchase.ts. */
  | "paid-not-added";

type Name = { ar: string; en: string };

export type TreatResult =
  | { ok: true; names: Name[] }
  /** Pay on this checkout, then ask /api/payments/status. */
  | { ok: true; checkout: { ref: string; url: string } }
  | { ok: false; reason: TreatRefusal };

/** The booking running on this sticker's chair now, or why there is none. */
async function currentVisit(token: string, now: Date) {
  const [station] = await db
    .select({ id: stations.id, branchId: stations.branchId })
    .from(stations)
    .where(and(eq(stations.qrToken, token), eq(stations.active, true)))
    .limit(1);
  if (!station) return { ok: false as const, reason: "unknown-station" as const };

  // `confirmed` covers the common case of nobody having pressed Start; she is
  // sitting there either way. Finished, cancelled or unpaid is not a visit.
  const [booking] = await db
    .select({ id: bookings.id, endsAt: bookings.endsAt })
    .from(bookings)
    .where(
      and(
        eq(bookings.stationId, station.id),
        inArray(bookings.status, ["confirmed", "checked_in", "in_progress"]),
        lte(bookings.startsAt, now),
        gt(bookings.endsAt, now),
      ),
    )
    .orderBy(asc(bookings.startsAt))
    .limit(1);
  if (!booking) return { ok: false as const, reason: "not-in-service" as const };
  return { ok: true as const, station, booking };
}

/**
 * Sell a basket of treats and add-ons to whoever is sitting at this chair now,
 * as one payment.
 *
 * `simulate` exercises the decline path in development; the fake driver
 * ignores it in production (lib/payments/fake.ts).
 */
export async function buyStationItems(input: {
  token: string;
  addonIds: string[];
  simulate?: "decline";
  now?: Date;
}): Promise<TreatResult> {
  const now = input.now ?? new Date();
  const ids = [...new Set(input.addonIds)];

  const visit = await currentVisit(input.token, now);
  if (!visit.ok) return visit;
  const { station, booking } = visit;

  // Prices and durations from the catalogue, never from the request.
  const rows = await db
    .select({
      id: addons.id,
      name: addons.name,
      priceHalalas: addons.priceHalalas,
      durationMin: addons.durationMin,
      atCheckout: addons.atCheckout,
    })
    .from(addons)
    .where(and(inArray(addons.id, ids), eq(addons.active, true)));
  if (ids.length === 0 || rows.length !== ids.length) return { ok: false, reason: "unknown-treat" };

  // Asked before charging, so the common double-tap costs nothing. What
  // guarantees one of each is booking_addons' primary key, at delivery.
  const [existing] = await db
    .select({ bookingId: bookingAddons.bookingId })
    .from(bookingAddons)
    .where(and(eq(bookingAddons.bookingId, booking.id), inArray(bookingAddons.addonId, ids)))
    .limit(1);
  if (existing) return { ok: false, reason: "already-added" };

  // A treat has no duration however the catalogue row is filled in.
  const items = rows.map((r) => ({
    addonId: r.id,
    name: r.name as Name,
    priceHalalas: r.priceHalalas,
    durationMin: r.atCheckout ? 0 : r.durationMin,
  }));
  const extraMin = items.reduce((s, i) => s + i.durationMin, 0);
  if (extraMin > 0 && (await stationFreeWindow(station.branchId, station.id, booking.endsAt)) < extraMin) {
    return { ok: false, reason: "no-time" };
  }

  const result = await startPurchase({
    intent: { kind: "treat", bookingId: booking.id, items },
    amountHalalas: items.reduce((s, i) => s + i.priceHalalas, 0),
    lines: items.map((i) => ({ key: `product:addon:${i.addonId}`, name: productName(i.name), priceHalalas: i.priceHalalas, qty: 1 })),
    title: "For your visit",
    // Nobody to prefill: the sticker proves presence, not identity.
    payer: {},
    back: `/station/${input.token}`,
    simulate: input.simulate,
  });

  if (!result.ok) {
    // `declined` tells the screen a retry is safe. Once money has moved, it is not.
    return { ok: false, reason: result.error === "not-delivered" ? "paid-not-added" : "declined" };
  }
  if ("checkout" in result) return { ok: true, checkout: result.checkout };

  // What she ordered, and nothing else about the booking.
  return { ok: true, names: items.map((i) => i.name) };
}
