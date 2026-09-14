// Server-side catalogue reads for the PUBLIC site.
//
// This is the other half of "everything is managed from the admin panel": the
// admin writes these tables, and the customer-facing pages read them here
// instead of importing the literals in lib/booking.ts.
//
// Server-only — the booking page is a server component that fetches once and
// hands plain objects to its client view.

import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  addons,
  branches,
  designs,
  giftCardDesigns,
  giftCardValues,
  packServices,
  packs,
  removalTypes,
  services,
} from "@/lib/db/schema";
import { halalasToSar } from "@/lib/money";
import { mediaUrl } from "@/lib/storage";
import type { Localized } from "@/lib/db/schema";

/** Shape the existing booking UI already expects, plus an id for real writes. */
export type CatalogItem = {
  id: string;
  name: Localized;
  price: number;
  img: string | null;
  durationMin: number;
};

export type PublicCatalog = {
  services: (CatalogItem & { description: Localized | null })[];
  addons: (CatalogItem & { seasonal: boolean })[];
  /**
   * Offered on the payment page instead of beside the services — the coffee and
   * cookie. Kept as its own list so the pickers keep showing service add-ons
   * only and this one cannot appear in two places.
   */
  checkoutAddons: CatalogItem[];
  removals: CatalogItem[];
  /**
   * Every design, each tagged with the add-on whose picker shows it. Kept as
   * one flat list rather than nested inside the add-ons so the booking page,
   * which passes them around by index, needs no reshaping.
   */
  designs: { id: string; addonId: string | null; name: Localized; img: string | null }[];
};

export type PublicBranch = { id: string; name: string; address: string };

export { pick } from "@/lib/localized";

/** Active branches, already resolved to the requested language. */
export async function getPublicBranches(lang: "ar" | "en"): Promise<PublicBranch[]> {
  const rows = await db
    .select()
    .from(branches)
    .where(eq(branches.active, true))
    .orderBy(asc(branches.sort));

  return rows.map((r) => ({
    id: r.id,
    name: r.name?.[lang] || r.name?.ar || "",
    address: r.address?.[lang] || r.address?.ar || "",
  }));
}

export async function getPublicCatalog(): Promise<PublicCatalog> {
  const [serviceRows, addonRows, removalRows, designRows] = await Promise.all([
    db.select().from(services).where(eq(services.active, true)).orderBy(asc(services.sort)),
    db.select().from(addons).where(eq(addons.active, true)).orderBy(asc(addons.sort)),
    db.select().from(removalTypes).where(eq(removalTypes.active, true)).orderBy(asc(removalTypes.sort)),
    db.select().from(designs).where(eq(designs.active, true)).orderBy(asc(designs.sort)),
  ]);

  const addonItem = (r: (typeof addonRows)[number]) => ({
    id: r.id,
    name: r.name,
    price: halalasToSar(r.priceHalalas),
    img: mediaUrl(r.image),
    durationMin: r.durationMin,
  });

  return {
    services: serviceRows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      price: halalasToSar(r.priceHalalas),
      img: mediaUrl(r.image),
      durationMin: r.durationMin,
    })),
    addons: addonRows
      .filter((r) => !r.atCheckout)
      .map((r) => ({ ...addonItem(r), seasonal: r.isSeasonal })),
    checkoutAddons: addonRows.filter((r) => r.atCheckout).map(addonItem),
    removals: removalRows.map((r) => ({
      id: r.id,
      name: r.name,
      price: halalasToSar(r.priceHalalas),
      img: null,
      durationMin: r.durationMin,
    })),
    designs: designRows.map((r) => ({
      id: r.id,
      addonId: r.addonId,
      name: r.name,
      img: mediaUrl(r.image),
    })),
  };
}

// ---- membership packs -------------------------------------------------------

export type PublicPack = {
  id: string;
  name: Localized;
  description: Localized | null;
  priceSar: number;
  validDays: number;
  img: string | null;
  /**
   * What is in it, in catalogue order. With the service's own picture, blurb
   * and length, so she can see what a line is before paying for six of it —
   * the same fields the booking grid already shows for that service.
   */
  lines: {
    serviceId: string;
    name: Localized;
    quantity: number;
    description: Localized | null;
    img: string | null;
    durationMin: number;
  }[];
  /** What the same services cost bought one at a time. The reason to buy one. */
  listPriceSar: number;
};

/** Packs on the shelf, with their contents resolved. Admin-managed, like everything else. */
export async function getPublicPacks(): Promise<PublicPack[]> {
  const [packRows, lineRows, serviceRows] = await Promise.all([
    db.select().from(packs).where(eq(packs.active, true)).orderBy(asc(packs.sort)),
    db.select().from(packServices),
    // Active only, as getPublicCatalog reads them. A pack is a promise of
    // appointments, and a service the salon switched off is one she could buy a
    // credit for and then never find in the booking list.
    db.select().from(services).where(eq(services.active, true)).orderBy(asc(services.sort)),
  ]);

  return packRows.flatMap((p) => {
    // Priced while the service row is still to hand — the total is the only
    // part anybody outside needs, so the per-line price never leaves.
    let listPriceSar = 0;
    const lines = serviceRows
      .filter((s) => lineRows.some((l) => l.packId === p.id && l.serviceId === s.id))
      .map((s) => {
        const quantity = lineRows.find((l) => l.packId === p.id && l.serviceId === s.id)!.quantity;
        listPriceSar += halalasToSar(s.priceHalalas) * quantity;
        return {
          serviceId: s.id,
          name: s.name,
          quantity,
          description: s.description,
          img: mediaUrl(s.image),
          durationMin: s.durationMin,
        };
      });

    // Off the shelf entirely rather than quietly short. Selling it at the full
    // price minus a service is worse than not selling it, and the gap is what
    // tells the salon to go and fix the pack.
    if (lines.length !== lineRows.filter((l) => l.packId === p.id).length) return [];

    return {
      id: p.id,
      name: p.name,
      description: p.description,
      priceSar: halalasToSar(p.priceHalalas),
      validDays: p.validDays,
      img: mediaUrl(p.image),
      lines,
      listPriceSar,
    };
  });
}

// ---- gift cards -------------------------------------------------------------

export type PublicGiftOptions = {
  values: number[]; // SAR
  /** Card artwork — a different table from the nail designs above. */
  designs: { id: string; name: Localized; img: string | null }[];
};

/** Denominations and card artwork offered on /gift-card, managed in the admin. */
export async function getPublicGiftOptions(): Promise<PublicGiftOptions> {
  const [valueRows, designRows] = await Promise.all([
    db
      .select()
      .from(giftCardValues)
      .where(eq(giftCardValues.active, true))
      .orderBy(asc(giftCardValues.sort)),
    db
      .select()
      .from(giftCardDesigns)
      .where(eq(giftCardDesigns.active, true))
      .orderBy(asc(giftCardDesigns.sort)),
  ]);

  return {
    values: valueRows.map((v) => halalasToSar(v.amountHalalas)),
    designs: designRows.map((d) => ({ id: d.id, name: d.name, img: mediaUrl(d.image) })),
  };
}
