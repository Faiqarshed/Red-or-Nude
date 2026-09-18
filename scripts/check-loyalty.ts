// Loyalty maths, the milestone rule, and — above all — the rule that gives
// points back (brief §2.8).
//
//   npm run check:loyalty
//
// No database and no network: everything asserted here is a pure function from
// lib/loyalty.ts, and they are the same functions the checkout preview, the
// booking write and the profile screen all call. These are the rules
// themselves, not a mock of them.
//
// The balance section is the one that matters. A customer who redeems points
// and then cancels — or whose card is declined — must get them back, and the
// design has *no code that returns them*: the balance query simply stops
// counting a redemption whose booking died. That is only safe if every way a
// booking can die is covered, so every way is asserted below.

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import assert from "node:assert";
import {
  milestonesReached,
  pointsEarned,
  pointsValue,
  redeemable,
  rewardDiscount,
  rewardRefusal,
  spendableBalance,
  toNextMilestone,
  type LedgerRow,
  type LoyaltyRules,
} from "@/lib/rewards";

const HOLD_MIN = 15; // matches SETTING_DEFAULTS.booking_hold_min
const NOW = new Date("2026-09-23T12:00:00.000Z");

const minsAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

// -- the scheme's own numbers -------------------------------------------------
//
// Matching SETTING_DEFAULTS, so every assertion below reads as the rule the
// salon actually stated: spend 199, get 50 points, worth 10 riyals; 50 more
// every 200 after that.

const RULES: LoyaltyRules = {
  firstSar: 199,
  stepSar: 200,
  stepPoints: 50,
  pointHalalas: 20,
};

const sar = (n: number) => Math.round(n * 100);

// -- earning ------------------------------------------------------------------
//
// Milestones, not a rate. A bill between two thresholds earns what the lower
// one earned — which is the client's own example: 350 riyals is still 50
// points, because it has not reached 399.

assert.strictEqual(pointsEarned(sar(199), RULES), 50, "199 SAR earns the first 50");
assert.strictEqual(pointsEarned(sar(350), RULES), 50, "350 SAR has not reached 399, so still 50");
assert.strictEqual(pointsEarned(sar(399), RULES), 100, "399 SAR reaches the second milestone");
assert.strictEqual(pointsEarned(sar(599), RULES), 150, "and every 200 after that");

// The boundaries, to the halala.
assert.strictEqual(pointsEarned(sar(198.99), RULES), 0, "a halala short of 199 earns nothing");
assert.strictEqual(pointsEarned(sar(199) - 1, RULES), 0, "still nothing one halala below");
assert.strictEqual(pointsEarned(sar(398.99), RULES), 50, "a halala short of 399 is still one award");
assert.strictEqual(pointsEarned(sar(399) - 1, RULES), 50, "the threshold is exact");

assert.strictEqual(pointsEarned(0, RULES), 0, "a free booking earns nothing");
assert.strictEqual(pointsEarned(-100, RULES), 0, "a negative total cannot earn");
assert.strictEqual(milestonesReached(sar(1000), RULES), 5, "1000 SAR is five milestones");

// A zeroed setting must not divide by zero or mint infinite points.
assert.strictEqual(pointsEarned(sar(500), { ...RULES, stepSar: 0 }), 0, "a zero step earns nothing");
assert.strictEqual(pointsEarned(sar(500), { ...RULES, firstSar: 0 }), 0, "a zero first earns nothing");

// Whole and non-negative, always — points are an integer column.
for (const amount of [0, 1, 99, sar(198.99), sar(199), sar(1234.56), 9_999_999]) {
  const earnedPoints = pointsEarned(amount, RULES);
  assert.ok(
    Number.isInteger(earnedPoints) && earnedPoints >= 0,
    `pointsEarned(${amount}) must be a whole non-negative number, got ${earnedPoints}`,
  );
}

// -- how far to the next one --------------------------------------------------
//
// The line on the account page. A new customer must be told a target rather
// than shown a bar at zero with nothing to reach.

assert.strictEqual(toNextMilestone(0, RULES), sar(199), "from nothing, the first is 199 away");
assert.strictEqual(toNextMilestone(sar(100), RULES), sar(99), "99 riyals to go at 100 spent");
assert.strictEqual(toNextMilestone(sar(199), RULES), sar(200), "on a threshold, the next is a full step");
assert.strictEqual(toNextMilestone(sar(350), RULES), sar(49), "49 riyals from 399");

// -- spending -----------------------------------------------------------------
//
// rewardRefusal is the function the checkout and the booking write both call,
// so a rule asserted here is a rule enforced in both places.

assert.strictEqual(pointsValue(50, RULES), sar(10), "50 points is 10 riyals");
assert.strictEqual(pointsValue(0, RULES), 0, "no points are worth nothing");
assert.strictEqual(pointsValue(-50, RULES), 0, "a negative cannot be worth anything");

assert.strictEqual(rewardRefusal(50, 50, RULES), null, "exactly enough is enough");
assert.strictEqual(rewardRefusal(50, 49, RULES), "locked", "one point short is refused");
assert.strictEqual(rewardRefusal(37, 9999, RULES), "unknown", "not a whole step");
assert.strictEqual(rewardRefusal(0, 9999, RULES), "unknown", "zero is not an amount");
assert.strictEqual(rewardRefusal(-50, 9999, RULES), "unknown", "a negative amount is refused");
assert.strictEqual(rewardRefusal(50.5, 9999, RULES), "unknown", "a fraction of a point is refused");

// -- the discount, and its cap ------------------------------------------------

assert.strictEqual(rewardDiscount(50, sar(200), RULES), sar(10), "50 points takes 10 riyals off");
assert.strictEqual(rewardDiscount(100, sar(200), RULES), sar(20), "100 points takes 20 off");
assert.strictEqual(rewardDiscount(50, 0, RULES), 0, "nothing off nothing");
assert.strictEqual(rewardDiscount(50, -500, RULES), 0, "a negative bill discounts nothing");
// A reward larger than the bill must never hand back money that was never taken.
assert.strictEqual(rewardDiscount(100, sar(5), RULES), sar(5), "a discount is capped at the bill");

// -- what the checkout offers -------------------------------------------------

assert.deepStrictEqual(redeemable(49, sar(500), RULES), [], "below one step, nothing is offered");
assert.deepStrictEqual(redeemable(500, 0, RULES), [], "no bill, nothing to spend against");
assert.deepStrictEqual(redeemable(100, sar(500), RULES), [50, 100], "bounded by the balance");
assert.deepStrictEqual(
  redeemable(500, sar(10), RULES),
  [50],
  "and by the bill — offering more would burn reward for no extra discount",
);

// -- the balance, and every way a booking can die ----------------------------
//
// This is the load-bearing section. Each case below is a way a customer's
// points must come back with no compensating write anywhere.

const earned = (n: number, status: string | null, createdAt: Date | null = NOW): LedgerRow => ({
  deltaPoints: n,
  bookingStatus: status,
  bookingCreatedAt: createdAt,
});

// The ordinary case: earned on a completed booking, spent on a confirmed one.
assert.strictEqual(
  spendableBalance([earned(300, "completed"), earned(-100, "confirmed")], HOLD_MIN, NOW),
  200,
  "earning then spending leaves the difference",
);

// 1. The customer cancels the booking they spent points on → points return.
assert.strictEqual(
  spendableBalance([earned(300, "completed"), earned(-100, "cancelled")], HOLD_MIN, NOW),
  300,
  "cancelling a booking returns the points it spent",
);

// 2. An abandoned hold the sweep already collected → same rule, same clause.
assert.strictEqual(
  spendableBalance([earned(300, "completed"), earned(-250, "cancelled", minsAgo(90))], HOLD_MIN, NOW),
  300,
  "a swept hold returns its points",
);

// 3. A payment declined and the customer walked away. The booking is still
//    `pending` — deliberately, so a retry keeps its slot — and no sweep has
//    run. The clock, not the status, is what frees the points here.
assert.strictEqual(
  spendableBalance([earned(300, "completed"), earned(-250, "pending", minsAgo(16))], HOLD_MIN, NOW),
  300,
  "a pending hold past its window returns its points without the sweep running",
);

// 4. ...but a live hold still holds them. A customer retrying a declined card
//    two minutes later must keep the discount they were quoted.
assert.strictEqual(
  spendableBalance([earned(300, "completed"), earned(-250, "pending", minsAgo(2))], HOLD_MIN, NOW),
  50,
  "a hold inside its window keeps its points spent, so a retry keeps its price",
);

// The boundary itself, from both sides.
assert.strictEqual(
  spendableBalance([earned(-100, "pending", minsAgo(15))], HOLD_MIN, NOW),
  -100,
  "exactly at the window the hold is still live",
);
assert.strictEqual(
  spendableBalance([earned(-100, "pending", minsAgo(16))], HOLD_MIN, NOW),
  0,
  "one minute past the window it is not",
);

// 5. Nobody turned up to a paid booking → its points are revoked.
assert.strictEqual(
  spendableBalance([earned(300, "no_show")], HOLD_MIN, NOW),
  0,
  "a no-show earns nothing",
);

// 6. A confirmed booking cancelled later → the points it earned go with it.
assert.strictEqual(
  spendableBalance([earned(300, "cancelled")], HOLD_MIN, NOW),
  0,
  "cancelling a paid booking revokes what it earned",
);

// A movement attached to no booking (a manual adjustment) always counts —
// there is no booking whose death could take it away.
assert.strictEqual(
  spendableBalance([earned(500, null, null)], HOLD_MIN, NOW),
  500,
  "a movement with no booking always counts",
);

// Every live status counts. Written as a loop so a new status added to the
// enum without a thought here fails loudly rather than silently voiding points.
for (const status of ["confirmed", "checked_in", "in_progress", "completed"]) {
  assert.strictEqual(
    spendableBalance([earned(100, status)], HOLD_MIN, NOW),
    100,
    `${status} is a live booking and its points count`,
  );
}

assert.strictEqual(spendableBalance([], HOLD_MIN, NOW), 0, "no ledger is a zero balance");

// -- the whole story, end to end ---------------------------------------------
//
// Earn 300 across past visits. Spend 200 — 40 riyals off — on a new booking.
// Card declines, customer walks. Twenty minutes later they are back where they
// started, with all 300 spendable again.
const story: LedgerRow[] = [
  earned(300, "completed"),
  earned(-200, "pending", minsAgo(20)),
];
assert.strictEqual(spendableBalance(story, HOLD_MIN, NOW), 300, "a declined payment costs nothing");
assert.strictEqual(
  rewardRefusal(300, spendableBalance(story, HOLD_MIN, NOW), RULES),
  null,
  "and the whole balance is spendable again",
);

console.log("check:loyalty — all assertions passed");
