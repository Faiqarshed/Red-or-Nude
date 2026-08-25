// The loyalty wallet's database side (brief §2.8).
//
// The rules themselves live in lib/rewards.ts, which is pure and importable by
// client components. This file is only the lookups and the ledger writes — the
// same split lib/promo.ts and lib/cancellation.ts use, so the price quoted on
// screen and the price charged come from one set of functions.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, loyaltyTxns } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";
import {
  rewardDiscount,
  rewardFor,
  rewardRefusal,
  spendableBalance,
  type RewardRefusal,
} from "@/lib/rewards";

/**
 * The spendable balance.
 *
 * Reads the ledger and hands it to `spendableBalance` — the liveness rule is
 * written once, in TypeScript, and never as SQL. An earlier version had it both
 * ways for one round trip's worth of speed and needed a comment warning that
 * the two copies had to be edited together, which is exactly the kind of note
 * that stops being true. A customer's ledger is one row per booking; reading it
 * is not the expensive part of any page that asks.
 */
export async function loyaltyBalance(customerId: string): Promise<number> {
  const { booking_hold_min: holdMin } = await getSettings(["booking_hold_min"]);

  const rows = await db
    .select({
      deltaPoints: loyaltyTxns.deltaPoints,
      bookingStatus: bookings.status,
      bookingCreatedAt: bookings.createdAt,
    })
    .from(loyaltyTxns)
    .leftJoin(bookings, eq(bookings.id, loyaltyTxns.bookingId))
    .where(eq(loyaltyTxns.customerId, customerId));

  return spendableBalance(rows, holdMin);
}

export type RewardQuote =
  | { ok: true; points: number; percent: number; discountHalalas: number }
  | { ok: false; reason: RewardRefusal; balance: number };

/**
 * Look a rung up and price it against a bill.
 *
 * Called twice for the same checkout: once by /api/loyalty/quote to show the
 * customer what it's worth, and again inside createBookings to decide what they
 * are actually charged. The second one is the authority — nothing the browser
 * sends is trusted, including the balance — and running the identical function
 * both times is what keeps the two answers the same.
 */
export async function quoteReward(
  customerId: string,
  points: number,
  totalHalalas: number,
): Promise<RewardQuote> {
  const balance = await loyaltyBalance(customerId);
  const refusal = rewardRefusal(points, balance);
  if (refusal) return { ok: false, reason: refusal, balance };

  const reward = rewardFor(points)!;
  return {
    ok: true,
    points: reward.points,
    percent: reward.percent,
    discountHalalas: rewardDiscount(reward, totalHalalas),
  };
}

/** The db, or a transaction handle from inside createBookings. */
type Inserter = Pick<typeof db, "insert">;

/**
 * Spend points on a booking. Call inside the booking transaction, where the
 * customer row is already locked by the upsert — that lock is what stops two
 * checkouts in two tabs from spending the same balance twice.
 */
export async function spendPoints(
  tx: Inserter,
  customerId: string,
  bookingId: string,
  points: number,
): Promise<void> {
  if (points <= 0) return;
  await tx.insert(loyaltyTxns).values({
    customerId,
    bookingId,
    deltaPoints: -points,
    reason: "reward",
  });
}

/**
 * Award points for a paid bill. Called once per bill at confirmation, never at
 * hold time — an abandoned checkout must not mint points, exactly as it must not
 * spend a use of a promo code.
 *
 * Swallows its own errors: the money is taken and the booking is confirmed, so a
 * missed award is a support ticket, not a reason to fail a paid booking. A
 * ledger row can be added by hand; a charged card cannot be un-charged.
 */
export async function awardPoints(
  customerId: string,
  bookingId: string,
  points: number,
): Promise<void> {
  if (points <= 0) return;
  try {
    await db.insert(loyaltyTxns).values({
      customerId,
      bookingId,
      deltaPoints: points,
      reason: "earned",
    });
  } catch (err) {
    console.error("[loyalty] could not award points for a paid booking", err);
  }
}
