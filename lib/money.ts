// Money helpers. Amounts are integer halalas everywhere (1 SAR = 100 halalas);
// see the header of lib/db/schema.ts for why.

export const HALALAS_PER_SAR = 100;

/** VAT rate as a percentage. Overridable from Settings; this is the KSA default. */
export const DEFAULT_VAT_PERCENT = 15;

export const sarToHalalas = (sar: number): number => Math.round(sar * HALALAS_PER_SAR);
export const halalasToSar = (halalas: number): number => halalas / HALALAS_PER_SAR;

/**
 * Display a halalas amount. Returns the number only — the riyal glyph is drawn
 * by the <Riyal /> icon component, as on the public site.
 */
export function formatSAR(halalas: number, opts: { decimals?: boolean } = {}): string {
  const showDecimals = opts.decimals ?? halalas % HALALAS_PER_SAR !== 0;
  return halalasToSar(halalas).toLocaleString("en-US", {
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/**
 * VAT on a VAT-exclusive subtotal. Rounds half-up to the halala, so
 * subtotal + vat always equals the total that gets charged.
 */
export function vatOn(subtotalHalalas: number, percent = DEFAULT_VAT_PERCENT): number {
  return Math.round((subtotalHalalas * percent) / 100);
}

/** Prices shown to customers are VAT-inclusive; split one back out. */
export function vatIncludedIn(totalHalalas: number, percent = DEFAULT_VAT_PERCENT): number {
  return totalHalalas - Math.round((totalHalalas * 100) / (100 + percent));
}

export type PriceSplit = { discountHalalas: number; totalHalalas: number };

/**
 * Share a group discount across the guests on one bill.
 *
 * The discount is rounded exactly once, off the combined total, and then handed
 * out by largest remainder. That is what guarantees the guests' totals add back
 * up to the bill to the halala — discounting each guest separately and rounding
 * twice does not.
 *
 * A single guest, or a percent of 0, returns the gross amounts untouched, so the
 * ordinary one-person booking runs through the same code with no change in what
 * it charges.
 */
export function splitGroupPrice(grosses: number[], percent: number): PriceSplit[] {
  const grossTotal = grosses.reduce((sum, g) => sum + g, 0);
  const discountTotal = grossTotal > 0 ? Math.round((grossTotal * percent) / 100) : 0;

  if (discountTotal <= 0) {
    return grosses.map((g) => ({ discountHalalas: 0, totalHalalas: g }));
  }

  const exact = grosses.map((g) => (discountTotal * g) / grossTotal);
  const discounts = exact.map((e) => Math.floor(e));

  // 0..n-1 halalas are left over after flooring; give them to the guests whose
  // fractional part was largest, ties broken by position so it's deterministic.
  const leftover = discountTotal - discounts.reduce((sum, d) => sum + d, 0);
  const byRemainder = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < leftover; k++) discounts[byRemainder[k].i] += 1;

  return grosses.map((g, i) => ({ discountHalalas: discounts[i], totalHalalas: g - discounts[i] }));
}
