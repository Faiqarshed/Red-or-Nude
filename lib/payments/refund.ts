// Sending money back (brief §2.6).
//
// The counterpart to confirm.ts, and it inherits that file's shape: a group was
// charged once but recorded as one `payments` row per booking sharing a
// `providerRef`, so refunding a party means one gateway call for the summed
// amount and one `refunds` row per payment. Every row's amount stays equal to
// its booking's total, and SUM(refunds) per providerRef is what actually went
// back.

import "server-only";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, payments, refunds } from "@/lib/db/schema";
import { sendMail } from "@/lib/email";
import { esc } from "@/lib/email/html";
import { formatSAR } from "@/lib/money";
import { getDriver } from "./index";
import type { Intent } from "./purchase";

/**
 * `ok: false` covers three real cases — nothing was ever paid, the gateway
 * refused, or the call blew up — but every caller so far only asks whether the
 * money went back. They are separated in the log, not in the type; split them
 * when something actually branches on which.
 */
export type RefundOutcome = { ok: true; amountHalalas: number } | { ok: false };

/** Refund every paid payment attached to these bookings. See refundPaid. */
export async function refundBookings(bookingIds: string[], reason: string): Promise<RefundOutcome> {
  if (bookingIds.length === 0) return { ok: false };
  return refundPaid(inArray(payments.bookingId, bookingIds), reason, bookingIds.join(", "));
}

/** Refund one whole attempt: a late-paid hold, or a purchase that could not be delivered. */
export async function refundRef(ref: string, reason: string): Promise<RefundOutcome> {
  return refundPaid(eq(payments.providerRef, ref), reason, ref);
}

/**
 * **Never throws.** A cancellation must not fail because a gateway is having a
 * bad day — holding the customer's chair hostage to that is strictly worse than
 * owing them a refund we can settle by hand. A failure here is logged loudly,
 * exactly as confirm.ts treats a charge it cannot confirm.
 */
async function refundPaid(which: SQL, reason: string, label: string): Promise<RefundOutcome> {
  try {
    const rows = await db
      .select({
        id: payments.id,
        providerRef: payments.providerRef,
        amountHalalas: payments.amountHalalas,
        raw: payments.raw,
        bookingId: payments.bookingId,
        treatBookingId: payments.treatBookingId,
      })
      .from(payments)
      .where(and(which, eq(payments.status, "paid")));

    // An unpaid hold being cancelled, or a booking already refunded. Both are
    // ordinary — the customer simply has no money with us.
    if (rows.length === 0) return { ok: false };

    const total = rows.reduce((sum, r) => sum + r.amountHalalas, 0);
    // A free booking was "paid" at zero and never reached a gateway.
    if (total === 0) return { ok: false };

    // Every row of one bill shares a providerRef and the same gateway payment;
    // taking the first is taking the transaction they all belong to.
    const result = await getDriver().refund({ raw: rows[0].raw, amountHalalas: total, reason });

    if (result.status !== "refunded") {
      console.error(`[payments] refund declined for ${rows[0].providerRef}; settle by hand`);
      return { ok: false };
    }

    await db.transaction(async (tx) => {
      await tx.insert(refunds).values(
        rows.map((r) => ({
          paymentId: r.id,
          amountHalalas: r.amountHalalas,
          reason,
          // Null: the customer or the system did this, not a member of staff.
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

    // She did not ask for this one, and a card refund takes days to show — so
    // she is told, or she sees money gone and nothing to show for it.
    if (AUTOMATIC.has(reason)) await emailRefund(rows[0], total);

    return { ok: true, amountHalalas: total };
  } catch (err) {
    // Money may or may not have moved. Loud, because a human has to look.
    console.error(`[payments] refund failed for ${label}`, err);
    return { ok: false };
  }
}

/** Refunds the system made on its own — the customer did not press anything. */
const AUTOMATIC = new Set(["late-payment", "not-delivered"]);

type RefundedRow = { raw: unknown; bookingId: string | null; treatBookingId: string | null };

/** Never throws: the money has already gone back; this only says so. */
async function emailRefund(row: RefundedRow, halalas: number): Promise<void> {
  try {
    const to = await refundRecipient(row);
    if (!to) return;
    const amount = formatSAR(halalas);
    const [subject, text] =
      to.lang === "en"
        ? [
            "Your payment has been refunded — Red or Nude",
            `We could not complete your order, so your payment of ${amount} SAR has been refunded in full. ` +
              "Card refunds usually reach your account within 5–14 working days, depending on your bank.",
          ]
        : [
            "تم استرداد مبلغك — Red or Nude",
            `لم نتمكن من إتمام طلبك، لذلك تم استرداد مبلغ ${amount} ريال بالكامل. ` +
              "يصل المبلغ المسترد عادةً إلى حسابك خلال ٥–١٤ يوم عمل حسب البنك.",
          ];
    const dir = to.lang === "en" ? "ltr" : "rtl";
    await sendMail({
      to: to.email,
      subject,
      text,
      html: `<p dir="${dir}">${esc(text)}</p>`,
      replyTo: process.env.MAIL_REPLY_TO?.trim() || null,
      tags: ["refund"],
    });
  } catch (err) {
    console.error("[payments] refund email failed", err);
  }
}

async function refundRecipient(row: RefundedRow): Promise<{ email: string; lang: "ar" | "en" } | null> {
  const intent = (row.raw as { intent?: Intent } | null)?.intent;
  if (intent?.kind === "gift_card") {
    return intent.buyerEmail ? { email: intent.buyerEmail, lang: intent.lang } : null;
  }

  let customerId = intent?.kind === "pack" ? intent.customerId : null;
  const bookingId = row.bookingId ?? row.treatBookingId ?? (intent?.kind === "treat" ? intent.bookingId : null);
  if (!customerId && bookingId) {
    const [b] = await db.select({ customerId: bookings.customerId }).from(bookings).where(eq(bookings.id, bookingId)).limit(1);
    customerId = b?.customerId ?? null;
  }
  if (!customerId) return null;

  const [c] = await db
    .select({ email: customers.email, lang: customers.lang })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return c?.email ? { email: c.email, lang: c.lang } : null;
}
