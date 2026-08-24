// Discount codes (brief §2.10) — what a code is worth, and why it is refused.
//
// Split the way lib/cancellation.ts is split, and for the same reason: the rule
// itself is pure and dependency-free, and only the lookup touches the database.
// The checkout preview, the booking write and the test script all consult the
// same `promoRefusal` / `promoDiscount` pair, so the price quoted on screen and
// the price charged cannot drift.
//
// Everything is halalas. See the header of lib/db/schema.ts.

import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoCodes } from "@/lib/db/schema";

/** The fields the rule needs. A subset of a promo_codes row, so tests can fake it. */
export type PromoRule = {
  type: "percent" | "fixed";
  /** Percent points when `percent`, halalas when `fixed`. */
  value: number;
  minTotalHalalas: number;
  startsAt: Date | null;
  endsAt: Date | null;
  maxUses: number | null;
  uses: number;
  active: boolean;
};

export type PromoRefusal =
  /** No such code. Also what a code with a typo looks like. */
  | "unknown"
  /** Switched off by staff. */
  | "inactive"
  /** A real code, but its occasion hasn't started yet. */
  | "not-started"
  | "expired"
  | "used-up"
  /** Real and live, but this bill is too small for it. */
  | "min-total";

/**
 * Why this code doesn't apply to this bill, or `null` if it does.
 *
 * Named reasons rather than a bare false, because the checkout says them out
 * loud: "that code needs a bill of 200 SAR or more" sends the customer somewhere
 * useful, and "invalid code" sends them to check for a typo that isn't there.
 */
export function promoRefusal(
  promo: PromoRule,
  totalHalalas: number,
  now: Date = new Date(),
): PromoRefusal | null {
  if (!promo.active) return "inactive";
  if (promo.startsAt && now < promo.startsAt) return "not-started";
  // Strictly after: a code is not both live and expired in the same millisecond.
  if (promo.endsAt && now >= promo.endsAt) return "expired";
  if (promo.maxUses !== null && promo.uses >= promo.maxUses) return "used-up";
  if (totalHalalas < promo.minTotalHalalas) return "min-total";
  return null;
}

/**
 * What the code takes off this bill.
 *
 * Capped at the total on purpose: a 500 SAR card on a 200 SAR bill discounts
 * 200. A discount larger than the bill is a refund, and a promo code must never
 * be able to hand out money that was never taken.
 */
export function promoDiscount(promo: PromoRule, totalHalalas: number): number {
  if (totalHalalas <= 0) return 0;
  const raw =
    promo.type === "percent"
      ? Math.round((totalHalalas * promo.value) / 100)
      : promo.value;
  return Math.max(0, Math.min(raw, totalHalalas));
}

/** Codes are stored and compared uppercase — they get typed in every casing. */
export function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

export type PromoQuote =
  | { ok: true; id: string; code: string; discountHalalas: number }
  | { ok: false; reason: PromoRefusal; minTotalHalalas?: number };

/**
 * Look a code up and price it against a bill.
 *
 * Called twice for the same checkout: once by /api/promo/quote to show the
 * customer what it's worth, and again inside createBookings to decide what they
 * are actually charged. The second one is the authority — nothing the browser
 * sends is trusted — and running the identical function both times is what keeps
 * the two answers the same.
 */
export async function quotePromo(
  code: string,
  totalHalalas: number,
  now: Date = new Date(),
): Promise<PromoQuote> {
  const normalized = normalizePromoCode(code);
  if (!normalized) return { ok: false, reason: "unknown" };

  const [row] = await db
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.code, normalized))
    .limit(1);
  if (!row) return { ok: false, reason: "unknown" };

  const refusal = promoRefusal(row, totalHalalas, now);
  if (refusal) {
    // The one refusal the customer can do something about is worth spelling out.
    return refusal === "min-total"
      ? { ok: false, reason: refusal, minTotalHalalas: row.minTotalHalalas }
      : { ok: false, reason: refusal };
  }

  return {
    ok: true,
    id: row.id,
    code: row.code,
    discountHalalas: promoDiscount(row, totalHalalas),
  };
}

/**
 * Count a redemption. Called once the charge has cleared, never at hold time —
 * an abandoned checkout must not burn a use of a limited code.
 *
 * ponytail: because the cap is checked at hold and counted here, two people
 * racing the last use of a capped code can both redeem it. Nobody is mispriced
 * by that and occasion codes are uncapped or generous. If a code ever needs a
 * hard cap, move the count to hold time as a conditional
 * `update … where uses < max_uses` and release it when the hold is swept.
 */
export async function countPromoUse(promoCodeId: string): Promise<void> {
  try {
    // Incremented in SQL rather than read-then-written, so two confirmations
    // landing at once can't both write the same `uses + 1`.
    await db
      .update(promoCodes)
      .set({ uses: sql`${promoCodes.uses} + 1`, updatedAt: new Date() })
      .where(eq(promoCodes.id, promoCodeId));
  } catch (err) {
    // The money is taken and the booking is confirmed. A miscounted redemption
    // is a reporting problem, not a reason to fail a paid booking.
    console.error("[promo] could not count a redemption", err);
  }
}
