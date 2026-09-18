import "server-only";

// What was sold on a booking besides the service, split into the work and the
// treats.
//
// Three screens need this — the technician's day, the front desk and the
// bookings list — and it used to be written out three times, which is how two
// of them ended up with a picture for the coffee and one without.
//
// `name` comes from booking_addons, which snapshots it at the time of sale; the
// catalogue row is only asked what *kind* of thing it was and for its picture,
// never what it was called or cost. No price is selected at all: My Day uses
// this, and technicians do not see revenue.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookingAddons, type Localized } from "@/lib/db/schema";
import { mediaUrl } from "@/lib/storage";

/** Something to fetch rather than something to do. */
export type Treat = {
  name: Localized;
  /** The picture from the catalogue — she is fetching a *specific* drink. */
  imageUrl: string | null;
};

export type AddonLines = { addons: Localized[]; treats: Treat[] };

/** For a booking with nothing on it. Frozen so no caller can fill the shared one. */
export const NO_LINES: AddonLines = Object.freeze({ addons: [], treats: [] }) as AddonLines;

/**
 * The shared select. Callers add their own scoping — a list of ids, or the
 * bookings page's day-and-branch join, which runs inside its Promise.all rather
 * than as a second round trip.
 */
export function addonLineQuery() {
  return db
    .select({
      bookingId: bookingAddons.bookingId,
      name: bookingAddons.name,
      atCheckout: addons.atCheckout,
      image: addons.image,
    })
    .from(bookingAddons)
    .leftJoin(addons, eq(addons.id, bookingAddons.addonId))
    .$dynamic();
}

type LineRow = { bookingId: string; name: Localized | null; atCheckout: boolean | null; image: string | null };

/**
 * Group the rows by booking.
 *
 * A left join, for a case the database currently makes unreachable: `addon_id`
 * is half of booking_addons' primary key, so a sold catalogue row cannot be
 * deleted and the join is total. Kept because the cost is one branch and the
 * failure mode without it is a treat vanishing from a ticket; with it, the line
 * falls back to the add-on pills where it used to live.
 */
export function splitAddonLines(rows: LineRow[]): Map<string, AddonLines> {
  const out = new Map<string, AddonLines>();
  for (const r of rows) {
    if (!r.name) continue;
    let lines = out.get(r.bookingId);
    if (!lines) out.set(r.bookingId, (lines = { addons: [], treats: [] }));
    if (r.atCheckout) lines.treats.push({ name: r.name, imageUrl: mediaUrl(r.image) });
    else lines.addons.push(r.name);
  }
  return out;
}

/** Every add-on and treat on these bookings, by booking id. */
export async function addonLinesFor(bookingIds: string[]): Promise<Map<string, AddonLines>> {
  if (bookingIds.length === 0) return new Map();
  return splitAddonLines(
    await addonLineQuery().where(inArray(bookingAddons.bookingId, bookingIds)),
  );
}
