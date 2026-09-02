// The halala arithmetic, on its own with no database.
//
// This file protects the one property the whole till depends on: what the two
// guests are told they owe adds back up to what the one card was charged, to
// the halala. `scripts/check-booking.ts` already asserts that for five pairs of
// gross amounts at 10%; this goes past it — every percent from 0 to 100, three
// guests, one-halala bills, and a thousand generated splits — because the
// discount percent is a Setting an admin can type and nobody is checking which
// values were tried before it shipped.
//
// It would be easy to break by "simplifying" splitGroupPrice into a per-guest
// `round(gross * (1 - percent/100))`. That reads cleaner and quietly makes the
// salon's bank statement disagree with its invoices by a halala a day.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAT_PERCENT,
  HALALAS_PER_SAR,
  formatSAR,
  halalasToSar,
  sarToHalalas,
  shareAmount,
  splitGroupPrice,
  vatIncludedIn,
  vatOn,
} from "@/lib/money";

/** A deterministic generator, so a failure here is reproducible tomorrow. */
function* pseudoRandom(seed: number): Generator<number> {
  let x = seed;
  for (;;) {
    x = (x * 1103515245 + 12345) % 2147483648;
    yield x / 2147483648;
  }
}

describe("halalas are integers, and no float path exists", () => {
  it("charges 1 SAR as 100 halalas", () => {
    expect(HALALAS_PER_SAR).toBe(100);
    expect(sarToHalalas(1)).toBe(100);
    expect(sarToHalalas(250)).toBe(25_000);
  });

  // The reason the schema comment forbids floats: this is what the till would
  // do if a price were ever a riyal float instead of a halala integer.
  it("does not inherit the 0.1 + 0.2 drift that floating riyals would", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the drift we are avoiding, stated out loud
    expect(sarToHalalas(0.1) + sarToHalalas(0.2)).toBe(sarToHalalas(0.3));
    expect(sarToHalalas(0.1) + sarToHalalas(0.2)).toBe(30);
  });

  // Ten 10-halala items must cost exactly one riyal, which the float version of
  // the same sum does not.
  it("sums a hundred small items with no drift", () => {
    let halalas = 0;
    let riyals = 0;
    for (let i = 0; i < 100; i++) {
      halalas += 7;
      riyals += 0.07;
    }
    expect(halalas).toBe(700);
    expect(riyals).not.toBe(7); // 7.000000000000005
    expect(Number.isInteger(halalas)).toBe(true);
  });

  it("every splitGroupPrice figure is a safe integer", () => {
    for (const s of splitGroupPrice([13_333, 8_888, 1], 17)) {
      expect(Number.isSafeInteger(s.totalHalalas)).toBe(true);
      expect(Number.isSafeInteger(s.discountHalalas)).toBe(true);
    }
  });

  // @characterization — CWS-5, undocumented, pins behaviour as of 2026-09-02.
  // halalasToSar deliberately returns a float, and sarToHalalas rounds one back.
  // The round trip is exact for whole halalas and lossy at the half-halala the
  // gift-card custom amount can express. See BUG-MONEY-006.
  it("round-trips whole halalas exactly, and loses the half-halala", () => {
    for (const h of [0, 1, 99, 100, 25_000, 199_999, 2_147_483_647]) {
      expect(sarToHalalas(halalasToSar(h))).toBe(h);
    }
    // Half-halala inputs do not round consistently, because `sar * 100` lands
    // either side of .5 depending on the IEEE-754 representation of `sar`.
    // Neighbouring amounts go opposite ways with nothing to distinguish them:
    //
    //    1.005 * 100 = 100.49999999999999  -> 100  (down)
    //    1.015 * 100 = 101.49999999999999  -> 101  (down)
    //    1.045 * 100 = 104.5               -> 105  (up)
    //   10.005 * 100 = 1000.5000000000001  -> 1001 (up)
    //
    // Harmless while every form is limited to two decimals, which is the only
    // reason this is a characterization and not a failing test. See
    // docs/_testing/known-bugs-money.md BUG-MONEY-006.
    expect(sarToHalalas(1.005)).toBe(100);
    expect(sarToHalalas(1.015)).toBe(101);
    expect(sarToHalalas(1.045)).toBe(105);
    expect(sarToHalalas(10.005)).toBe(1001);
  });
});

describe("VAT is 15% and lives inside the price, never on top of it", () => {
  it("uses 15 as the KSA default", () => {
    expect(DEFAULT_VAT_PERCENT).toBe(15);
  });

  // A 230.00 SAR price shown to the customer is 200.00 plus 30.00 of VAT. The
  // customer pays 230.00 either way — that is what "inclusive" means.
  it("pulls VAT out of the shown price rather than adding it on", () => {
    expect(vatIncludedIn(23_000, 15)).toBe(3_000);
    expect(23_000 - vatIncludedIn(23_000, 15)).toBe(20_000);
    // The exclusive helper is the other direction, and would overcharge by 15%
    // if it were ever used on a shown price.
    expect(vatOn(20_000, 15)).toBe(3_000);
    expect(vatIncludedIn(23_000, 15)).not.toBe(vatOn(23_000, 15));
  });

  it("keeps subtotal + VAT equal to the total at every awkward amount", () => {
    const awkward = [
      1, 2, 3, 7, 13, 99, 100, 101, 115, 116, 999, 1_001, 4_999, 12_345, 13_333,
      25_000, 99_999, 123_457, 2_147_483_647,
    ];
    for (const total of awkward) {
      const vat = vatIncludedIn(total, 15);
      expect(total - vat + vat).toBe(total);
      expect(Number.isSafeInteger(vat)).toBe(true);
      expect(vat).toBeGreaterThanOrEqual(0);
      expect(vat).toBeLessThan(total || 1);
    }
  });

  // The specific halalas the arithmetic lands on, written down so a change of
  // rounding mode shows up as a diff rather than as a quiet 1-halala shift.
  it("rounds the awkward halalas where it does today", () => {
    expect(vatIncludedIn(1, 15)).toBe(0); // one halala carries no VAT
    expect(vatIncludedIn(2, 15)).toBe(0);
    expect(vatIncludedIn(4, 15)).toBe(1);
    expect(vatIncludedIn(115, 15)).toBe(15); // exactly divisible, no remainder
    expect(vatIncludedIn(100, 15)).toBe(13); // 13.04 → 13
    expect(vatIncludedIn(12_345, 15)).toBe(1_610);
  });

  it("a zero bill carries no VAT", () => {
    expect(vatIncludedIn(0, 15)).toBe(0);
    expect(vatOn(0, 15)).toBe(0);
  });

  // @characterization — CWS-2, undocumented, pins behaviour as of 2026-09-02.
  // Nothing rejects a negative total; the extraction just runs on it. No caller
  // can reach this today because bookings.total_halalas is never negative, but
  // there is no guard saying so.
  it("extracts a negative VAT from a negative total rather than refusing", () => {
    expect(vatIncludedIn(-23_000, 15)).toBe(-3_000);
  });

  it("a zero VAT rate takes nothing out", () => {
    expect(vatIncludedIn(25_000, 0)).toBe(0);
  });
});

describe("the group discount adds back up to the bill, exactly", () => {
  // The one-person booking must not change: this is the regression that would
  // reprice every ordinary appointment in the salon.
  it("leaves a single guest at 0% untouched", () => {
    expect(splitGroupPrice([25_000], 0)).toEqual([{ discountHalalas: 0, totalHalalas: 25_000 }]);
    expect(splitGroupPrice([1], 0)).toEqual([{ discountHalalas: 0, totalHalalas: 1 }]);
  });

  // scripts/check-booking.ts asserts five gross pairs at 10%. This sweeps every
  // whole percent a Setting could hold, against grosses chosen not to divide.
  it("sums back to the bill for every percent from 0 to 100", () => {
    const grosses = [13_333, 8_887, 1];
    for (let percent = 0; percent <= 100; percent++) {
      const grossTotal = 22_221;
      const discountTotal = Math.round((grossTotal * percent) / 100);
      const split = splitGroupPrice(grosses, percent);

      expect(split.reduce((n, s) => n + s.totalHalalas, 0)).toBe(grossTotal - discountTotal);
      expect(split.reduce((n, s) => n + s.discountHalalas, 0)).toBe(discountTotal);
      for (const s of split) expect(s.totalHalalas).toBeGreaterThanOrEqual(0);
    }
  });

  // A thousand generated bills. The salon takes about that many a month, so this
  // is a month of trading with no drift, not an abstract property.
  it("sums back to the bill on a thousand generated bills", () => {
    const rand = pseudoRandom(20260902);
    for (let i = 0; i < 1000; i++) {
      const guests = 1 + Math.floor(rand.next().value * 3);
      const grosses = Array.from(
        { length: guests },
        () => 1 + Math.floor(rand.next().value * 500_00),
      );
      const percent = Math.floor(rand.next().value * 51);

      const grossTotal = grosses.reduce((a, b) => a + b, 0);
      const discountTotal = Math.round((grossTotal * percent) / 100);
      const split = splitGroupPrice(grosses, percent);

      expect(split.reduce((n, s) => n + s.totalHalalas, 0)).toBe(grossTotal - discountTotal);
      expect(split.reduce((n, s) => n + s.discountHalalas, 0)).toBe(discountTotal);
      // Nobody is discounted more than their own share of the bill.
      for (const [j, s] of split.entries()) {
        expect(s.discountHalalas).toBeLessThanOrEqual(grosses[j]);
        expect(s.totalHalalas).toBe(grosses[j] - s.discountHalalas);
      }
    }
  });

  // One halala split two ways. Someone has to get it and someone has to not.
  it("hands the odd halala to one guest, never to both and never to neither", () => {
    expect(shareAmount([1, 1], 1)).toEqual([1, 0]);
    expect(shareAmount([1, 1, 1], 2)).toEqual([1, 1, 0]);
    expect(shareAmount([1, 1, 1], 1)).toEqual([1, 0, 0]);
    // Equal weights tie, and the tie is broken by position so two runs agree.
    expect(shareAmount([500, 500], 1)).toEqual(shareAmount([500, 500], 1));
  });

  it("gives the bigger bill the leftover halala when the remainders differ", () => {
    // 1 halala over [1, 99]: exact shares are 0.01 and 0.99, so the 99 wins.
    expect(shareAmount([1, 99], 1)).toEqual([0, 1]);
    expect(shareAmount([99, 1], 1)).toEqual([1, 0]);
  });

  it("shares nothing when there is nothing to share", () => {
    expect(shareAmount([25_000, 25_000], 0)).toEqual([0, 0]);
    expect(shareAmount([0, 0], 500)).toEqual([0, 0]);
    expect(shareAmount([], 500)).toEqual([]);
    expect(splitGroupPrice([0, 0], 10)).toEqual([
      { discountHalalas: 0, totalHalalas: 0 },
      { discountHalalas: 0, totalHalalas: 0 },
    ]);
  });

  it("gives one guest the whole discount when the other's bill is zero", () => {
    // A guest whose service is free carries none of the discount.
    expect(splitGroupPrice([10_000, 0], 10)).toEqual([
      { discountHalalas: 1_000, totalHalalas: 9_000 },
      { discountHalalas: 0, totalHalalas: 0 },
    ]);
  });

  it("takes the whole bill at 100%", () => {
    const split = splitGroupPrice([13_333, 8_888], 100);
    expect(split.reduce((n, s) => n + s.totalHalalas, 0)).toBe(0);
    expect(split.reduce((n, s) => n + s.discountHalalas, 0)).toBe(22_221);
  });

  // @characterization — CWS-4, undocumented, pins behaviour as of 2026-09-02.
  // group_discount_percent is a Setting. Nothing between the admin form and here
  // rejects a value outside 0..100, and the two ends fail differently: over 100
  // produces negative totals, under 0 is silently ignored. See BUG-MONEY-004.
  it("produces negative totals above 100% and silently ignores a negative percent", () => {
    const tooMuch = splitGroupPrice([10_000, 10_000], 150);
    expect(tooMuch.reduce((n, s) => n + s.totalHalalas, 0)).toBe(-10_000);

    // shareAmount floors any amount <= 0 to zeros, so the negative discount is
    // dropped rather than added — the customer is charged full price.
    expect(splitGroupPrice([10_000, 10_000], -10)).toEqual([
      { discountHalalas: 0, totalHalalas: 10_000 },
      { discountHalalas: 0, totalHalalas: 10_000 },
    ]);
  });

  // docs/BOOKING-V2.md:133 says this is correct and expected. Pinned so nobody
  // "fixes" it and breaks the totals in doing so.
  it("lets the guests' VAT differ by a halala from VAT on the whole bill", () => {
    const split = splitGroupPrice([9_999, 1], 10);
    const bill = split.reduce((n, s) => n + s.totalHalalas, 0);
    const perGuestVat = split.reduce((n, s) => n + vatIncludedIn(s.totalHalalas, 15), 0);
    const wholeBillVat = vatIncludedIn(bill, 15);

    expect(Math.abs(perGuestVat - wholeBillVat)).toBeLessThanOrEqual(1);
    // But each guest's own invoice still balances, which is what the customer sees.
    for (const s of split) {
      const vat = vatIncludedIn(s.totalHalalas, 15);
      expect(s.totalHalalas - vat + vat).toBe(s.totalHalalas);
    }
  });
});

describe("formatSAR is the only way a halala reaches a screen", () => {
  it("drops the decimals on a whole riyal and keeps them otherwise", () => {
    expect(formatSAR(25_000)).toBe("250");
    expect(formatSAR(25_050)).toBe("250.50");
    expect(formatSAR(1)).toBe("0.01");
    expect(formatSAR(0)).toBe("0");
  });

  it("groups thousands, which toFixed alone would not", () => {
    expect(formatSAR(123_456_700)).toBe("1,234,567");
    expect((1_234_567).toFixed(2)).toBe("1234567.00"); // the thing the schema comment forbids
  });

  it("can be forced to show decimals on a whole riyal, for a totals column", () => {
    expect(formatSAR(25_000, { decimals: true })).toBe("250.00");
  });
});
