// Booking creation. One implementation, called by the public booking API and by
// the admin's walk-in form, so the two can't drift on pricing or conflict rules.
//
// A booking for two guests is not a separate code path: it is the same function
// with two members instead of one. Everything below — pricing, chair claiming,
// ticket numbers — is written to handle N and called with 1 or 2.

import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
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
import { refillDaysLeft, refillPriceHalalas, refillWindowEnd } from "@/lib/refill";
import { getSettings } from "@/lib/settings";
import { halalasToSar, splitGroupPrice, vatIncludedIn } from "@/lib/money";
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
  /**
   * The code of the booking this one refills. Set only by the refill button in
   * the customer's history — the window, the price and the one-per-booking rule
   * are all re-checked here rather than trusted from the client.
   */
  refillOfCode?: string | null;
  notes?: string | null;
  technicianId?: string | null;
  /**
   * Pin the booking to one specific chair instead of letting the engine choose.
   *
   * Set only by the station QR add-on (brief §2.7), where the customer is
   * already sitting somewhere and is asking about *that* chair. Everywhere else
   * this stays unset and the lowest free station wins, as before.
   */
  stationId?: string | null;
};

export type CreatedBooking = {
  id: string;
  code: string;
  ticketNo: string | null;
  stationId: string;
  totalHalalas: number;
};

export type CreateBookingError =
  | "invalid-service"
  | "slot-taken"
  | "blocked"
  /** The offer itself has lapsed, or was never on this booking. */
  | "refill-expired"
  /** The offer is open, but the appointment chosen falls outside its window. */
  | "refill-window"
  | "failed";

export type CreateBookingsResult =
  | { ok: true; groupId: string | null; totalHalalas: number; bookings: CreatedBooking[] }
  | { ok: false; error: CreateBookingError };

// ---- the original one-guest API, unchanged for existing callers -------------

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
  | { ok: true; id: string; code: string; ticketNo: string | null; totalHalalas: number }
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

/**
 * Two people clicking the same refill button at once. The eligibility read
 * cannot catch this — both requests see an unused window — so the partial unique
 * index on refill_of_booking_id decides it and the loser lands here.
 */
function isRefillConflict(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e.message.includes("bookings_refill_of_unique")) return true;
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
  /** What the service line actually costs — reduced when this is a refill. */
  servicePriceHalalas: number;
  grossHalalas: number;
};

/**
 * Catalogue lookup and gross price for one guest. No VAT, no discount, no writes —
 * just "what is this person buying and how long does it take". Read outside the
 * transaction so the lock in reserveStations is held for as little time as possible.
 */
async function priceMember(m: BookingMember, refillPercent = 0): Promise<Priced | null> {
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

  // A refill is the same service at a reduced rate. Add-ons and removal are
  // extra work either way, so only the service line moves.
  const servicePriceHalalas = refillPercent
    ? refillPriceHalalas(service.priceHalalas, refillPercent)
    : service.priceHalalas;

  return {
    member: m,
    service,
    addonRows,
    removal: removal ?? null,
    design: design ?? null,
    // How long the chair is needed for: everything booked, added up. A refill
    // occupies the chair for the same time as the full service.
    durationMin:
      service.durationMin +
      addonRows.reduce((sum, a) => sum + a.durationMin, 0) +
      (removal?.durationMin ?? 0),
    // Catalogue prices, VAT-inclusive as shown on the site.
    servicePriceHalalas,
    grossHalalas:
      servicePriceHalalas +
      addonRows.reduce((sum, a) => sum + a.priceHalalas, 0) +
      (removal?.priceHalalas ?? 0),
  };
}

/**
 * The booking a refill is claiming, with everything `refillDaysLeft` needs to
 * judge it: when it happened, whether it was served, how long its service's
 * window is, and whether that window has already been spent.
 */
async function loadRefillParent(code: string) {
  const [parent] = await db
    .select({
      id: bookings.id,
      serviceId: bookings.serviceId,
      startsAt: bookings.startsAt,
      status: bookings.status,
      refillOfBookingId: bookings.refillOfBookingId,
      refillExpiresAt: bookings.refillExpiresAt,
      removalTypeId: bookings.removalTypeId,
      refillDays: services.refillDays,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(eq(bookings.code, code.trim().toUpperCase()))
    .limit(1);

  if (!parent) return null;

  const spent = await claimedWindows([parent.id]);

  return {
    ...parent,
    refillDays: parent.refillDays ?? 0,
    alreadyRefilled: spent.has(parent.id),
    isRefill: Boolean(parent.refillOfBookingId),
    // Renamed for refillDaysLeft(), which takes the deadline as `expiresAt`.
    // Without this an admin-granted window is honoured in the booking history
    // and then refused here, which is the worst of both.
    expiresAt: parent.refillExpiresAt,
  };
}

/**
 * Of these bookings, which have already had their refill claimed.
 *
 * One query for a whole page rather than one per row, and one definition of
 * "claimed" — a cancelled or no-show refill hands the window back, exactly as
 * the `bookings_refill_of_unique` index has it. Written once because the
 * history, the reminder job and the write path all have to agree.
 */
export async function claimedWindows(bookingIds: string[]): Promise<Set<string>> {
  if (!bookingIds.length) return new Set();

  const rows = await db
    .select({ parent: bookings.refillOfBookingId })
    .from(bookings)
    .where(
      and(
        inArray(bookings.refillOfBookingId, bookingIds),
        notInArray(bookings.status, ["cancelled", "no_show"]),
      ),
    );

  return new Set(rows.map((r) => r.parent as string));
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

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: "failed" };

  const phone = input.customer.phone.trim();
  if (!phone) return { ok: false, error: "failed" };

  // Stored lowercase so the confirmation always goes to the same address no
  // matter how the customer capitalised it this time.
  const email = input.customer.email?.trim().toLowerCase() || null;

  const settings = await getSettings([
    "vat_percent",
    "booking_hold_min",
    "group_discount_percent",
    "refill_discount_percent",
  ]);

  // A refill is checked before anything is priced: the window has to be open,
  // and it has to be the same service the customer originally had. The button
  // in the history already knows all this — re-deciding it here is what stops a
  // hand-crafted request from buying a full set at half price.
  let refillParent: Awaited<ReturnType<typeof loadRefillParent>> = null;
  if (input.refillOfCode) {
    refillParent = await loadRefillParent(input.refillOfCode);
    if (!refillParent) return { ok: false, error: "refill-expired" };
    if (!refillDaysLeft(refillParent)) return { ok: false, error: "refill-expired" };

    // The *appointment* must fall inside the window, not merely the moment of
    // booking. Checking only `refillDaysLeft` — "is the offer open today" —
    // let someone open a closing window and book the discounted slot months
    // out, which is the whole thing the window exists to prevent: a nail refill
    // is only a refill while the nails are still on.
    const windowEnd = refillWindowEnd(refillParent);
    if (windowEnd && startsAt > windowEnd) {
      return { ok: false, error: "refill-window" };
    }

    // One guest, and the service they had. A refill is not a group outing.
    if (input.members.length !== 1 || input.members[0].serviceId !== refillParent.serviceId) {
      return { ok: false, error: "invalid-service" };
    }
  }

  const priced = await Promise.all(
    input.members.map((m) =>
      priceMember(m, refillParent ? settings.refill_discount_percent : 0),
    ),
  );
  if (priced.some((p) => p === null)) return { ok: false, error: "invalid-service" };
  const guests = priced as Priced[];

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
        { onlyStationId: input.stationId ?? undefined },
      );
      if (!stationIds) throw new BookingAbort("slot-taken");

      const [customer] = await tx
        .insert(customers)
        .values({
          phone,
          name: input.customer.name?.trim() || null,
          email,
          lang: input.customer.lang ?? "ar",
        })
        .onConflictDoUpdate({
          target: customers.phone,
          // Don't blank an existing name or email with an empty one from a
          // rushed form — but do record a newly supplied one: it is how a
          // returning customer gets an address on file, and it keeps the
          // invoice going to the address typed at checkout rather than a stale
          // one.
          set: {
            name: input.customer.name?.trim() || undefined,
            email: email ?? undefined,
            updatedAt: new Date(),
          },
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
            servicePriceHalalas: guest.servicePriceHalalas,
            refillOfBookingId: refillParent?.id ?? null,
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
    // Someone else already spent this window between the check and the insert.
    if (isRefillConflict(err)) return { ok: false, error: "refill-expired" };
    console.error("[bookings] create failed", err);
    return { ok: false, error: "failed" };
  }
}

/** One guest. Thin wrapper so the admin walk-in form is unaffected by the above. */
export async function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
  const result = await createBookings({
    branchId: input.branchId,
    startsAt: input.startsAt,
    customer: input.customer,
    source: input.source,
    notes: input.notes,
    technicianId: input.technicianId,
    members: [
      {
        serviceId: input.serviceId,
        addonIds: input.addonIds,
        removalTypeId: input.removalTypeId,
        designId: input.designId,
      },
    ],
  });

  if (!result.ok) return result;
  const [only] = result.bookings;
  return {
    ok: true,
    id: only.id,
    code: only.code,
    ticketNo: only.ticketNo,
    totalHalalas: only.totalHalalas,
  };
}

export type RescheduleResult =
  | { ok: true; startsAt: Date; stationIds: string[] }
  | { ok: false; error: "not-found" | "slot-taken" | "failed" };

/**
 * Move a booking to a new start time, keeping its duration and price.
 *
 * One implementation, two callers — the admin's booking drawer and the
 * customer's own history (brief §2.6) — for the same reason `createBookings`
 * has one: the two must not drift on what counts as a free chair.
 *
 * It deliberately does **not** enforce the 3-hour customer window or any
 * permission: this is the mechanics of moving a booking. Who is allowed to move
 * it, and how late, belongs to the caller — the admin can move an appointment
 * ten minutes before it starts, and should be able to.
 *
 * A group moves as a unit. Every guest starting at the same moment is a §2.4
 * invariant, so moving one member and not the others would produce a booking
 * that could never have been made in the first place.
 */
export async function rescheduleBooking(input: {
  id: string;
  startsAt: Date;
}): Promise<RescheduleResult> {
  if (Number.isNaN(input.startsAt.getTime())) return { ok: false, error: "failed" };

  const [anchor] = await db.select().from(bookings).where(eq(bookings.id, input.id)).limit(1);
  if (!anchor) return { ok: false, error: "not-found" };

  const members = anchor.groupId
    ? await db
        .select()
        .from(bookings)
        .where(eq(bookings.groupId, anchor.groupId))
        .orderBy(asc(bookings.createdAt), asc(bookings.id))
    : [anchor];

  // Each guest keeps their own duration — moving an appointment must not
  // silently shorten or lengthen it, and in a group the two may differ.
  const durations = members.map((m) => m.endsAt.getTime() - m.startsAt.getTime());
  const latestEndsAt = new Date(input.startsAt.getTime() + Math.max(...durations));

  try {
    const moved = await db.transaction(async (tx) => {
      // Claim and move in one transaction, so nobody can take the target chair
      // between the check and the update. Their own chairs are fair game —
      // hence the ignore ids, or a booking would see itself as the conflict.
      const stationIds = await reserveStations(
        tx,
        anchor.branchId,
        input.startsAt,
        latestEndsAt,
        members.length,
        { ignoreBookingIds: members.map((m) => m.id) },
      );
      if (!stationIds) return null;

      for (const [i, member] of members.entries()) {
        await tx
          .update(bookings)
          .set({
            startsAt: input.startsAt,
            endsAt: new Date(input.startsAt.getTime() + durations[i]),
            stationId: stationIds[i],
            updatedAt: new Date(),
          })
          .where(eq(bookings.id, member.id));
      }

      return stationIds;
    });

    if (!moved) return { ok: false, error: "slot-taken" };
    return { ok: true, startsAt: input.startsAt, stationIds: moved };
  } catch (err) {
    if (isSlotConflict(err)) return { ok: false, error: "slot-taken" };
    console.error("[bookings] reschedule failed", err);
    return { ok: false, error: "failed" };
  }
}

/** What the booking page needs to render a refill: the service, locked, at its
 * reduced price, with the countdown. Null means "no offer" — an unknown code, a
 * lapsed window, an already-claimed one, or a service the salon has since
 * deactivated — and the page then behaves like an ordinary booking.
 */
export type RefillLine = { id: string; name: Localized; priceSar: number };

/**
 * A refill is the *same appointment again*, so the offer carries everything the
 * original booking included — the customer picks nothing.
 *
 * Only the service line is discounted. Add-ons and removal are the same amount
 * of work whether or not it's a refill, which is exactly how `priceMember()`
 * prices it server-side; this mirrors that so the quote and the charge agree.
 */
export type RefillOffer = {
  code: string;
  serviceId: string;
  serviceName: Localized;
  /** The discounted service line. */
  priceSar: number;
  /** What that service normally costs, for the struck-through comparison. */
  fullPriceSar: number;
  addons: RefillLine[];
  removal: RefillLine | null;
  /** Service + add-ons + removal — what the customer will actually pay. */
  totalSar: number;
  daysLeft: number;
  /**
   * Last bookable day, `YYYY-MM-DD` in Riyadh. The appointment must fall on or
   * before this — see the `refill-window` check in createBookings, which is the
   * authority. The picker uses it to grey out later dates.
   */
  lastDate: string | null;
};

export async function getRefillOffer(code: string): Promise<RefillOffer | null> {
  const parent = await loadRefillParent(code);
  if (!parent?.serviceId) return null;

  const daysLeft = refillDaysLeft(parent);
  if (!daysLeft) return null;

  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, parent.serviceId), eq(services.active, true)))
    .limit(1);
  if (!service) return null;

  const settings = await getSettings(["refill_discount_percent"]);

  // Snapshots from the original booking, not today's catalogue: this is a repeat
  // of what they had. Rows whose add-on was since deleted keep their snapshot
  // name and price, so the offer still describes the appointment truthfully.
  const extras = await db
    .select()
    .from(bookingAddons)
    .where(eq(bookingAddons.bookingId, parent.id));

  const addons: RefillLine[] = extras
    .filter((e) => e.addonId && e.name)
    .map((e) => ({
      id: e.addonId as string,
      name: e.name as Localized,
      priceSar: halalasToSar(e.priceHalalas),
    }));

  const [removalRow] = parent.removalTypeId
    ? await db
        .select()
        .from(removalTypes)
        .where(eq(removalTypes.id, parent.removalTypeId))
        .limit(1)
    : [];

  const removal: RefillLine | null = removalRow
    ? {
        id: removalRow.id,
        name: removalRow.name as Localized,
        priceSar: halalasToSar(removalRow.priceHalalas),
      }
    : null;

  const servicePriceSar = halalasToSar(
    refillPriceHalalas(service.priceHalalas, settings.refill_discount_percent),
  );

  return {
    code: code.trim().toUpperCase(),
    serviceId: service.id,
    serviceName: service.name as Localized,
    priceSar: servicePriceSar,
    fullPriceSar: halalasToSar(service.priceHalalas),
    addons,
    removal,
    totalSar:
      servicePriceSar +
      addons.reduce((sum, a) => sum + a.priceSar, 0) +
      (removal?.priceSar ?? 0),
    daysLeft,
    // Same helper the server validates against, so the greyed-out dates and the
    // rejected ones are the same set.
    lastDate: (() => {
      const end = refillWindowEnd(parent);
      return end ? utcToLocalDate(end) : null;
    })(),
  };
}
