// Server-side catalogue reads for the PUBLIC site.
//
// This is the other half of "everything is managed from the admin panel": the
// admin writes these tables, and the customer-facing pages read them here
// instead of importing the literals in lib/booking.ts.
//
// Server-only — the booking page is a server component that fetches once and
// hands plain objects to its client view.

import "server-only";
import { unstable_cache } from "next/cache";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  addons,
  branches,
  designs,
  giftCardDesigns,
  giftCardValues,
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
  removals: CatalogItem[];
  designs: { id: string; name: Localized; img: string | null }[];
};

export type PublicBranch = { id: string; name: string; address: string };

/**
 * Cache tags. These reads run on every public page render, and the data behind
 * them changes only when staff edit it — so they are cached at the query level
 * and purged by tag from the admin actions.
 *
 * Deliberately NOT done by prerendering the pages: that made `next build`
 * require a reachable database, and a build that can fail on a network blip is
 * worse than a slightly slower first request.
 */
export const CATALOG_TAG = "catalog";
export const BRANCHES_TAG = "branches";
export const GIFT_OPTIONS_TAG = "gift-options";

export { pick } from "@/lib/localized";

/** Active branches, already resolved to the requested language. */
async function loadPublicBranches(lang: "ar" | "en"): Promise<PublicBranch[]> {
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

async function loadPublicCatalog(): Promise<PublicCatalog> {
  const [serviceRows, addonRows, removalRows, designRows] = await Promise.all([
    db.select().from(services).where(eq(services.active, true)).orderBy(asc(services.sort)),
    db.select().from(addons).where(eq(addons.active, true)).orderBy(asc(addons.sort)),
    db.select().from(removalTypes).where(eq(removalTypes.active, true)).orderBy(asc(removalTypes.sort)),
    db.select().from(designs).where(eq(designs.active, true)).orderBy(asc(designs.sort)),
  ]);

  return {
    services: serviceRows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      price: halalasToSar(r.priceHalalas),
      img: mediaUrl(r.image),
      durationMin: r.durationMin,
    })),
    addons: addonRows.map((r) => ({
      id: r.id,
      name: r.name,
      price: halalasToSar(r.priceHalalas),
      img: mediaUrl(r.image),
      durationMin: r.durationMin,
      seasonal: r.isSeasonal,
    })),
    removals: removalRows.map((r) => ({
      id: r.id,
      name: r.name,
      price: halalasToSar(r.priceHalalas),
      img: null,
      durationMin: r.durationMin,
    })),
    designs: designRows.map((r) => ({
      id: r.id,
      name: r.name,
      img: mediaUrl(r.image),
    })),
  };
}

// ---- gift cards -------------------------------------------------------------

export type PublicGiftOptions = {
  values: number[]; // SAR
  designs: { id: string; name: Localized; img: string | null }[];
};

/** Denominations and card artwork offered on /gift-card, managed in the admin. */
async function loadPublicGiftOptions(): Promise<PublicGiftOptions> {
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

// ---- cached entry points ----------------------------------------------------

export const getPublicCatalog = unstable_cache(loadPublicCatalog, ["public-catalog"], {
  tags: [CATALOG_TAG],
  revalidate: 3600,
});

export const getPublicBranches = unstable_cache(loadPublicBranches, ["public-branches"], {
  tags: [BRANCHES_TAG],
  revalidate: 3600,
});

export const getPublicGiftOptions = unstable_cache(loadPublicGiftOptions, ["public-gift-options"], {
  tags: [GIFT_OPTIONS_TAG],
  revalidate: 3600,
});
