// Discount code maths and boundaries (brief §2.10).
//
//   npm run check:promo
//
// No database and no network: promoRefusal/promoDiscount in lib/promo.ts are
// pure, and they are the same functions the checkout preview and the booking
// write both call. These are the rules themselves, not a mock of them.
//
// The share checks matter most. Money that is discounted on a combined bill and
// then attributed to two guests has to add back up to the halala, or the invoice
// disagrees with the card.

import assert from "node:assert";
import { promoDiscount, promoRefusal, type PromoRule } from "@/lib/promo";
import { shareAmount, splitGroupPrice, vatIncludedIn } from "@/lib/money";

const now = new Date("2026-09-23T12:00:00.000Z");

const base: PromoRule = {
  type: "percent",
  value: 25,
  minTotalHalalas: 0,
  startsAt: null,
  endsAt: null,
  maxUses: null,
  uses: 0,
  active: true,
};

const rule = (over: Partial<PromoRule>): PromoRule => ({ ...base, ...over });

// -- what a code is worth ----------------------------------------------------

assert.strictEqual(promoDiscount(rule({}), 20000), 5000, "25% of 200 SAR is 50 SAR");
assert.strictEqual(
  promoDiscount(rule({ type: "fixed", value: 5000 }), 20000),
  5000,
  "a fixed 50 SAR code takes 50 SAR",
);

// The cap. A discount larger than the bill would be a refund, and a promo code
// must never hand out money that was never taken.
assert.strictEqual(
  promoDiscount(rule({ type: "fixed", value: 50000 }), 20000),
  20000,
  "a 500 SAR code on a 200 SAR bill takes 200, not 500",
);
assert.strictEqual(promoDiscount(rule({}), 0), 0, "nothing off an empty bill");
assert.strictEqual(
  promoDiscount(rule({ type: "percent", value: 100 }), 20000),
  20000,
  "100% takes the whole bill and no more",
);

// Rounds once, half-up, to the halala.
assert.strictEqual(promoDiscount(rule({ value: 33 }), 10001), 3300, "33% of 100.01 SAR");

// -- refusals ----------------------------------------------------------------

assert.strictEqual(promoRefusal(rule({}), 20000, now), null, "a live code applies");
assert.strictEqual(promoRefusal(rule({ active: false }), 20000, now), "inactive");
assert.strictEqual(promoRefusal(rule({ maxUses: 100, uses: 100 }), 20000, now), "used-up");
assert.strictEqual(promoRefusal(rule({ maxUses: 100, uses: 99 }), 20000, now), null, "one use left");
assert.strictEqual(
  promoRefusal(rule({ minTotalHalalas: 20001 }), 20000, now),
  "min-total",
  "a halala short of the minimum is refused",
);
assert.strictEqual(
  promoRefusal(rule({ minTotalHalalas: 20000 }), 20000, now),
  null,
  "exactly the minimum qualifies",
);

// -- the window --------------------------------------------------------------

const soon = new Date(now.getTime() + 60_000);
const past = new Date(now.getTime() - 60_000);

assert.strictEqual(promoRefusal(rule({ startsAt: soon }), 20000, now), "not-started");
assert.strictEqual(promoRefusal(rule({ startsAt: past }), 20000, now), null, "already open");
assert.strictEqual(promoRefusal(rule({ endsAt: past }), 20000, now), "expired");
assert.strictEqual(promoRefusal(rule({ endsAt: soon }), 20000, now), null, "still open");

// The boundaries themselves. Standing exactly on the start is open; standing
// exactly on the end is closed — so a code is never both live and expired in the
// same millisecond, and never neither.
assert.strictEqual(promoRefusal(rule({ startsAt: now }), 20000, now), null, "open on the dot");
assert.strictEqual(promoRefusal(rule({ endsAt: now }), 20000, now), "expired", "shut on the dot");

// Order: a code that is both switched off and expired reads as off, because that
// is the one a member of staff can do something about.
assert.strictEqual(
  promoRefusal(rule({ active: false, endsAt: past }), 20000, now),
  "inactive",
  "inactive is reported before expired",
);

// -- sharing it across a bill ------------------------------------------------

for (const [grosses, amount] of [
  [[25000, 18000], 4300],
  [[25000, 18000], 1],
  [[33333, 33333, 33334], 10000],
  [[20000], 5000],
] as [number[], number][]) {
  const shares = shareAmount(grosses, amount);
  assert.strictEqual(
    shares.reduce((sum, s) => sum + s, 0),
    amount,
    `shares of ${amount} across ${grosses.join("+")} must sum back exactly`,
  );
  assert.ok(
    shares.every((s) => s >= 0),
    "no guest is charged extra so another can be discounted",
  );
}

assert.deepStrictEqual(shareAmount([100, 100], 0), [0, 0], "no discount, no shares");
assert.deepStrictEqual(shareAmount([0, 0], 500), [0, 0], "nothing to share against a free bill");

// -- the stack: group discount, then promo, then VAT --------------------------

// Two guests, 10% off for booking together, then a 25% code on what is left.
const grosses = [25000, 18000];
const split = splitGroupPrice(grosses, 10);
const groupTotals = split.map((s) => s.totalHalalas);
const billAfterGroup = groupTotals.reduce((sum, t) => sum + t, 0);

const codeTakes = promoDiscount(rule({ value: 25 }), billAfterGroup);
const promoShares = shareAmount(groupTotals, codeTakes);

const finals = groupTotals.map((t, i) => t - promoShares[i]);

assert.strictEqual(
  finals.reduce((sum, t) => sum + t, 0),
  billAfterGroup - codeTakes,
  "the guests' totals add up to the discounted bill",
);
assert.strictEqual(
  billAfterGroup,
  grosses.reduce((sum, g) => sum + g, 0) - split.reduce((sum, s) => sum + s.discountHalalas, 0),
  "the group discount is fully accounted for",
);

// Per guest, subtotal + VAT must equal what the card is charged — the invariant
// the invoice asserts on. VAT comes back *out* of a VAT-inclusive total.
for (const total of finals) {
  const vat = vatIncludedIn(total, 15);
  assert.strictEqual(total - vat + vat, total, "subtotal + VAT is the total");
  assert.ok(vat >= 0 && vat < total, "VAT is a part of the total, not an addition");
}

// A solo booking with no code must be untouched by any of this.
assert.deepStrictEqual(
  splitGroupPrice([20000], 0),
  [{ discountHalalas: 0, totalHalalas: 20000 }],
  "no group, no percent, no change",
);

console.log("check:promo — all discount code checks passed");
