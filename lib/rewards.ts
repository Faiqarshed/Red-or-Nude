// The loyalty rules (brief §2.8): the milestones, the maths, and the one rule
// that decides whether a point still counts.
//
// Pure and dependency-free, split from lib/loyalty.ts the way lib/cancellation.ts
// is split from its lookups. Two reasons, and both are load-bearing:
//
//   • **No `server-only`.** The checkout and the profile screen both render the
//     rules, and both are client components. Without this split the constants
//     have to be threaded down as props from a server page through three
//     components and echoed back out of an API response.
//   • It is testable without a database — scripts/check-loyalty.ts asserts these
//     functions directly, and they are the same ones the checkout preview and
//     the booking write call.
//
// Points are whole numbers. Money is halalas — see the header of lib/db/schema.ts.

/**
 * What the salon gives and what it costs, all four numbers in one place.
 *
 * These live in `settings` rather than here (see SETTING_DEFAULTS) because the
 * salon retunes them without a deploy, and every function below takes them as an
 * argument rather than reading a module constant. That is what lets the checkout
 * price a reward in the browser with the same function the booking write uses on
 * the server, the row read once and passed down.
 */
export type LoyaltyRules = {
  /** Spend that earns the first award, in riyals. 199. */
  firstSar: number;
  /** Every further award costs this much more spend, in riyals. 200. */
  stepSar: number;
  /** Points granted at each milestone. 50. */
  stepPoints: number;
  /** What one point is worth, in halalas. 20 — so 50 points is 10.00 SAR. */
  pointHalalas: number;
};

/**
 * How many milestones a single bill reaches.
 *
 * **Milestones, not a rate.** The salon's rule is "199 riyals earns 50 points,
 * and every 200 after that earns 50 more", so the thresholds land at 199, 399,
 * 599 … and a bill *between* two of them earns what the lower one earned. A 350
 * SAR bill is worth 50 points, not 87, because it has not reached 399.
 *
 * This deliberately replaces the linear one-point-per-N-riyals rate that was
 * here before. A milestone is something a customer can be told — "you are 49
 * riyals from your next reward" — in a way a rate is not.
 *
 * **Per bill, not per lifetime.** A group is one bill and earns once, tied to
 * the anchor booking; see lib/payments/confirm.ts.
 *
 * ponytail: per-bill accrual means two 199 SAR visits earn 100 points where one
 * 398 SAR visit earns 50. Accepted — splitting costs the customer a second
 * appointment in a real chair. Move to lifetime accrual (milestones over total
 * paid, minus points already granted) if the salon ever sees bookings split to
 * farm points. That needs a join through `bookings`, since `payments` carries no
 * customer_id, and a decision about whose spend a group bill counts toward.
 */
export function milestonesReached(totalHalalas: number, rules: LoyaltyRules): number {
  const { firstSar, stepSar } = rules;
  if (totalHalalas <= 0 || firstSar <= 0 || stepSar <= 0) return 0;

  const first = firstSar * 100;
  const step = stepSar * 100;
  if (totalHalalas < first) return 0;
  return Math.floor((totalHalalas - first) / step) + 1;
}

/**
 * What a paid bill earns.
 *
 * Always a whole number: points are an integer column, an integer balance and an
 * integer on screen, and a fractional point has nowhere to live. Milestones are
 * counted first and multiplied second, so there is no division left to round.
 *
 * Called with what the customer *paid*, not what the bill was before discounts —
 * earning on the pre-discount figure would make a discount partly pay for itself.
 */
export function pointsEarned(totalHalalas: number, rules: LoyaltyRules): number {
  return milestonesReached(totalHalalas, rules) * Math.max(0, Math.trunc(rules.stepPoints));
}

/**
 * Spend still needed to reach the next milestone, in halalas.
 *
 * For the line on the account page that says how far off she is. With nothing
 * reached yet this is the distance to the *first* milestone, so the screen has
 * something to say to a new customer rather than a bar at zero with no target.
 */
export function toNextMilestone(totalHalalas: number, rules: LoyaltyRules): number {
  const { firstSar, stepSar } = rules;
  if (firstSar <= 0 || stepSar <= 0) return 0;

  const first = firstSar * 100;
  const step = stepSar * 100;
  const spent = Math.max(0, totalHalalas);
  if (spent < first) return first - spent;
  return step - ((spent - first) % step);
}

// ------------------------------------------------------------ redemption ---

/** What `points` are worth off a bill, in halalas, before any cap. */
export function pointsValue(points: number, rules: LoyaltyRules): number {
  if (points <= 0) return 0;
  return Math.trunc(points) * Math.max(0, Math.trunc(rules.pointHalalas));
}

export type RewardRefusal =
  /** Not a positive whole multiple of the step. Also what a hand-edited request looks like. */
  | "unknown"
  /** A real amount, but this balance cannot reach it. */
  | "locked";

/**
 * Why this many points cannot be spent, or `null` if they can.
 *
 * Named reasons rather than a bare false, for the same reason promoRefusal has
 * them: "you need 50 more points for that" sends the customer somewhere useful
 * and "invalid" sends her nowhere.
 *
 * Redemption is in whole steps — 50, 100, 150 — rather than any number she
 * likes. It keeps the offer describable ("50 points is 10 riyals off"), and it
 * means a stray 37 from a hand-edited request is refused rather than priced.
 */
export function rewardRefusal(
  points: number,
  balance: number,
  rules: LoyaltyRules,
): RewardRefusal | null {
  const step = Math.trunc(rules.stepPoints);
  if (step <= 0) return "unknown";
  if (!Number.isInteger(points) || points <= 0 || points % step !== 0) return "unknown";
  if (balance < points) return "locked";
  return null;
}

/**
 * What spending `points` takes off this bill.
 *
 * Capped at the total on purpose, exactly as promoDiscount is: a discount larger
 * than the bill is a refund, and a reward must never be able to hand out money
 * that was never taken. See redeemable(), which is what stops the checkout
 * offering an amount she would lose the change on.
 */
export function rewardDiscount(
  points: number,
  totalHalalas: number,
  rules: LoyaltyRules,
): number {
  if (totalHalalas <= 0) return 0;
  return Math.max(0, Math.min(pointsValue(points, rules), totalHalalas));
}

/**
 * The amounts worth offering against this bill, smallest first.
 *
 * Bounded by her balance and by the bill, because offering 150 points against a
 * 20 riyal bill is offering to burn 30 riyals of reward for 20 riyals off. The
 * last entry may still overshoot a little — the step that first *covers* the
 * bill is worth showing, the ones past it are not.
 */
export function redeemable(balance: number, totalHalalas: number, rules: LoyaltyRules): number[] {
  const step = Math.trunc(rules.stepPoints);
  if (step <= 0 || balance < step || totalHalalas <= 0) return [];

  const out: number[] = [];
  for (let points = step; points <= balance; points += step) {
    out.push(points);
    if (pointsValue(points, rules) >= totalHalalas) break;
  }
  return out;
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
