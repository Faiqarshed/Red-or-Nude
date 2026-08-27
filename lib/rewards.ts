// The loyalty rules (brief §2.8): the ladder, the maths, and the one rule that
// decides whether a point still counts.
//
// Pure and dependency-free, split from lib/loyalty.ts the way lib/cancellation.ts
// is split from its lookups. Two reasons, and both are load-bearing:
//
//   • **No `server-only`.** The checkout and the profile screen both render the
//     ladder, and both are client components. Without this split the constant
//     has to be threaded down as a prop from a server page through three
//     components and echoed back out of an API response.
//   • It is testable without a database — scripts/check-loyalty.ts asserts these
//     functions directly, and they are the same ones the checkout preview and
//     the booking write call.
//
// Points are whole numbers. Money is halalas — see the header of lib/db/schema.ts.

export type Reward = { points: number; percent: number };

/**
 * What points buy. Spending is opt-in at checkout — a customer ticks one rung
 * or none, the way they type a discount code or don't.
 *
 * **Linear on purpose: every 100 points is another 5% off.**
 *
 * The first cut of this ladder was 100 / 250 / 500 for 5 / 10 / 15%, which
 * quietly punished loyalty. Value per point is `percent ÷ points`, so those
 * rungs ran 0.050, 0.040, 0.033 — the dearest reward was the *worst* deal, and
 * a customer who saved up for it was worse off than one who spent at the bottom
 * rung three times. A ladder should never make climbing it the losing move.
 *
 * ponytail: a module constant, not a settings row. `settings.value` is jsonb so
 * a ladder would fit, but SETTING_DEFAULTS is a flat map of primitives and this
 * changes about as often as the price list does. Move it if marketing ever
 * wants to retune the rungs without a deploy.
 */
export const REWARDS: readonly Reward[] = [
  { points: 100, percent: 5 },
  { points: 200, percent: 10 },
  { points: 300, percent: 15 },
] as const;

/** The rung costing exactly this many points, or null if there is no such rung. */
export function rewardFor(points: number): Reward | null {
  return REWARDS.find((r) => r.points === points) ?? null;
}

export type RewardRefusal =
  /** No rung costs that many points. Also what a hand-edited request looks like. */
  | "unknown"
  /** A real rung, but this balance can't reach it yet. */
  | "locked";

/**
 * Why this rung can't be spent, or `null` if it can.
 *
 * Named reasons rather than a bare false, for the same reason promoRefusal has
 * them: "you need 200 points for that" sends the customer somewhere useful and
 * "invalid" sends them nowhere.
 */
export function rewardRefusal(points: number, balance: number): RewardRefusal | null {
  const reward = rewardFor(points);
  if (!reward) return "unknown";
  if (balance < reward.points) return "locked";
  return null;
}

/**
 * What a rung takes off this bill.
 *
 * Capped at the total on purpose, exactly as promoDiscount is: a discount larger
 * than the bill is a refund, and a reward must never be able to hand out money
 * that was never taken.
 */
export function rewardDiscount(reward: Reward, totalHalalas: number): number {
  if (totalHalalas <= 0) return 0;
  const raw = Math.round((totalHalalas * reward.percent) / 100);
  return Math.max(0, Math.min(raw, totalHalalas));
}

/**
 * What a paid bill earns: one point per `sarPerPoint` riyals actually paid.
 *
 * Two properties this must never lose:
 *
 * **The result is always a whole number.** Points are an integer column, an
 * integer balance and an integer on screen; a fractional point has nowhere to
 * live and would be rounded into existence or out of it somewhere downstream.
 * The floor here is the only place that is decided.
 *
 * **Floored, never rounded.** At one point per 5 SAR, a 9.99 SAR bill earns 1,
 * not 2. Rounding up lets a customer mint a point by splitting a bill, and
 * points are money.
 *
 * Note it is called with what the customer *paid*, not what the bill was before
 * discounts — earning on the pre-discount figure would make a discount partly
 * pay for itself.
 */
export function pointsEarned(totalHalalas: number, sarPerPoint: number): number {
  if (totalHalalas <= 0 || sarPerPoint <= 0) return 0;
  // One division, then floor. `100 * sarPerPoint` is halalas-per-point, so
  // there is no intermediate riyal figure to carry a fraction.
  return Math.floor(totalHalalas / (100 * sarPerPoint));
}

// ------------------------------------------------------------ the balance ---

/** One ledger row, reduced to what the liveness rule needs. */
export type LedgerRow = {
  deltaPoints: number;
  /** Null when the movement belongs to no booking. */
  bookingStatus: string | null;
  bookingCreatedAt: Date | null;
};

/**
 * A booking whose points should no longer count.
 *
 * Two ways that happens, and both matter:
 *
 *   • it was cancelled or nobody turned up — a customer cancellation, or a hold
 *     the sweep already collected;
 *   • it is *still* pending well past the window it had to be paid for — a
 *     declined payment the customer walked away from, or a gateway that threw.
 *
 * The second clause is the one that is easy to miss. A declined payment
 * deliberately leaves its bookings `pending` so the customer can retry without
 * re-picking a slot (lib/payments/confirm.ts), and sweepExpiredHolds only runs
 * when some *other* customer tries to book (lib/bookings.ts). Without a clock
 * here, points spent on a declined payment would stay locked until an unrelated
 * stranger happened to book at the same branch. Never make the balance depend
 * on the sweep having run.
 *
 * A retry inside the window keeps its discount and its debit — same booking,
 * same row. That is correct, not a leak.
 */
function isDead(row: LedgerRow, holdMin: number, now: Date): boolean {
  const { bookingStatus: status, bookingCreatedAt: createdAt } = row;
  if (status === null) return false; // not attached to a booking at all
  if (status === "cancelled" || status === "no_show") return true;
  if (status !== "pending") return false;
  // No created_at shouldn't happen. Treated as dead rather than alive: the
  // failure mode of guessing wrong is a customer who cannot spend points they
  // own, and that is the worse of the two.
  if (!createdAt) return true;
  return now.getTime() - createdAt.getTime() > holdMin * 60_000;
}

/**
 * The spendable balance. **This is the whole rule, and the only copy of it** —
 * loyaltyBalance() in lib/loyalty.ts reads the rows and hands them straight
 * here, so there is no SQL version to drift out of step with.
 *
 * scripts/check-loyalty.ts asserts it against every way a booking can die.
 */
export function spendableBalance(
  rows: LedgerRow[],
  holdMin: number,
  now: Date = new Date(),
): number {
  return rows.reduce((sum, r) => (isDead(r, holdMin, now) ? sum : sum + r.deltaPoints), 0);
}
