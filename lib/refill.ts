// The refill window rule. One function, two callers: the booking history uses it
// to decide whether to show the button and what countdown to print, and
// lib/bookings.ts uses it to decide whether to accept the booking.
//
// Deliberately pure and dependency-free — no database, no `server-only` — so the
// customer's screen and the server can never disagree about whether a window is
// still open. A rule copied into a UI is a rule that drifts.

export type RefillState = {
  eligible: boolean;
  /** Whole days left in the window, 0 once it has lapsed. */
  daysLeft: number;
};

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
};

const DAY_MS = 86_400_000;

export function refillState(b: RefillInput, now: Date = new Date()): RefillState {
  // A service with no window, one already used, or a refill of its own, is
  // simply not offered.
  if (b.refillDays <= 0 || b.alreadyRefilled || b.isRefill) {
    return { eligible: false, daysLeft: 0 };
  }

  // You cannot refill something that has not happened yet. `completed` is the
  // salon pressing End; `confirmed` in the past covers the common case of staff
  // not getting round to it — the customer sat in the chair either way.
  const served =
    b.status === "completed" || (b.status === "confirmed" && b.startsAt.getTime() <= now.getTime());
  if (!served) return { eligible: false, daysLeft: 0 };

  const expiresAt = b.startsAt.getTime() + b.refillDays * DAY_MS;
  const msLeft = expiresAt - now.getTime();
  if (msLeft <= 0) return { eligible: false, daysLeft: 0 };

  // Rounded up, so the last partial day still reads "1 day left" rather than 0.
  return { eligible: true, daysLeft: Math.ceil(msLeft / DAY_MS) };
}

/** What a refill costs: the service price less the salon's refill discount. */
export function refillPriceHalalas(servicePriceHalalas: number, discountPercent: number): number {
  const pct = Math.min(Math.max(discountPercent, 0), 100);
  return servicePriceHalalas - Math.round((servicePriceHalalas * pct) / 100);
}
