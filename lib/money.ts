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

/** Prices shown to customers are VAT-inclusive; split one back out. */
export function vatIncludedIn(totalHalalas: number, percent = DEFAULT_VAT_PERCENT): number {
  return totalHalalas - Math.round((totalHalalas * 100) / (100 + percent));
}

/**
 * What wallet credit pays of a bill: as much as it can, except that what is
 * left for the card is never under 1 SAR, StreamPay's smallest charge. Either
 * the credit covers the whole bill (a zero bill never reaches StreamPay) or it
 * leaves at least 1 SAR. One rule, for the checkout's preview and the charge.
 */
export function walletCovers(billHalalas: number, availableHalalas: number): number {
  const spend = Math.max(0, Math.min(billHalalas, availableHalalas));
  const left = billHalalas - spend;
  return left > 0 && left < HALALAS_PER_SAR ? Math.max(0, billHalalas - HALALAS_PER_SAR) : spend;
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

/**
 * What was taken off one booking row, by what took it. The row keeps the promo,
 * points and wallet shares on their own; the group share is whatever else is
 * in `discountHalalas`. One split, for the StreamPay coupons and the booking
 * email alike, so the two never name a discount differently.
 */
export function discountParts(b: {
  discountHalalas: number;
  promoDiscountHalalas: number;
  pointsDiscountHalalas: number;
  walletDiscountHalalas: number;
}): { group: number; promo: number; points: number; wallet: number } {
  const promo = b.promoDiscountHalalas;
  const points = b.pointsDiscountHalalas;
  const wallet = b.walletDiscountHalalas;
  return { group: b.discountHalalas - promo - points - wallet, promo, points, wallet };
}

/**
 * Whether she may spend `halalas` of her credit on this bill: what she typed,
 * up to walletCovers. Never more than she has or the bill, and never leaving
 * the card under 1 SAR. Nothing at all is always fine.
 */
export function walletSpendOk(halalas: number, billHalalas: number, availableHalalas: number): boolean {
  if (!Number.isInteger(halalas) || halalas < 0) return false;
  if (halalas === 0) return true;
  if (halalas > availableHalalas || halalas > billHalalas) return false;
  const left = billHalalas - halalas;
  return left === 0 || left >= HALALAS_PER_SAR;
}
