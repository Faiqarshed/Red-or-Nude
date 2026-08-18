// Booking creation. One implementation, called by the public booking API and by
// the admin's walk-in form, so the two can't drift on pricing or conflict rules.
//
// A booking for two guests is not a separate code path: it is the same function
// with two members instead of one. Everything below — pricing, chair claiming,
// ticket numbers — is written to handle N and called with 1 or 2.

import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db";
import {
  addons,
  bookingAddons,
  bookings,
  customers,
  designs,
  removalTypes,
  services,
  ticketCounters,
  type Localized,
} from "@/lib/db/schema";
import { reserveStations, utcToLocalDate } from "@/lib/availability";
import { getSettings } from "@/lib/settings";
import { splitGroupPrice, vatIncludedIn } from "@/lib/money";
import { formatTicketNo } from "@/lib/tickets";

/** What one guest is booking. */
export type BookingMember = {
  serviceId: string;
  addonIds: string[];
  removalTypeId?: string | null;
  designId?: string | null;
};

export type CreateBookingsInput = {
  branchId: string;
  /** ISO UTC. Every guest in a group starts at the same moment, by definition. */
  startsAt: string;
  customer: { name?: string | null; phone: string; email?: string | null; lang?: "ar" | "en" };
  source: "web" | "walk_in" | "phone";
  members: BookingMember[];
  /**
   * Web bookings start "pending" — the chair is held but nothing is confirmed
   * until payment lands. Walk-ins are being seated right now, so they default to
   * "confirmed" and get their ticket immediately. Passed explicitly rather than
   * derived from `source`, which would be magic that bites whoever adds the next
   * source.
   */
  status?: "pending" | "confirmed";
  notes?: string | null;
  technicianId?: string | null;
};

export type CreatedBooking = {
  id: string;
  code: string;
  ticketNo: string | null;
  stationId: string;
  totalHalalas: number;
};

export type CreateBookingError = "invalid-service" | "slot-taken" | "blocked" | "failed";

export type CreateBookingsResult =
  | { ok: true; groupId: string | null; totalHalalas: number; bookings: CreatedBooking[] }
  | { ok: false; error: CreateBookingError };

/**
 * Rolls the transaction back and surfaces a business reason rather than a crash.
 * Every check a booking needs now lives inside one transaction, so the only way
 * out of a bad state is to throw.
 */
class BookingAbort extends Error {
  constructor(readonly reason: CreateBookingError) {
    super(reason);
  }
}

/**
 * Did this blow up on the chair-uniqueness index?
 *
 * Walks the cause chain: Drizzle wraps the driver's error in a DrizzleQueryError
 * whose own message is only the failed SQL, so checking `err.message` alone
 * silently misses it and a lost race gets reported as a server fault.
 */
export function isSlotConflict(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e.message.includes("bookings_station_slot_unique")) return true;
  }
  return false;
}

// No I/O/0/1 — these codes get read aloud over the phone.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function makeCode(): string {
  let out = "";
  for (let i = 0; i < 5; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `RON-${out}`;
}

type Priced = {
  member: BookingMember;
  service: typeof services.$inferSelect;
  addonRows: (typeof addons.$inferSelect)[];
  removal: typeof removalTypes.$inferSelect | null;
  design: typeof designs.$inferSelect | null;
  durationMin: number;
  grossHalalas: number;
};

/**
 * Catalogue lookup and gross price for one guest. No VAT, no discount, no writes —
 * just "what is this person buying and how long does it take". Read outside the
 * transaction so the lock in reserveStations is held for as little time as possible.
 */
async function priceMember(m: BookingMember): Promise<Priced | null> {
  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, m.serviceId), eq(services.active, true)))
    .limit(1);
  if (!service) return null;

  const addonRows = m.addonIds.length
    ? await db.select().from(addons).where(inArray(addons.id, m.addonIds))
    : [];

  const [removal] = m.removalTypeId
    ? await db.select().from(removalTypes).where(eq(removalTypes.id, m.removalTypeId)).limit(1)
    : [];

  const [design] = m.designId
    ? await db.select().from(designs).where(eq(designs.id, m.designId)).limit(1)
    : [];

  return {
    member: m,
    service,
    addonRows,
    removal: removal ?? null,
    design: design ?? null,
    // How long the chair is needed for: everything booked, added up.
    durationMin:
      service.durationMin +
      addonRows.reduce((sum, a) => sum + a.durationMin, 0) +
      (removal?.durationMin ?? 0),
    // Catalogue prices, VAT-inclusive as shown on the site.
    grossHalalas:
      service.priceHalalas +
      addonRows.reduce((sum, a) => sum + a.priceHalalas, 0) +
      (removal?.priceHalalas ?? 0),
  };
}

/**
 * Claim `count` consecutive ticket numbers for a branch's service day.
 *
 * One statement: the upsert takes a row lock, so two transactions asking at the
 * same instant get different numbers, and asking for 2 at once is what gives a
 * group its consecutive pair (K45, K46).
 */
export async function allocateTickets(
  tx: Tx,
  branchId: string,
  serviceDay: string,
  count: number,
): Promise<string[]> {
  const [row] = await tx
    .insert(ticketCounters)
    .values({ branchId, day: serviceDay, next: 1 + count })
    .onConflictDoUpdate({
      target: [ticketCounters.branchId, ticketCounters.day],
      set: { next: sql`${ticketCounters.next} + ${count}` },
    })
    .returning({ next: ticketCounters.next });

  const start = row.next - count;
  return Array.from({ length: count }, (_, i) => formatTicketNo(start + i));
}

/**
 * Release chairs held by web bookings that were never paid for.
 *
 * Runs as the first statement of every booking write. Filtering these out of the
 * availability query alone would not be enough: `bookings_station_slot_unique`
 * knows nothing about expiry and would still reject the replacement booking. By
 * actually cancelling them, the constraint and the calendar agree by construction.
 *
 * `source = 'web'` so a pending booking an admin created is never swept out from
 * under staff.
 */
async function sweepExpiredHolds(tx: Tx, branchId: string, holdMin: number): Promise<void> {
  await tx.execute(sql`
    update ${bookings} set status = 'cancelled', cancel_reason = 'payment-timeout', updated_at = now()
    where branch_id = ${branchId}
      and status = 'pending'
      and source = 'web'
      and created_at < now() - make_interval(mins => ${holdMin})
  `);
  // ponytail: sweeps only when someone tries to book. A branch with no booking
  // attempts keeps stale holds visible until the next one. Add a cron only if
  // that ever becomes visible to staff.
}

/**
 * The single write path. One guest or two, identically.
 *
 * Everything happens in one transaction: the chairs are locked, the customer is
 * upserted, and the rows land together. A group is all-or-nothing — if the second
 * guest can't be seated, neither is the first.
 */
export async function createBookings(input: CreateBookingsInput): Promise<CreateBookingsResult> {
  if (input.members.length < 1) return { ok: false, error: "failed" };

  const priced = await Promise.all(input.members.map(priceMember));
  if (priced.some((p) => p === null)) return { ok: false, error: "invalid-service" };
  const guests = priced as Priced[];

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: "failed" };

  const phone = input.customer.phone.trim();
  if (!phone) return { ok: false, error: "failed" };

  const settings = await getSettings([
    "vat_percent",
    "booking_hold_min",
    "group_discount_percent",
  ]);

  // The discount only exists because two people booked together, so it applies to
  // the combined bill and only when there is more than one of them.
  const isGroup = guests.length > 1;
  const split = splitGroupPrice(
    guests.map((g) => g.grossHalalas),
    isGroup ? settings.group_discount_percent : 0,
  );

  // Each guest keeps their own end time — one can have a 90-minute service while
  // the other has 45. The chairs are claimed for the longest of them so nobody's
  // chair gets taken out from under them mid-appointment.
  const endsAtPer = guests.map((g) => new Date(startsAt.getTime() + g.durationMin * 60_000));
  const latestEndsAt = new Date(Math.max(...endsAtPer.map((d) => d.getTime())));

  const status = input.status ?? "confirmed";
  const groupId = isGroup ? randomUUID() : null;
  const billTotal = split.reduce((sum, s) => sum + s.totalHalalas, 0);

  try {
    const created = await db.transaction(async (tx) => {
      await sweepExpiredHolds(tx, input.branchId, settings.booking_hold_min);

      const stationIds = await reserveStations(
        tx,
        input.branchId,
        startsAt,
        latestEndsAt,
        guests.length,
      );
      if (!stationIds) throw new BookingAbort("slot-taken");

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

      // Rolls the upsert back too, so a blocked caller leaves nothing behind.
      if (customer.blocked) throw new BookingAbort("blocked");

      // A pending booking has not been paid for and gets no number — the ticket
      // is issued at confirmation. Walk-ins are confirmed on the spot.
      const tickets =
        status === "confirmed"
          ? await allocateTickets(tx, input.branchId, utcToLocalDate(startsAt), guests.length)
          : null;

      const out: CreatedBooking[] = [];

      for (const [i, guest] of guests.entries()) {
        const { discountHalalas, totalHalalas } = split[i];
        // Prices are VAT-inclusive, so VAT comes back out of the discounted total
        // rather than being added on. The customer pays exactly what was shown.
        const vat = vatIncludedIn(totalHalalas, settings.vat_percent);

        const [row] = await tx
          .insert(bookings)
          .values({
            code: makeCode(),
            branchId: input.branchId,
            customerId: customer.id,
            stationId: stationIds[i],
            technicianId: input.technicianId ?? null,
            serviceId: guest.service.id,
            removalTypeId: guest.removal?.id ?? null,
            designId: guest.design?.id ?? null,
            startsAt,
            endsAt: endsAtPer[i],
            status,
            source: input.source,
            groupId,
            ticketNo: tickets?.[i] ?? null,
            // Snapshotted here and never joined live afterwards: raising a price
            // must not rewrite what this customer was charged.
            serviceName: guest.service.name as Localized,
            servicePriceHalalas: guest.service.priceHalalas,
            removalPriceHalalas: guest.removal?.priceHalalas ?? 0,
            discountHalalas,
            subtotalHalalas: totalHalalas - vat,
            vatHalalas: vat,
            totalHalalas,
            notes: input.notes ?? null,
          })
          .returning({ id: bookings.id, code: bookings.code });

        if (guest.addonRows.length) {
          await tx.insert(bookingAddons).values(
            guest.addonRows.map((a) => ({
              bookingId: row.id,
              addonId: a.id,
              name: a.name as Localized,
              priceHalalas: a.priceHalalas,
            })),
          );
        }

        out.push({
          id: row.id,
          code: row.code,
          ticketNo: tickets?.[i] ?? null,
          stationId: stationIds[i],
          totalHalalas,
        });
      }

      return out;
    });

    return { ok: true, groupId, totalHalalas: billTotal, bookings: created };
  } catch (err) {
    if (err instanceof BookingAbort) return { ok: false, error: err.reason };
    // Kept as a cheap backstop even though reserveStations now locks: a bug that
    // bypasses the lock should still fail loudly rather than double-book a chair.
    if (isSlotConflict(err)) return { ok: false, error: "slot-taken" };
    console.error("[bookings] create failed", err);
    return { ok: false, error: "failed" };
  }
}
