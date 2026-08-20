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

/**
 * Share `amount` across `weights` in proportion, by largest remainder.
 *
 * The returned shares sum to `amount` exactly — that is the whole point. Working
 * out each share independently and rounding each one does not: two halves of an
 * odd halala both round up and the bill no longer adds up.
 *
 * Used for every discount that is decided on a combined bill and then has to be
 * attributed to the guests on it — the group discount and the promo code both.
 * Written once because those two must not drift on how the last halala lands.
 */
export function shareAmount(weights: number[], amount: number): number[] {
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  if (amount <= 0 || weightTotal <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (amount * w) / weightTotal);
  const shares = exact.map((e) => Math.floor(e));

  // 0..n-1 halalas are left over after flooring; give them to the guests whose
  // fractional part was largest, ties broken by position so it's deterministic.
  const leftover = amount - shares.reduce((sum, s) => sum + s, 0);
  const byRemainder = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < leftover; k++) shares[byRemainder[k].i] += 1;

  return shares;
}

export type PriceSplit = { discountHalalas: number; totalHalalas: number };

/**
 * Share a group discount across the guests on one bill.
 *
 * The discount is rounded exactly once, off the combined total, and then handed
 * out by `shareAmount` above — which is what guarantees the guests' totals add
 * back up to the bill to the halala.
 *
 * A single guest, or a percent of 0, returns the gross amounts untouched, so the
 * ordinary one-person booking runs through the same code with no change in what
 * it charges.
 */
export function splitGroupPrice(grosses: number[], percent: number): PriceSplit[] {
  const grossTotal = grosses.reduce((sum, g) => sum + g, 0);
  const discountTotal = grossTotal > 0 ? Math.round((grossTotal * percent) / 100) : 0;
  const discounts = shareAmount(grosses, discountTotal);

  return grosses.map((g, i) => ({ discountHalalas: discounts[i], totalHalalas: g - discounts[i] }));
}
