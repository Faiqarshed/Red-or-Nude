// What her points are worth on the account screen: only what she can spend.
// Points are spent in whole steps of 50, so 468 points buy 90 SAR, never 93.60.

import { describe, expect, it } from "vitest";
import { spendableWorth } from "@/lib/rewards";

const rules = { firstSar: 199, stepSar: 200, stepPoints: 50, pointHalalas: 20 };

describe("what her points are worth", () => {
  it("counts only whole steps of 50", () => {
    expect(spendableWorth(468, rules)).toBe(9_000);
    expect(spendableWorth(450, rules)).toBe(9_000);
  });

  it("is nothing below one step", () => {
    expect(spendableWorth(49, rules)).toBe(0);
    expect(spendableWorth(-20, rules)).toBe(0);
  });
});
