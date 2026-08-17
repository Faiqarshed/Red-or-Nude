// Booking creation. One implementation, called by the public booking API and by
// the admin's walk-in form, so the two can't drift on pricing or conflict rules.

import "server-only";
import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  addons,
  bookingAddons,
  bookings,
  customers,
  designs,
  removalTypes,
  services,
  type Localized,
} from "@/lib/db/schema";
import { reserveStations } from "@/lib/availability";
import { getSettings } from "@/lib/settings";
import { vatIncludedIn } from "@/lib/money";

export type CreateBookingInput = {
  branchId: string;
  serviceId: string;
  addonIds: string[];
  removalTypeId?: string | null;
  designId?: string | null;
  startsAt: string; // ISO UTC
  customer: { name?: string | null; phone: string; email?: string | null; lang?: "ar" | "en" };
  source: "web" | "walk_in" | "phone";
  notes?: string | null;
  technicianId?: string | null;
};

export type CreateBookingResult =
  | { ok: true; id: string; code: string; totalHalalas: number }
  | { ok: false; error: "invalid-service" | "slot-taken" | "blocked" | "failed" };

/**
 * Rolls the transaction back and surfaces a business reason rather than a crash.
 * Everything a booking needs to check now lives inside one transaction, so the
 * only way out of a bad state is to throw.
 */
class BookingAbort extends Error {
  constructor(readonly reason: "slot-taken" | "blocked") {
    super(reason);
  }
}

// No I/O/0/1 — these codes get read aloud over the phone.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function makeCode(): string {
  let out = "";
  for (let i = 0; i < 5; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `RON-${out}`;
}

export async function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, input.serviceId), eq(services.active, true)))
    .limit(1);
  if (!service) return { ok: false, error: "invalid-service" };

  const addonRows = input.addonIds.length
    ? await db.select().from(addons).where(inArray(addons.id, input.addonIds))
    : [];

  const [removal] = input.removalTypeId
    ? await db.select().from(removalTypes).where(eq(removalTypes.id, input.removalTypeId)).limit(1)
    : [];

  const [design] = input.designId
    ? await db.select().from(designs).where(eq(designs.id, input.designId)).limit(1)
    : [];

  // Duration is the sum of everything booked — this is what reserves the chair.
  const durationMin =
    service.durationMin +
    addonRows.reduce((sum, a) => sum + a.durationMin, 0) +
    (removal?.durationMin ?? 0);

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: "failed" };
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);

  // Prices snapshotted here and never joined live afterwards: raising a price
  // must not rewrite what this customer was charged.
  const servicePrice = service.priceHalalas;
  const removalPrice = removal?.priceHalalas ?? 0;
  const addonTotal = addonRows.reduce((sum, a) => sum + a.priceHalalas, 0);
  const total = servicePrice + removalPrice + addonTotal;

  // Catalogue prices are the amounts shown to the customer, and KSA retail
  // prices are VAT-inclusive — so VAT is split out of the total rather than
  // added on top. The customer pays exactly what the booking page displayed.
  const { vat_percent } = await getSettings(["vat_percent"]);
  const vat = vatIncludedIn(total, vat_percent);

  const phone = input.customer.phone.trim();
  if (!phone) return { ok: false, error: "failed" };

  try {
    // Chair claim, customer upsert and booking insert are one transaction. The
    // claim holds a row lock on the branch's chairs until commit, so no one else
    // can take the same chair in between — see reserveStations.
    const result = await db.transaction(async (tx) => {
      const [stationId] = (await reserveStations(tx, input.branchId, startsAt, endsAt, 1)) ?? [];
      if (!stationId) throw new BookingAbort("slot-taken");

      const [customer] = await tx
        .insert(customers)
        .values({
          phone,
          name: input.customer.name?.trim() || null,
          email: input.customer.email?.trim() || null,
          lang: input.customer.lang ?? "ar",
        })
        .onConflictDoUpdate({
          target: customers.phone,
          // Don't blank an existing name with an empty one from a rushed form.
          set: { name: input.customer.name?.trim() || undefined, updatedAt: new Date() },
        })
        .returning();

      // Rolls back the upsert too, so a blocked caller leaves nothing behind.
      if (customer.blocked) throw new BookingAbort("blocked");

      const [row] = await tx
        .insert(bookings)
        .values({
          code: makeCode(),
          branchId: input.branchId,
          customerId: customer.id,
          stationId,
          technicianId: input.technicianId ?? null,
          serviceId: service.id,
          removalTypeId: removal?.id ?? null,
          designId: design?.id ?? null,
          startsAt,
          endsAt,
          status: "confirmed",
          source: input.source,
          serviceName: service.name as Localized,
          servicePriceHalalas: servicePrice,
          removalPriceHalalas: removalPrice,
          subtotalHalalas: total - vat,
          vatHalalas: vat,
          totalHalalas: total,
          notes: input.notes ?? null,
        })
        .returning({ id: bookings.id, code: bookings.code });

      if (addonRows.length) {
        await tx.insert(bookingAddons).values(
          addonRows.map((a) => ({
            bookingId: row.id,
            addonId: a.id,
            name: a.name as Localized,
            priceHalalas: a.priceHalalas,
          })),
        );
      }

      return row;
    });

    return { ok: true, id: result.id, code: result.code, totalHalalas: total };
  } catch (err) {
    if (err instanceof BookingAbort) return { ok: false, error: err.reason };
    // Kept as a cheap backstop even though reserveStations now locks: a bug that
    // bypasses the lock should still fail loudly rather than double-book a chair.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("bookings_station_slot_unique")) {
      return { ok: false, error: "slot-taken" };
    }
    console.error("[bookings] create failed", err);
    return { ok: false, error: "failed" };
  }
}
