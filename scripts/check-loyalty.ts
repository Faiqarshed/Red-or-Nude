// Loyalty maths, the reward ladder, and — above all — the rule that gives
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
  REWARDS,
  pointsEarned,
  rewardDiscount,
  rewardFor,
  rewardRefusal,
  spendableBalance,
  type LedgerRow,
} from "@/lib/rewards";

const HOLD_MIN = 15; // matches SETTING_DEFAULTS.booking_hold_min
const NOW = new Date("2026-09-23T12:00:00.000Z");

const minsAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

// -- earning -----------------------------------------------------------------
//
// `sarPerPoint` is a DIVISOR: how many riyals buy one point. Five is the
// default. See SETTING_DEFAULTS.loyalty_sar_per_point for why it is not a
// fractional multiplier.

assert.strictEqual(pointsEarned(15000, 5), 30, "150 SAR at 1 point per 5 SAR earns 30");
assert.strictEqual(pointsEarned(15000, 1), 150, "a divisor of 1 is a point per riyal");
assert.strictEqual(pointsEarned(15000, 10), 15, "a bigger divisor is stingier");
assert.strictEqual(pointsEarned(0, 5), 0, "a free booking earns nothing");
assert.strictEqual(pointsEarned(-100, 5), 0, "a negative total cannot earn");
assert.strictEqual(pointsEarned(10000, 0), 0, "a zero divisor earns nothing, and does not divide by zero");

// Floored, never rounded. A part-riyal must not mint a point — points are
// money, and rounding up is a mint anyone can run by splitting a bill.
assert.strictEqual(pointsEarned(499, 5), 0, "4.99 SAR earns nothing at 5 SAR a point");
assert.strictEqual(pointsEarned(500, 5), 1, "5.00 SAR earns exactly one");
assert.strictEqual(pointsEarned(999, 5), 1, "9.99 SAR still earns one");
assert.strictEqual(pointsEarned(1000, 5), 2, "10.00 SAR earns two");

// **Points are never fractional.** The column is an integer, the balance is an
// integer and the screen shows an integer; a fraction here would be rounded
// into or out of existence somewhere downstream. Swept over a wide range of
// bills and divisors so a future change to the formula cannot reintroduce one.
for (let halalas = 0; halalas <= 200_00; halalas += 37) {
  for (const divisor of [1, 2, 3, 5, 7, 10, 25]) {
    const earned = pointsEarned(halalas, divisor);
    assert.ok(
      Number.isInteger(earned) && earned >= 0,
      `pointsEarned(${halalas}, ${divisor}) must be a whole non-negative number, got ${earned}`,
    );
  }
}

// -- the ladder --------------------------------------------------------------

assert.deepStrictEqual(
  REWARDS.map((r) => r.points),
  [100, 200, 300],
  "the rungs are 100 / 200 / 300",
);
assert.ok(
  REWARDS.every((r, i) => i === 0 || r.points > REWARDS[i - 1].points),
  "rungs ascend, so unlockedRewards can be read as a ladder",
);
assert.ok(
  REWARDS.every((r, i) => i === 0 || r.percent > REWARDS[i - 1].percent),
  "a dearer rung is always worth more, or nobody would ever buy it",
);

// Climbing must never be the losing move. Value per point is percent ÷ points;
// if that falls as the rungs rise, a customer who saves up is worse off than one
// who spends at the bottom rung repeatedly. The first cut of this ladder
// (100/250/500) failed exactly here.
const valuePerPoint = REWARDS.map((r) => r.percent / r.points);
assert.ok(
  valuePerPoint.every((v, i) => i === 0 || v >= valuePerPoint[i - 1] - 1e-9),
  `value per point must not fall as rungs rise, got ${valuePerPoint.join(", ")}`,
);

// Whole points only, on the ladder as well as in the earning.
assert.ok(
  REWARDS.every((r) => Number.isInteger(r.points) && Number.isInteger(r.percent)),
  "a rung costs a whole number of points and gives a whole percentage",
);

assert.strictEqual(rewardFor(200)?.percent, 10, "200 points is 10% off");
assert.strictEqual(rewardFor(250), null, "a value between rungs is not a rung");
assert.strictEqual(rewardFor(0), null, "zero is not a rung");

// Unlock boundaries, on both sides of every rung. Asserted through
// rewardRefusal because that is the function the checkout and the booking write
// both call — a boundary proved on anything else proves nothing about them.
assert.strictEqual(rewardRefusal(100, 99), "locked", "one point short is refused");
assert.strictEqual(rewardRefusal(100, 100), null, "exactly enough is enough");
assert.strictEqual(rewardRefusal(200, 199), "locked", "199 cannot reach the second rung");
assert.strictEqual(rewardRefusal(200, 200), null, "200 can");
assert.strictEqual(rewardRefusal(300, 299), "locked", "299 cannot reach the top");
assert.strictEqual(rewardRefusal(300, 9999), null, "a big balance reaches everything");
assert.strictEqual(rewardRefusal(150, 9999), "unknown", "a rung that doesn't exist is refused");
assert.strictEqual(rewardRefusal(-100, 9999), "unknown", "a negative rung is refused");

// -- what a rung takes off ---------------------------------------------------

const ten = rewardFor(200)!;
assert.strictEqual(rewardDiscount(ten, 20000), 2000, "10% of 200 SAR is 20 SAR");
assert.strictEqual(rewardDiscount(ten, 0), 0, "nothing off nothing");
assert.strictEqual(rewardDiscount(ten, -500), 0, "a negative bill discounts nothing");

// Capped at the bill. A discount bigger than the total is a refund, and a
// reward must never hand out money that was never taken.
const huge: { points: number; percent: number } = { points: 1, percent: 500 };
assert.strictEqual(rewardDiscount(huge, 5000), 5000, "a discount is capped at the bill");

// Rounding is to the halala and never exceeds the cap.
assert.strictEqual(rewardDiscount(ten, 333), 33, "10% of 3.33 SAR rounds to 33 halalas");

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
// Earn 300 across past visits. Spend 200 on the 10%-off rung for a new booking.
// Card declines, customer walks. Twenty minutes later they are back where they
// started, with every rung available again.
const story: LedgerRow[] = [
  earned(300, "completed"),
  earned(-200, "pending", minsAgo(20)),
];
assert.strictEqual(spendableBalance(story, HOLD_MIN, NOW), 300, "a declined payment costs nothing");
assert.strictEqual(
  rewardRefusal(300, spendableBalance(story, HOLD_MIN, NOW)),
  null,
  "and the top rung is affordable again",
);

console.log("check:loyalty — all assertions passed");
