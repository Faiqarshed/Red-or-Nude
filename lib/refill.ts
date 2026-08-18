// The refill window rule. One function, two callers: the booking history uses it
// to decide whether to show the button and what countdown to print, and
// lib/bookings.ts uses it to decide whether to accept the booking.
//
// Deliberately pure and dependency-free — no database, no `server-only` — so the
// customer's screen and the server can never disagree about whether a window is
// still open. A rule copied into a UI is a rule that drifts.

export type RefillInput = {
  /** When the original appointment started. The window counts from here. */
  startsAt: Date;
  status: string;
  /** The service's window length. 0 means this service has no refill. */
  refillDays: number;
  /** Has this booking's window already been spent on a refill? */
  alreadyRefilled: boolean;
  /**
   * Is this booking itself a refill? A refill does not grant another one — the
   * customer books the full service again to start a fresh window. Without
   * this, a discounted booking every 30 days would mean never paying full
   * price. Flip this one condition if the salon wants refills to chain.
   */
  isRefill: boolean;
  /**
   * An admin-granted deadline (`bookings.refill_expires_at`), overriding the
   * window derived from `refillDays`.
   *
   * It can also *create* an offer where the service carries none, so a manager
   * can hand a refill to an unhappy customer on a service with `refillDays: 0`.
   * That is the whole point of granting it by hand — but it is still subject to
   * every other rule below: a cancelled booking, an unserved one, or one whose
   * window was already spent stays ineligible however generous the grant.
   */
  expiresAt?: Date | null;
};

const DAY_MS = 86_400_000;

/**
 * When the offer lapses — an admin grant if there is one, otherwise the
 * service's own window measured from the appointment. Null when the service
 * carries no window and nothing was granted.
 *
 * Exported because the deadline has two jobs, and they must not disagree:
 * deciding whether the offer is still open *today*, and deciding which
 * appointment dates a refill may be booked for. Computing that date in two
 * places is how a picker ends up offering slots the server then rejects.
 */
export function refillWindowEnd(b: RefillInput): Date | null {
  if (b.expiresAt) return b.expiresAt;
  if (b.refillDays > 0) return new Date(b.startsAt.getTime() + b.refillDays * DAY_MS);
  return null;
}

/**
 * Whole days left in the window. **Zero means no refill is on offer** — there is
 * no separate `eligible` flag, because a second field that can only ever say
 * `daysLeft > 0` is a second field to keep in sync.
 */
export function refillDaysLeft(b: RefillInput, now: Date = new Date()): number {
  // Already spent, or a refill of its own — nothing to offer, and no grant
  // overrides either: both mean this booking's one refill is gone or was never
  // its to give.
  if (b.alreadyRefilled || b.isRefill) return 0;

  // A service with no window is not offered unless someone granted one.
  if (b.refillDays <= 0 && !b.expiresAt) return 0;

  // You cannot refill something that has not happened yet. `completed` is the
  // salon pressing End; `confirmed` in the past covers the common case of staff
  // not getting round to it — the customer sat in the chair either way.
  const served =
    b.status === "completed" || (b.status === "confirmed" && b.startsAt.getTime() <= now.getTime());
  if (!served) return 0;

  // The grant replaces the derived deadline outright rather than extending it,
  // so shortening a window is possible too — and so an edit to the service's
  // refillDays can never move a deadline a customer was already told.
  const endsAt = refillWindowEnd(b);
  if (!endsAt) return 0;

  const msLeft = endsAt.getTime() - now.getTime();
  if (msLeft <= 0) return 0;

  // Rounded up, so the last partial day still reads "1 day left" rather than 0.
  return Math.ceil(msLeft / DAY_MS);
}

/** What a refill costs: the service price less the salon's refill discount. */
export function refillPriceHalalas(servicePriceHalalas: number, discountPercent: number): number {
  const pct = Math.min(Math.max(discountPercent, 0), 100);
  return servicePriceHalalas - Math.round((servicePriceHalalas * pct) / 100);
}
