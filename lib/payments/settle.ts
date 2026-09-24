import "server-only";

// One door for "what became of payment `ref`?", whatever it was paying for.
// The return page, the status poll and the webhook all come through here, and
// the settle functions behind it are idempotent, so arriving three times for
// the same payment is fine.

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { formatSAR } from "@/lib/money";
import { alertOwner } from "./alert";
import { isLiveAttemptConflict, settleBookingPayment, type ConfirmedTicket } from "./confirm";
import { settlePurchase, type Delivered } from "./purchase";
import { getDriver, mergeRaw, type Verdict } from "./index";

export type Settled =
  | {
      status: "paid";
      result: { kind: "booking"; tickets: ConfirmedTicket[]; totalHalalas: number } | Delivered;
    }
  /**
   * Still payable: `checkout` lets a page that lost it re-open the same one.
   * `unverified`: StreamPay did not answer, so we know nothing yet. The page keeps
   * asking; the webhook answers 503 so StreamPay sends it again.
   */
  | { status: "pending"; checkout?: { ref: string; url: string }; unverified?: true }
  | { status: "failed"; error: string };

export async function settlePayment(ref: string): Promise<Settled> {
  const [row] = await db
    .select({ bookingId: payments.bookingId })
    .from(payments)
    .where(eq(payments.providerRef, ref))
    .limit(1);
  if (!row) return { status: "failed", error: "not-found" };

  if (row.bookingId) {
    const r = await settleBookingPayment(ref);
    if (!r.ok && r.error === "unverified") return { status: "pending", unverified: true };
    if (!r.ok) return { status: "failed", error: r.error };
    if ("checkout" in r) return { status: "pending", checkout: r.checkout };
    return { status: "paid", result: { kind: "booking", tickets: r.tickets, totalHalalas: r.totalHalalas } };
  }

  const r = await settlePurchase(ref);
  if (!r.ok && r.error === "unverified") return { status: "pending", unverified: true };
  if (!r.ok) return { status: "failed", error: r.error };
  if ("checkout" in r) return { status: "pending", checkout: r.checkout };
  return { status: "paid", result: r.delivered };
}

/** Our ref for a StreamPay payment link, for a webhook that did not carry it. */
export async function refForLink(linkId: string): Promise<string | null> {
  const [row] = await db
    .select({ ref: payments.providerRef })
    .from(payments)
    .where(sql`${payments.raw}->>'linkId' = ${linkId}`)
    .limit(1);
  return row?.ref ?? null;
}

/**
 * Money on a payment we had already marked failed: its link expired while she
 * was still on her bank's page, or it had a status we did not know. The settle
 * job asks again on a back-off, and a success webhook for it asks at once.
 *
 * If StreamPay now says paid, the payment goes back to pending and is settled
 * like any other: confirmed or delivered while that is still possible,
 * otherwise refunded as a late payment. Returns true when it was paid.
 */
export async function revivePayment(ref: string): Promise<boolean> {
  const rows = await db.select().from(payments).where(eq(payments.providerRef, ref));
  if (rows.length === 0 || rows.some((r) => r.status !== "failed")) return false;

  let verdict: Verdict;
  try {
    verdict = await getDriver().verify(rows[0].raw);
  } catch (err) {
    console.error(`[payments] could not re-check ${ref}`, err);
    return false;
  }
  if (verdict.status !== "paid") return false;

  await alertOwner(
    `revived:${ref}`,
    "A payment we had written off was paid",
    `Payment ${ref}: ${formatSAR(verdict.amountHalalas)} SAR arrived after it was marked failed. ` +
      "It is being confirmed now, or refunded automatically if that is no longer possible.",
  );
  // A newer attempt for the same booking holds payments_booking_live_unique.
  // Still only a checkout, it is switched off and this payment takes its place:
  // leaving it open was a second way to pay for one booking.
  const bookingIds = rows.map((r) => r.bookingId).filter((id): id is string => Boolean(id));
  const reopened = (await reopen(ref)) || (bookingIds.length > 0 && (await retireOpenAttempt(ref, bookingIds)) && (await reopen(ref)));
  if (!reopened) {
    // The newer attempt is paid, or may still be: two payments for one
    // booking, and refunding the right one is a person's job.
    await db
      .update(payments)
      .set({ raw: mergeRaw(payments.raw, { paidOnOldAttempt: verdict.amountHalalas }) })
      .where(eq(payments.providerRef, ref));
    await alertOwner(
      `old-attempt:${ref}`,
      "A booking may have been paid twice",
      `Payment ${ref} (${formatSAR(verdict.amountHalalas)} SAR) came through while a newer payment for the same booking was paid or still in progress. Check both in StreamPay and refund one.`,
    );
    return true;
  }
  if (rows[0].bookingId) await settleBookingPayment(ref, verdict);
  else await settlePurchase(ref, verdict);
  return true;
}

/** failed → pending. False when another live attempt for the booking is in the way. */
async function reopen(ref: string): Promise<boolean> {
  try {
    await db
      .update(payments)
      .set({ status: "pending", updatedAt: new Date() })
      .where(and(eq(payments.providerRef, ref), eq(payments.status, "failed")));
    return true;
  } catch (err) {
    if (!isLiveAttemptConflict(err)) throw err;
    return false;
  }
}

/**
 * Take the booking's other live attempt out of the way, if it is only a
 * checkout nobody paid on. Its link is switched off first, so she cannot pay
 * on it between the question and the answer; it is marked failed only when
 * StreamPay then says nothing is paid or waiting on it. True when it is gone.
 */
async function retireOpenAttempt(ref: string, bookingIds: string[]): Promise<boolean> {
  const live = await db
    .select()
    .from(payments)
    .where(
      and(
        inArray(payments.bookingId, bookingIds),
        inArray(payments.status, ["pending", "paid"]),
        ne(payments.providerRef, ref),
      ),
    );
  if (live.some((r) => r.status === "paid")) return false;

  const driver = getDriver();
  for (const other of new Set(live.map((r) => r.providerRef))) {
    const raw = live.find((r) => r.providerRef === other)!.raw;
    await driver.cancel(raw);
    const verdict = await driver.verify(raw).catch(() => null);
    if (verdict?.status !== "failed") return false;
    await db
      .update(payments)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(payments.providerRef, other!), eq(payments.status, "pending")));
  }
  return true;
}
