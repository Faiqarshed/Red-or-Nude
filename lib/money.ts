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
