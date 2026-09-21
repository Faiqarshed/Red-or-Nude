import "server-only";

// Buying a treat from the chair you are already sitting in (brief §2.7).
//
// The salon's question was "if the lady after coming decides she wants coffee,
// how does she order it?", and their answer was the QR sticker already on her
// table. /station/[token] already resolves that sticker to a chair and finds
// the booking running on it; this is the part that sells her something for the
// visit she is *in*, rather than booking her another one.
//
// **The token is the whole credential, and that is deliberate.** There is no
// session here — she may well be a guest — and requiring one would put a sign-in
// wall between a customer and a cup of coffee. What the token proves is physical
// presence at a table in the salon, which is the same thing the sticker proves,
// and the worst a stolen token buys is a coffee charged to the thief's own card
// and delivered to a chair they are not sitting in. So the token is never
// allowed to *read* anything: the reply below carries no price, no name, no
// phone and no email — only that it worked.
//
// Order matters, exactly as it does for a pack or a gift card: money first,
// treat second. The treat is added only once the payment is verified
// (lib/payments/purchase.ts); one that cannot be added then — a second tap got
// there first — is refunded on the spot.

import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookingAddons, bookings, stations } from "@/lib/db/schema";
import { startPurchase } from "@/lib/payments/purchase";
import { productName } from "@/lib/payments/lines";

export type TreatRefusal =
  /** No such sticker, or a chair the salon has retired. */
  | "unknown-station"
  /** Nobody is in that chair right now, so there is no visit to add to. */
  | "not-in-service"
  /** No such treat, it is inactive, or it is a service add-on rather than a treat. */
  | "unknown-treat"
  /** She already has one of these on this visit. */
  | "already-added"
  /** The gateway said no. Her card, not our problem to retry for her. */
  | "declined"
  /** Charged, and then it could not be added. Refunded, or the log says REFUND OWED. */
  | "paid-not-added";

export type TreatResult =
  | { ok: true; name: { ar: string; en: string } }
  /** Pay on this checkout, then ask /api/payments/status. */
  | { ok: true; checkout: { ref: string; url: string } }
  | { ok: false; reason: TreatRefusal };

/**
 * Sell one treat to whoever is sitting at this chair right now.
 *
 * `simulate` exercises the decline path in development; the fake driver
 * ignores it in production (lib/payments/fake.ts).
 */
export async function buyStationTreat(input: {
  token: string;
  addonId: string;
  simulate?: "decline";
  now?: Date;
}): Promise<TreatResult> {
  const now = input.now ?? new Date();

  // The sticker, and only an active chair. A retired chair is "this sticker is
  // not a thing" as far as the customer is concerned — the same answer the page
  // itself gives.
  const [station] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(and(eq(stations.qrToken, input.token), eq(stations.active, true)))
    .limit(1);
  if (!station) return { ok: false, reason: "unknown-station" };

  // Who is in it *now*. `confirmed` covers the common case of nobody having got
  // round to pressing Start; she is sitting there either way. A booking that has
  // finished, been cancelled or was never paid for is not a visit to add to.
  const [booking] = await db
    .select({ id: bookings.id })
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
  if (!booking) return { ok: false, reason: "not-in-service" };

  // The price comes from the catalogue, never from the request. `atCheckout` is
  // the part that matters beyond "does this id exist": a service add-on has a
  // duration and belongs beside a service, and selling one here would move
  // `ends_at` under a booking that is already running.
  const [treat] = await db
    .select({ id: addons.id, name: addons.name, priceHalalas: addons.priceHalalas })
    .from(addons)
    .where(and(eq(addons.id, input.addonId), eq(addons.active, true), eq(addons.atCheckout, true)))
    .limit(1);
  if (!treat) return { ok: false, reason: "unknown-treat" };

  // Asked before charging, so the common double-tap costs nothing. It is not
  // what *guarantees* one treat — the insert below does, under
  // booking_addons' primary key — but a refusal here is the difference between
  // a wasted click and a charge that has to be refunded.
  const [existing] = await db
    .select({ bookingId: bookingAddons.bookingId })
    .from(bookingAddons)
    .where(and(eq(bookingAddons.bookingId, booking.id), eq(bookingAddons.addonId, treat.id)))
    .limit(1);
  if (existing) return { ok: false, reason: "already-added" };

  const name = treat.name as { ar: string; en: string };
  const result = await startPurchase({
    intent: { kind: "treat", bookingId: booking.id, addonId: treat.id, name },
    amountHalalas: treat.priceHalalas,
    line: { key: `product:addon:${treat.id}`, name: productName(name), priceHalalas: treat.priceHalalas, qty: 1 },
    title: "Treat",
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

  // Her name for it, and nothing else about the booking.
  return { ok: true, name };
}
