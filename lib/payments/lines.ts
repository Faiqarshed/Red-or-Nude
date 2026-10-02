import "server-only";

// What a booking bill looks like as a receipt: the products she is paying for
// and the discounts she got, rebuilt from what lib/bookings.ts snapshotted onto
// the rows. Nothing is re-priced from the catalogue — the snapshots are the
// bill, so the lines always add up to `total_halalas`.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookingAddons, bookings, promoCodes, removalTypes } from "@/lib/db/schema";
import type { Localized } from "@/lib/localized";
import { discountParts } from "@/lib/money";
import { paidWithGiftCard } from "@/lib/wallet";
import type { Discount, Line } from "./index";

/** "مانيكير | Manicure" — the invoice is read in both languages. */
export function productName(name: Localized | null | undefined, fallback = "Item"): string {
  if (!name) return fallback;
  return name.ar && name.en && name.ar !== name.en ? `${name.ar} | ${name.en}` : name.en || name.ar || fallback;
}

/**
 * A gift card is its own product per amount: "Gift card 300 SAR" × 1 on the
 * invoice, not a 1 SAR product × 300. Made the first time that amount sells.
 * Not one product repriced per sale: a link takes the product's price at the
 * moment it is made, so two buyers at once would get each other's amount.
 *
 * Taxed when sold, VAT included in its price like every price here (the owner,
 * docs/WALLET-PLAN.md): a 300 SAR card costs 300 SAR and brings 300 SAR of
 * credit. Spending it later as a discount is then right, since the tax was
 * collected at sale.
 */
export const giftCardLine = (amountSar: number): Line => ({
  key: `product:giftcard:${amountSar}`,
  name: `بطاقة هدية ${amountSar} ر.س | Gift card ${amountSar} SAR`,
  priceHalalas: amountSar * 100,
  qty: 1,
});

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

  const parts = members.map(discountParts);
  const total = (k: keyof (typeof parts)[number]) => parts.reduce((s, p) => s + p[k], 0);
  const promo = total("promo");

  let promoLabel = "Promo code";
  const promoId = members.find((m) => m.promoCodeId)?.promoCodeId;
  if (promo > 0 && promoId) {
    const [code] = await db.select({ code: promoCodes.code }).from(promoCodes).where(eq(promoCodes.id, promoId)).limit(1);
    if (code) promoLabel = code.code;
  }

  const wallet = total("wallet");
  const walletLabel = wallet > 0 && (await paidWithGiftCard(ids)) ? "Gift card" : "Wallet credit";

  const discounts: Discount[] = [
    { label: "Group discount", halalas: total("group") },
    { label: promoLabel, halalas: promo },
    { label: "Loyalty points", halalas: total("points") },
    { label: walletLabel, halalas: wallet },
  ].filter((d) => d.halalas > 0);

  return { lines, discounts };
}
