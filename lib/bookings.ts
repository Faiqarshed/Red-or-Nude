// Booking creation. One implementation, called by the public booking API and by
// the admin's walk-in form, so the two can't drift on pricing or conflict rules.
//
// A group booking is not a separate code path: it is the same function with
// more members. Everything below — pricing, chair claiming, ticket numbers — is
// written to handle N, and the HTTP edge decides how many N may be (four).
//
// A member may carry her own branch and her own start; both default to the
// party's. What the party shares is the local day, and that is the one thing
// enforced here rather than left to the screen.

import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db";
import {
  addons,
  bookingAddons,
  bookings,
  branches,
  customers,
  designs,
  removalTypes,
  services,
  staff,
  ticketCounters,
  type Localized,
} from "@/lib/db/schema";
import { reserveStations, utcToLocalDate } from "@/lib/availability";
import { canCancel, cancelDeadline } from "@/lib/cancellation";
import { refillDaysLeft, refillWindowEnd } from "@/lib/refill";
import { getSettings } from "@/lib/settings";
import { halalasToSar, shareAmount, splitGroupPrice, vatIncludedIn } from "@/lib/money";
import { quotePromo, type PromoRefusal } from "@/lib/promo";
import { quoteReward, spendPoints } from "@/lib/loyalty";
import { quotePackCredit, spendPackCredit } from "@/lib/packs";
import type { RewardRefusal } from "@/lib/rewards";
import { formatTicketNo } from "@/lib/tickets";
import { assignIfToday } from "@/lib/assign";
import { mediaUrl } from "@/lib/storage";
import type { BookingSummary } from "@/lib/booking";

/** What one guest is booking. */
export type BookingMember = {
  /**
   * Who this chair is for, when it is not the person paying.
   *
   * Optional, and falls back to the booker: guest 1 *is* the customer filling in
   * checkout, so asking for her name twice would be a form asking a question it
   * already knows the answer to. Guest 2 is a friend the salon has no other way
   * of learning about — without this the desk sees the booker's name on both
   * chairs and has to guess which of the two women in front of it is which.
   */
  guestName?: string | null;
  serviceId: string;
  addonIds: string[];
  removalTypeId?: string | null;
  designId?: string | null;
  /**
   * This guest's own branch and start, when they differ from the party's.
   *
   * A group is four women going out together, not four women sitting in a row:
   * the client asked for one to be able to take 11:00 at Al Urubah while
   * another takes 14:00 across town. Both default to the party's, so a solo
   * booking and the shape the payment page already posts are unchanged.
   *
   * The one thing held in common is the day — see the check in createBookings.
   */
  branchId?: string | null;
  startsAt?: string | null;
  /**
   * Pay for this guest's service line with a credit from a membership pack she
   * already owns (docs/SCOPE-ENHANCEMENT.md §6).
   *
   * The purchase, not the pack: a customer may hold two of the same pack, and
   * the credit comes off one of them. Re-checked here against her own ledger —
   * nothing the browser sends decides whether a credit exists.
   *
   * Only the service line goes to zero. Add-ons, a removal and a coffee are the
   * same work and the same cost whether or not a pack paid for the service,
   * exactly as they are on a refill.
   */
  customerPackId?: string | null;
};

export type CreateBookingsInput = {
  /** The party's branch. A member may override it with one of their own. */
  branchId: string;
  /** ISO UTC. The party's start; a member may override it with their own. */
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
  /**
   * A discount code typed at checkout (brief §2.10). Re-looked-up and re-priced
   * here rather than trusted from the client, for the same reason the refill
   * window is: the quote the browser showed is a preview, this is the charge.
   */
  promoCode?: string | null;
  /**
   * The signed-in customer, resolved from the session cookie by the caller.
   *
   * **Trusted, and therefore never read from a request body.** The route reads
   * it with currentCustomer() and passes it down; this module has no access to
   * request context and shouldn't. Anything else would let a request nominate
   * whose wallet to spend.
   *
   * When set, this row is used as-is and the phone upsert below is skipped —
   * otherwise a signed-in customer who edits the phone field at checkout would
   * book against a second row while the points came off the first.
   */
  customerId?: string | null;
  /**
   * A reward rung the customer ticked at checkout (brief §2.8), in points.
   *
   * Re-quoted against a freshly read balance here rather than trusted, exactly
   * as the promo code is: the browser showed a preview, this is the charge.
   * Ignored entirely without a `customerId` — there is no wallet to spend.
   */
  redeemPoints?: number | null;
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
  /** A group was posted with guests on two different days. */
  | "different-day"
  /** A discount code was given and does not apply. `promoReason` says why. */
  | "promo-invalid"
  /**
   * A reward rung was ticked and can't be spent — no such rung, or the balance
   * moved between the preview and the charge. `rewardReason` says which.
   */
  | "reward-invalid"
  | "failed";

export type CreateBookingsResult =
  | {
      ok: true;
      groupId: string | null;
      totalHalalas: number;
      bookings: CreatedBooking[];
      /** Points actually spent on this bill, so the success screen can say so. */
      pointsSpent: number;
    }
  | {
      ok: false;
      error: CreateBookingError;
      /** Set only with `promo-invalid` — the checkout repeats it to the customer. */
      promoReason?: PromoRefusal;
      minTotalHalalas?: number;
      /** Set only with `reward-invalid`. */
      rewardReason?: RewardRefusal;
      /** The balance as it actually is, so the checkout can correct itself. */
      pointsBalance?: number;
    };

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
  /** The purchase a credit is coming from, once it has been checked. */
  packCredit: { customerPackId: string; serviceId: string } | null;
  /** What the discounts are worked out on. Excludes `treatHalalas`. */
  grossHalalas: number;
  /**
   * The checkout upsells — coffee and a cookie. Held out of the gross because
   * they are never discounted: not by the group discount, not by a promo code,
   * not by a loyalty rung. 10 SAR is 10 SAR, so this goes back on after the
   * whole discount stack has run.
   */
  treatHalalas: number;
};

/**
 * Catalogue lookup and gross price for one guest. No VAT, no discount, no writes —
 * just "what is this person buying and how long does it take". Read outside the
 * transaction so the lock in reserveStations is held for as little time as possible.
 */
async function priceMember(
  m: BookingMember,
  /** The flat refill price, or null when this is an ordinary booking. */
  refillPriceHalalas: number | null = null,
  /** Her account, when there is one. A pack credit needs an owner to belong to. */
  customerId: string | null = null,
): Promise<Priced | null> {
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

  // A credit pays for the service line and nothing else. Quoted against her own
  // ledger rather than trusted: the browser knowing about a credit is not the
  // same as her having one, and this is the read the charge is built on.
  //
  // A refill priced by a credit would be two discounts on one line, so a pack
  // wins and the refill price is simply not reached — nothing chains here.
  const credit =
    customerId && m.customerPackId
      ? await quotePackCredit(customerId, m.customerPackId, m.serviceId)
      : null;
  const packCredit = credit?.ok ? { customerPackId: credit.customerPackId, serviceId: credit.serviceId } : null;

  // A refill is the same service at a flat price, whatever the service costs.
  // Add-ons and removal are extra work either way, so only the service line
  // moves — a refill with a removal on it pays for the removal.
  const servicePriceHalalas = packCredit ? 0 : (refillPriceHalalas ?? service.priceHalalas);

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
    packCredit,
    grossHalalas:
      servicePriceHalalas +
      addonRows.reduce((sum, a) => sum + (a.atCheckout ? 0 : a.priceHalalas), 0) +
      (removal?.priceHalalas ?? 0),
    treatHalalas: addonRows.reduce((sum, a) => sum + (a.atCheckout ? a.priceHalalas : 0), 0),
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
 * A customer's bookings, shaped as the customer is allowed to see them.
 *
 * One definition for both ways in, because the shape is a privacy boundary and
 * not a view model: it deliberately omits the name, phone, email and station,
 * and two copies of that promise is one copy too many. /my-bookings and
 * /account rendered the same object from two hand-written queries before this,
 * which meant a field added carelessly to either leaked from one screen only.
 *
 * One lookup kind per credential, rather than a free-form filter: a reference
 * opens that booking *and the rest of its party*, a session opens that
 * customer's own history, newest first. The order and the limit follow from
 * which credential was used, so they are not knobs a caller can get wrong.
 *
 * **A reference opens the whole party.** Two guests who booked together are two
 * rows with two codes, and quoting either one used to reveal exactly half the
 * appointment: the customer who paid one bill for two people saw one booking and
 * had to find a second reference to see the other. Cancelling already worked on
 * the party (lib/payments/confirm.ts and the cancel route both fan out over
 * `group_id`), so the read was the odd one out.
 *
 * It leaks nothing: the members share one `customer_id`, which is exactly who
 * this reference already belonged to, and the shape omits name, phone and email
 * either way.
 */
export async function bookingSummaries(
  lookup: { code: string } | { customerId: string },
): Promise<BookingSummary[]> {
  const byCode = "code" in lookup;

  // Resolve a reference to its party before reading. One extra round trip on the
  // guest path only, and it buys the whole appointment instead of half of it.
  let codeFilter = byCode ? eq(bookings.code, lookup.code) : undefined;
  if (byCode) {
    const [found] = await db
      .select({ groupId: bookings.groupId })
      .from(bookings)
      .where(eq(bookings.code, lookup.code))
      .limit(1);
    if (found?.groupId) codeFilter = eq(bookings.groupId, found.groupId);
  }

  const rows = await db
    .select({
      id: bookings.id,
      code: bookings.code,
      groupId: bookings.groupId,
      branchId: bookings.branchId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      status: bookings.status,
      ticketNo: bookings.ticketNo,
      serviceName: bookings.serviceName,
      totalHalalas: bookings.totalHalalas,
      refillOfBookingId: bookings.refillOfBookingId,
      refillDays: services.refillDays,
      // Live catalogue image, not a snapshot: if the salon reshoots a service
      // the old bookings should show the new picture, and there is nothing to
      // mis-price here the way there would be with a stored image of a receipt.
      serviceImage: services.image,
      branchName: branches.name,
      technicianName: staff.name,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .leftJoin(branches, eq(branches.id, bookings.branchId))
    .leftJoin(staff, eq(staff.id, bookings.technicianId))
    .where(byCode ? codeFilter : eq(bookings.customerId, lookup.customerId))
    // A party is at most a handful, so the reference path keeps a small cap
    // rather than none: whatever the group table says, this is still a lookup
    // by one code and should never return a page of history.
    .orderBy(desc(bookings.startsAt))
    .limit(byCode ? 10 : 50);

  const bookingIds = rows.map((r) => r.id);

  const [spentOn, { cancel_cutoff_hours: cutoff }, addonRows] = await Promise.all([
    claimedWindows(bookingIds),
    getSettings(["cancel_cutoff_hours"]),
    bookingIds.length
      ? db
          .select({
            bookingId: bookingAddons.bookingId,
            name: bookingAddons.name,
            addonName: addons.name,
            image: addons.image,
          })
          .from(bookingAddons)
          .innerJoin(addons, eq(addons.id, bookingAddons.addonId))
          .where(inArray(bookingAddons.bookingId, bookingIds))
      : Promise.resolve([]),
  ]);

  // Group addons by booking.
  const addonsByBooking = new Map<string, { name: Localized | null; image: string | null }[]>();
  for (const ar of addonRows) {
    const item = {
      name: ar.name ?? ar.addonName ?? null,
      image: mediaUrl(ar.image),
    };
    const list = addonsByBooking.get(ar.bookingId);
    if (list) list.push(item);
    else addonsByBooking.set(ar.bookingId, [item]);
  }

  const now = new Date();

  return rows.map((r) => {
    const daysLeft = refillDaysLeft(
      {
        startsAt: r.startsAt,
        status: r.status,
        refillDays: r.refillDays ?? 0,
        alreadyRefilled: spentOn.has(r.id),
        isRefill: Boolean(r.refillOfBookingId),
      },
      now,
    );

    return {
      code: r.code,
      // Only whether this booking has company, and how much. Not the other
      // person's name — she is a second customer with her own privacy, and the
      // one who booked already knows who she brought.
      groupSize: r.groupId ? rows.filter((x) => x.groupId === r.groupId).length : 1,
      startsAt: r.startsAt.toISOString(),
      status: r.status,
      ticketNo: r.ticketNo,
      serviceName: r.serviceName,
      totalSar: halalasToSar(r.totalHalalas),
      isRefill: Boolean(r.refillOfBookingId),
      // Only *whether* a refill is on offer. The countdown, the price and the
      // booking link all sit behind the emailed code at
      // POST /api/my-bookings/refill — otherwise holding a forwarded reference
      // would be enough to read them, and the code would be gating nothing.
      hasRefill: daysLeft > 0,

      // The cancellation window (brief §2.6), decided here and not in the
      // browser: the buttons must never offer what the API would refuse.
      // `cancelBy` is sent even once the window has shut, so the screen can
      // explain *why* the buttons are gone rather than silently omitting them.
      canCancel: canCancel(r, cutoff, now),
      cancelBy: cancelDeadline(r, cutoff).toISOString(),
      branchId: r.branchId,
      durationMin: Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000),
      serviceImage: mediaUrl(r.serviceImage),
      addons: addonsByBooking.get(r.id) ?? [],
      branchName: r.branchName,
      technicianName: r.technicianName ?? null,
    };
  });
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
 * Release chairs whose customer never checked in.
 *
 * A booking is paid for and holds a chair for its whole duration. If nobody
 * turns up, that chair sits empty while walk-ins are turned away — the salon
 * loses the slot twice, having already been paid for it once. After the grace
 * period the chair goes back into the pool.
 *
 * `status = 'no_show'` is the entire mechanism: both `bookings_station_slot_unique`
 * and `reserveStations` already exclude it, as does the availability engine's
 * conflict scan. Releasing a chair *is* setting the status.
 *
 * **`checked_in` is the check-in.** A booking still `confirmed` past its grace
 * is one nobody marked as arrived. That is a weaker signal than it sounds —
 * today staff rarely press anything — which is why:
 *
 *   - `no_show_at` marks it for a human rather than closing the matter, and a
 *     wrongly flagged booking is cleared with one button;
 *   - the booking itself is untouched — the customer has lost nothing until a
 *     walk-in actually claims the chair.
 *
 * Bounded to **today** and nothing narrower. There was a four-hour lookback here
 * on the grounds that a released chair stops mattering by the evening — which is
 * true of the chair and wrong about the point. The flag is not about the chair,
 * it is about a customer who paid and was not served, and she is owed an answer
 * whether staff open this screen at 11am or at closing. A narrower window did
 * not protect anyone; it dropped people silently.
 *
 * **The day bound was too tight, and hid the commonest case.** It read
 * `starts_at >= today`, so the moment a day rolled over, everything nobody
 * checked in yesterday stopped being sweepable and stayed `confirmed` for good.
 * Found the obvious way: a salon full of finished appointments still reading as
 * upcoming, days later.
 *
 * What that bound was actually for — not flagging months of untouched history —
 * is worth keeping, so it is now a short lookback instead of "today". Old enough
 * and the flag stops being useful anyway: nobody chases a customer about an
 * appointment she missed five weeks ago, and the chair was given back long since.
 *
 * `no_show_at is null` makes it idempotent: a booking already flagged keeps its
 * original timestamp however many times this runs.
 */
const NO_SHOW_LOOKBACK_DAYS = 7;

export async function sweepNoShows(branchId: string): Promise<void> {
  const { no_show_grace_min: graceMin } = await getSettings(["no_show_grace_min"]);

  await db.execute(sql`
    update ${bookings}
       set status = 'no_show', no_show_at = now(), updated_at = now()
     where branch_id = ${branchId}
       and status = 'confirmed'
       and no_show_at is null
       and starts_at >= now() - make_interval(days => ${NO_SHOW_LOOKBACK_DAYS})
       and starts_at <  now() - make_interval(mins => ${graceMin})
  `);
  // ponytail: like sweepExpiredHolds above, this only runs when someone looks —
  // a booking page nobody opens keeps its chair held. Good enough while a
  // receptionist is at the screen all day; a cron replaces it if that changes.
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
    "refill_price_halalas",
  ]);

  // Give back chairs whose customer never checked in, before we go looking for a
  // free one. This is what lets a receptionist seat a walk-in in the chair of
  // someone who did not turn up. Outside the transaction on purpose: it is an
  // independent state change, and it must not be rolled back if this particular
  // booking then fails to find a chair.
  // Every branch the party touches, not just the party's own.
  for (const branchId of new Set(input.members.map((m) => m.branchId ?? input.branchId))) {
    await sweepNoShows(branchId);
  }

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

  // Where and when each guest actually sits. Falls back to the party's, so the
  // solo path and every existing caller are untouched.
  const day = utcToLocalDate(startsAt);
  const placements: { branchId: string; startsAt: Date }[] = [];
  for (const m of input.members) {
    const at = m.startsAt ? new Date(m.startsAt) : startsAt;
    if (Number.isNaN(at.getTime())) return { ok: false, error: "failed" };
    // One day is the whole of what a party holds in common now. It is what
    // makes the group discount mean something — four people out together — and
    // it is the only thing the client asked to keep fixed.
    if (utcToLocalDate(at) !== day) return { ok: false, error: "different-day" };
    placements.push({ branchId: m.branchId ?? input.branchId, startsAt: at });
  }

  const priced = await Promise.all(
    input.members.map((m) =>
      priceMember(m, refillParent ? settings.refill_price_halalas : null, input.customerId ?? null),
    ),
  );
  if (priced.some((p) => p === null)) return { ok: false, error: "invalid-service" };
  const guests = priced as Priced[];

  // The discount exists because they booked together, so it applies to the
  // combined bill and only when there is more than one of them — however the
  // party is spread across the day.
  const isGroup = guests.length > 1;
  const split = splitGroupPrice(
    guests.map((g) => g.grossHalalas),
    isGroup ? settings.group_discount_percent : 0,
  );

  // Each guest keeps their own end time — one can have a 90-minute service while
  // the other has 45, and now they need not have started together either.
  const endsAtPer = guests.map(
    (g, i) => new Date(placements[i].startsAt.getTime() + g.durationMin * 60_000),
  );

  /** Do two guests want a chair at the same branch at the same moment? */
  const clash = (a: number, b: number) =>
    placements[a].branchId === placements[b].branchId &&
    placements[a].startsAt < endsAtPer[b] &&
    placements[b].startsAt < endsAtPer[a];

  // The promo comes off last, on top of whatever the group or refill discount
  // already took — the codes are occasion offers, not alternatives to the other
  // two, and a customer who qualifies for both should get both.
  //
  // Quoted against the *combined* discounted bill, then shared back out by the
  // same largest-remainder split the group discount uses, so the guests' totals
  // still add up to the bill to the halala.
  const groupTotals = split.map((s) => s.totalHalalas);
  let promoCodeId: string | null = null;
  let promoShares = guests.map(() => 0);

  if (input.promoCode?.trim()) {
    const quote = await quotePromo(
      input.promoCode,
      groupTotals.reduce((sum, t) => sum + t, 0),
    );
    // Refused rather than ignored: silently charging full price to someone who
    // typed a code is the one outcome nobody would accept.
    if (!quote.ok) {
      return {
        ok: false,
        error: "promo-invalid",
        promoReason: quote.reason,
        minTotalHalalas: quote.minTotalHalalas,
      };
    }
    promoCodeId = quote.id;
    promoShares = shareAmount(groupTotals, quote.discountHalalas);
  }

  // The reward comes off last of all — after the group or refill discount, and
  // after the promo. A rung is a thank-you for money already spent, not an
  // alternative to an offer the customer also qualifies for.
  //
  // Quoted against the bill as it stands *after* the promo, so 10% off means 10%
  // of what is actually left to pay, then shared back out by the same
  // largest-remainder split, so the guests' totals still add to the halala.
  const afterPromo = groupTotals.map((t, i) => t - promoShares[i]);
  let pointsSpent = 0;
  let rewardShares = guests.map(() => 0);

  if (input.customerId && input.redeemPoints) {
    const quote = await quoteReward(
      input.customerId,
      input.redeemPoints,
      afterPromo.reduce((sum, t) => sum + t, 0),
    );
    // Refused rather than ignored, for the same reason a bad promo code is:
    // silently charging full price to someone who ticked a reward — and would
    // have spent points for it — is the one outcome nobody would accept.
    if (!quote.ok) {
      return {
        ok: false,
        error: "reward-invalid",
        rewardReason: quote.reason,
        pointsBalance: quote.balance,
      };
    }
    pointsSpent = quote.points;
    rewardShares = shareAmount(afterPromo, quote.discountHalalas);
  }

  const status = input.status ?? "confirmed";
  const groupId = isGroup ? randomUUID() : null;
  // The treats go back on last, after every discount has been taken — that is
  // what "a coffee is 10 SAR" means. They were never in `grossHalalas`, so no
  // discount above has seen them.
  const billTotal = afterPromo.reduce(
    (sum, t, i) => sum + t - rewardShares[i] + guests[i].treatHalalas,
    0,
  );

  try {
    const created = await db.transaction(async (tx) => {
      for (const branchId of new Set(placements.map((p) => p.branchId))) {
        await sweepExpiredHolds(tx, branchId, settings.booking_hold_min);
      }

      // One guest at a time, each at her own branch and hour, rather than N
      // chairs in one call at one place. Still all-or-nothing: the first guest
      // who cannot be seated aborts the transaction and the party keeps nothing,
      // which is the right behaviour for people who came out together.
      //
      // Chairs already promised in this transaction are held back by hand —
      // nothing is inserted until the loop below, so the conflict scan inside
      // reserveStations cannot see them yet.
      const stationIds: string[] = [];
      for (let i = 0; i < placements.length; i++) {
        const got = await reserveStations(
          tx,
          placements[i].branchId,
          placements[i].startsAt,
          endsAtPer[i],
          1,
          {
            onlyStationId: input.stationId ?? undefined,
            excludeStationIds: stationIds.filter((_, j) => clash(i, j)),
          },
        );
        if (!got) throw new BookingAbort("slot-taken");
        stationIds.push(got[0]);
      }

      // A signed-in customer books against the row they signed in as, full stop.
      //
      // The upsert below would otherwise conflict on whatever phone number was
      // in the form, and a customer who corrected a typo there would end up
      // booking as a *different* row than the one their points came out of.
      // `for update` takes the same row lock the upsert would have, which is
      // what serialises two checkouts in two tabs trying to spend one balance.
      const [customer] = input.customerId
        ? await tx
            .select()
            .from(customers)
            .where(eq(customers.id, input.customerId))
            .limit(1)
            .for("update")
        : await tx
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
              // invoice going to the address typed at checkout rather than a
              // stale one.
              set: {
                name: input.customer.name?.trim() || undefined,
                email: email ?? undefined,
                updatedAt: new Date(),
              },
            })
            .returning();

      // The session pointed at a row that is no longer there. Rare, but the
      // alternative is a foreign key error further down.
      if (!customer) throw new BookingAbort("failed");

      // Rolls the upsert back too, so a blocked caller leaves nothing behind.
      if (customer.blocked) throw new BookingAbort("blocked");

      // A pending booking has not been paid for and gets no number — the ticket
      // is issued at confirmation. Walk-ins are confirmed on the spot.
      //
      // Per branch, because ticket_counters is keyed (branch_id, day): a party
      // split across two salons takes one number from each queue rather than
      // consecutive numbers from a queue only half of them are standing in.
      let tickets: (string | null)[] | null = null;
      if (status === "confirmed") {
        tickets = guests.map(() => null);
        const byBranch = new Map<string, number[]>();
        placements.forEach((p, i) => byBranch.set(p.branchId, [...(byBranch.get(p.branchId) ?? []), i]));
        for (const [branchId, indexes] of byBranch) {
          const issued = await allocateTickets(tx, branchId, day, indexes.length);
          indexes.forEach((at, k) => (tickets![at] = issued[k]));
        }
      }

      const out: CreatedBooking[] = [];

      for (const [i, guest] of guests.entries()) {
        const promoShare = promoShares[i];
        const rewardShare = rewardShares[i];
        // Every discount lands in one column: what this guest was let off, in
        // total. `promo_code_id` records which code produced part of it, and the
        // loyalty_txns row written below records the rest.
        const discountHalalas = split[i].discountHalalas + promoShare + rewardShare;
        // The treat is added after the discounts, never inside them.
        const totalHalalas =
          split[i].totalHalalas - promoShare - rewardShare + guest.treatHalalas;
        // Prices are VAT-inclusive, so VAT comes back out of the discounted total
        // rather than being added on. The customer pays exactly what was shown.
        const vat = vatIncludedIn(totalHalalas, settings.vat_percent);

        const [row] = await tx
          .insert(bookings)
          .values({
            code: makeCode(),
            branchId: placements[i].branchId,
            customerId: customer.id,
            stationId: stationIds[i],
            technicianId: input.technicianId ?? null,
            serviceId: guest.service.id,
            removalTypeId: guest.removal?.id ?? null,
            designId: guest.design?.id ?? null,
            startsAt: placements[i].startsAt,
            endsAt: endsAtPer[i],
            status,
            source: input.source,
            groupId,
            ticketNo: tickets?.[i] ?? null,
            // Who this chair is for, as given now. A named guest wins; anyone
            // else is the person who booked. The customer row's name is
            // overwritten by every later booking; this one is not.
            customerName: guest.member.guestName?.trim() || customer.name || null,
            // Snapshotted here and never joined live afterwards: raising a price
            // must not rewrite what this customer was charged.
            serviceName: guest.service.name as Localized,
            servicePriceHalalas: guest.servicePriceHalalas,
            refillOfBookingId: refillParent?.id ?? null,
            removalPriceHalalas: guest.removal?.priceHalalas ?? 0,
            discountHalalas,
            promoCodeId,
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

        // Inside the transaction, against the row just written: a booking that
        // fails cannot spend a credit, and a credit that fails to record cannot
        // leave a free booking behind. The partial unique index on
        // (booking_id, service_id) refuses a second one for the same booking.
        if (guest.packCredit) {
          await spendPackCredit(
            tx,
            guest.packCredit.customerPackId,
            guest.packCredit.serviceId,
            row.id,
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

      // Debit the wallet inside the same transaction, tied to the first booking
      // on the bill — so a group is one debit, not two.
      //
      // At hold time, not at confirmation. That looks inconsistent with the
      // promo count, which waits for the charge to clear, and it is deliberate:
      // a promo code is a shared coupon, but points are a per-customer balance,
      // and deferring the debit would let one customer hold several bookings in
      // several tabs each claiming the same balance and confirm them all. The
      // row lock taken on the customer above is what serialises this.
      //
      // Nothing gives the points *back* — nothing needs to. The balance query
      // in lib/loyalty.ts ignores rows whose booking is cancelled or is a hold
      // gone stale, so an abandoned checkout, a declined payment and a
      // cancellation each release them with no compensating write.
      if (input.customerId && pointsSpent > 0) {
        await spendPoints(tx, customer.id, out[0].id, pointsSpent);
      }

      return out;
    });

    return { ok: true, groupId, totalHalalas: billTotal, bookings: created, pointsSpent };
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

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, input.id)).limit(1);
  if (!booking) return { ok: false, error: "not-found" };

  // This booking, and only this booking, even when it belongs to a group.
  //
  // It used to move the whole party, which was right while a group meant one
  // branch at one moment: moving your appointment moved your friend's, because
  // they were the same appointment. Guests hold their own branch and hour now,
  // so dragging the rest of the party to a time nobody asked for is no longer a
  // convenience, it is a booking they did not make. The reference the customer
  // quoted is the chair that moves.
  //
  // The party is not held to one day after the fact. Same-day is a rule about
  // booking together (see createBookings); plans change afterwards, and nothing
  // downstream depends on it — cancellation fans out over group_id, and tickets
  // are per branch per day on each row.
  const duration = booking.endsAt.getTime() - booking.startsAt.getTime();
  const endsAt = new Date(input.startsAt.getTime() + duration);

  try {
    const moved = await db.transaction(async (tx) => {
      // Claim and move in one transaction, so nobody can take the target chair
      // between the check and the update. Its own chair is fair game — hence the
      // ignore id, or a booking would see itself as the conflict.
      const stationIds = await reserveStations(
        tx,
        booking.branchId,
        input.startsAt,
        endsAt,
        1,
        { ignoreBookingIds: [booking.id] },
      );
      if (!stationIds) return null;

      {
        await tx
          .update(bookings)
          .set({
            startsAt: input.startsAt,
            endsAt,
            stationId: stationIds[0],
            // The technician was free at the old time; at the new one she may
            // already have someone. Emptying the row hands the booking back to
            // the automation below, which is the only thing that checks. Keeping
            // a name that is now double-booked would look like a decision and be
            // a clash.
            technicianId: null,
            updatedAt: new Date(),
          })
          .where(eq(bookings.id, booking.id));
      }

      return stationIds;
    });

    if (!moved) return { ok: false, error: "slot-taken" };

    // Re-staffed straight away when the move lands on today. A move to a later
    // day deliberately stays empty until that morning's run, which is the only
    // one that can see who will be in.
    await assignIfToday(booking.branchId, input.startsAt);

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

  const settings = await getSettings(["refill_price_halalas"]);

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

  const servicePriceSar = halalasToSar(settings.refill_price_halalas);

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
