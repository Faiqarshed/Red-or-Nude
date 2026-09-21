import "server-only";

// What a booking bill looks like as a receipt: the products she is paying for
// and the discounts she got, rebuilt from what lib/bookings.ts snapshotted onto
// the rows. Nothing is re-priced from the catalogue — the snapshots are the
// bill, so the lines always add up to `total_halalas`.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookingAddons, bookings, promoCodes, removalTypes } from "@/lib/db/schema";
import type { Localized } from "@/lib/localized";
import type { Discount, Line } from "./index";

/** "مانيكير | Manicure" — the invoice is read in both languages. */
export function productName(name: Localized | null | undefined, fallback = "Item"): string {
  if (!name) return fallback;
  return name.ar && name.en && name.ar !== name.en ? `${name.ar} | ${name.en}` : name.en || name.ar || fallback;
}

export async function bookingLines(
  members: (typeof bookings.$inferSelect)[],
): Promise<{ lines: Line[]; discounts: Discount[] }> {
  const ids = members.map((m) => m.id);
  const extras = ids.length
    ? await db.select().from(bookingAddons).where(inArray(bookingAddons.bookingId, ids))
    : [];
  const removalIds = [...new Set(members.map((m) => m.removalTypeId).filter(Boolean))] as string[];
  const removals = removalIds.length
    ? await db
        .select({ id: removalTypes.id, name: removalTypes.name })
        .from(removalTypes)
        .where(inArray(removalTypes.id, removalIds))
    : [];
  const removalName = new Map(removals.map((r) => [r.id, r.name as Localized]));

  const lines: Line[] = [];
  for (const m of members) {
    // Zero is a membership credit covering the service: nothing to bill, and a
    // StreamPay product cannot cost nothing anyway.
    if (m.servicePriceHalalas > 0 && m.serviceId) {
      const name = productName(m.serviceName);
      lines.push(
        m.refillOfBookingId
          ? { key: `product:refill:${m.serviceId}`, name: `${name} — Refill`, priceHalalas: m.servicePriceHalalas, qty: 1 }
          : { key: `product:service:${m.serviceId}`, name, priceHalalas: m.servicePriceHalalas, qty: 1 },
      );
    }
    if (m.removalPriceHalalas > 0 && m.removalTypeId) {
      lines.push({
        key: `product:removal:${m.removalTypeId}`,
        name: productName(removalName.get(m.removalTypeId)),
        priceHalalas: m.removalPriceHalalas,
        qty: 1,
      });
    }
    // Add-ons and treats alike: both are rows here, and both are addon products.
    for (const a of extras) {
      if (a.bookingId !== m.id || a.priceHalalas <= 0 || !a.addonId) continue;
      lines.push({ key: `product:addon:${a.addonId}`, name: productName(a.name), priceHalalas: a.priceHalalas, qty: 1 });
    }
  }

  const promo = members.reduce((s, m) => s + m.promoDiscountHalalas, 0);
  const points = members.reduce((s, m) => s + m.pointsDiscountHalalas, 0);
  const group = members.reduce((s, m) => s + m.discountHalalas, 0) - promo - points;

  let promoLabel = "Promo code";
  const promoId = members.find((m) => m.promoCodeId)?.promoCodeId;
  if (promo > 0 && promoId) {
    const [code] = await db.select({ code: promoCodes.code }).from(promoCodes).where(eq(promoCodes.id, promoId)).limit(1);
    if (code) promoLabel = code.code;
  }

  const discounts: Discount[] = [
    { label: "Group discount", halalas: group },
    { label: promoLabel, halalas: promo },
    { label: "Loyalty points", halalas: points },
  ].filter((d) => d.halalas > 0);

  return { lines, discounts };
}
