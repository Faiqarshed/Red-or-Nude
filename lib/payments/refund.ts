// Sending money back when a customer cancels inside the window (brief §2.6).
//
// The counterpart to confirm.ts, and it inherits that file's shape: a group was
// charged once but recorded as one `payments` row per booking sharing a
// `providerRef`, so refunding a party means one gateway call for the summed
// amount and one `refunds` row per payment. Every row's amount stays equal to
// its booking's total, and SUM(refunds) per providerRef is what actually went
// back.

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { payments, refunds } from "@/lib/db/schema";
import { getDriver } from "./index";

/**
 * `ok: false` covers three real cases — nothing was ever paid, the gateway
 * refused, or the call blew up — but every caller so far only asks whether the
 * money went back. They are separated in the log, not in the type; split them
 * when something actually branches on which.
 */
export type RefundOutcome = { ok: true; amountHalalas: number } | { ok: false };

/**
 * Refund every paid payment attached to these bookings.
 *
 * **Never throws.** A cancellation must not fail because a gateway is having a
 * bad day — holding the customer's chair hostage to that is strictly worse than
 * owing them a refund we can settle by hand. A failure here is logged loudly
 * and left for the admin's payments view, exactly as confirm.ts treats a charge
 * it cannot confirm.
 */
export async function refundBookings(
  bookingIds: string[],
  reason: string,
): Promise<RefundOutcome> {
  if (bookingIds.length === 0) return { ok: false };

  try {
    const rows = await db
      .select({
        id: payments.id,
        providerRef: payments.providerRef,
        amountHalalas: payments.amountHalalas,
      })
      .from(payments)
      .where(and(inArray(payments.bookingId, bookingIds), eq(payments.status, "paid")));

    // An unpaid hold being cancelled, or a booking already refunded. Both are
    // ordinary — the customer simply has no money with us.
    if (rows.length === 0) return { ok: false };

    const total = rows.reduce((sum, r) => sum + r.amountHalalas, 0);
    // Every row of one bill shares a providerRef; taking the first is taking
    // the transaction they all belong to.
    const providerRef = rows[0].providerRef;
    if (!providerRef) {
      console.error("[payments] refund: paid rows with no providerRef", bookingIds);
      return { ok: false };
    }

    const result = await getDriver().refund({ providerRef, amountHalalas: total, reason });

    if (result.status !== "refunded") {
      console.error(`[payments] refund declined for ${providerRef}; settle by hand`);
      return { ok: false };
    }

    await db.transaction(async (tx) => {
      await tx.insert(refunds).values(
        rows.map((r) => ({
          paymentId: r.id,
          amountHalalas: r.amountHalalas,
          reason,
          // Null: the customer did this, not a member of staff. The audit log
          // is where the "who" for a self-service cancellation lives.
          actorId: null,
        })),
      );

      await tx
        .update(payments)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(
          inArray(
            payments.id,
            rows.map((r) => r.id),
          ),
        );
    });

    return { ok: true, amountHalalas: total };
  } catch (err) {
    // Money may or may not have moved. Loud, because a human has to look.
    console.error(`[payments] refund failed for bookings ${bookingIds.join(", ")}`, err);
    return { ok: false };
  }
}
