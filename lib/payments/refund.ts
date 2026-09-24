// Sending money back (brief §2.6).
//
// The counterpart to confirm.ts, and it inherits that file's shape: a group was
// charged once but recorded as one `payments` row per booking sharing a
// `providerRef`, so refunding a party means one gateway call for the summed
// amount and one `refunds` row per payment. Every row's amount stays equal to
// its booking's total, and SUM(refunds) per providerRef is what actually went
// back.

import "server-only";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, giftCards, payments, refunds } from "@/lib/db/schema";
import { sendMail } from "@/lib/email";
import { esc } from "@/lib/email/html";
import { formatSAR } from "@/lib/money";
import { alertOwner } from "./alert";
import { getDriver, mergeRaw } from "./index";
import type { Intent } from "./purchase";

/**
 * `ok: false` covers three real cases — nothing was ever paid, the gateway
 * refused, or the call blew up — but every caller so far only asks whether the
 * money went back. They are separated in the log, not in the type; split them
 * when something actually branches on which.
 */
export type RefundOutcome = { ok: true; amountHalalas: number } | { ok: false };

/**
 * Our rows that hold her money: paid, or the second payment for a booking
 * another payment already confirmed. revivePayment marks that one
 * `paidOnOldAttempt` and leaves it failed, since a booking can have only one
 * live payment, but the money on it is real.
 */
const holdsMoney = or(
  eq(payments.status, "paid"),
  and(eq(payments.status, "failed"), sql`${payments.raw} ? 'paidOnOldAttempt'`),
)!;

type MoneyRow = { id: string; amountHalalas: number; raw: unknown };

const mismatchOf = (rows: MoneyRow[]) => (rows[0].raw as { amountMismatch?: number } | null)?.amountMismatch;

/**
 * What she actually paid on these rows, one bill: the bill itself, unless
 * StreamPay took a different amount (`amountMismatch`, which is never confirmed).
 */
const paidOn = (rows: MoneyRow[]) => mismatchOf(rows) ?? rows.reduce((sum, r) => sum + r.amountHalalas, 0);

/**
 * The `refunds` rows for a whole bill going back: one per guest, each her own
 * total. A payment for an amount that was not the bill has no per-guest split,
 * so it is one row, on the first payment, for what she paid. Null actor: the
 * customer or the system did this, not a member of staff.
 */
const refundRows = (rows: MoneyRow[], reason: string) =>
  mismatchOf(rows) !== undefined
    ? [{ paymentId: rows[0].id, amountHalalas: paidOn(rows), reason, actorId: null }]
    : rows.map((r) => ({ paymentId: r.id, amountHalalas: r.amountHalalas, reason, actorId: null }));

/** Refund every paid payment attached to these bookings. See refundPaid. */
export async function refundBookings(bookingIds: string[], reason: string): Promise<RefundOutcome> {
  if (bookingIds.length === 0) return { ok: false };
  return refundPaid(and(inArray(payments.bookingId, bookingIds), eq(payments.status, "paid"))!, reason, bookingIds.join(", "));
}

/**
 * Refund one whole attempt: a late-paid hold, a purchase that could not be
 * delivered, a payment for the wrong amount, or a booking paid twice.
 */
export async function refundRef(ref: string, reason: string): Promise<RefundOutcome> {
  return refundPaid(and(eq(payments.providerRef, ref), holdsMoney)!, reason, ref);
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
      .where(which);

    // An unpaid hold being cancelled, or a booking already refunded. Both are
    // ordinary — the customer simply has no money with us.
    if (rows.length === 0) return { ok: false };

    const total = paidOn(rows);
    // A free booking was "paid" at zero and never reached a gateway.
    if (total === 0) return { ok: false };

    // No partial refunds: a refund is always the whole bill, every guest on it.
    // Asked to refund part of one (a guest whose friend is not being refunded),
    // nothing is sent and the owner decides.
    const refs = [...new Set(rows.map((r) => r.providerRef))];
    const [{ onBill }] = await db
      .select({ onBill: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(inArray(payments.providerRef, refs as string[]), holdsMoney));
    if (refs.length !== 1 || onBill !== rows.length) {
      await alertOwner(
        `partial-refund:${label}`,
        "A refund was not sent: it would have been partial",
        `Refunding ${label} (${reason}) would send back only part of payment ${refs.join(", ")}. ` +
          "Refunds are always whole. Nothing was sent; settle it in StreamPay if money is owed.",
      );
      return { ok: false };
    }

    // Marked first, so the PAYMENT_REFUNDED webhook this refund sets off is not
    // taken for a refund made outside the app (refundedOutside, below).
    await db
      .update(payments)
      .set({ raw: mergeRaw(payments.raw, { refundingAt: new Date().toISOString() }) })
      .where(inArray(payments.id, rows.map((r) => r.id)));

    // Every row of one bill shares a providerRef and the same gateway payment;
    // taking the first is taking the transaction they all belong to.
    const result = await getDriver().refund({ raw: rows[0].raw, amountHalalas: total, reason });

    if (result.status !== "refunded") {
      console.error(`[payments] refund declined for ${rows[0].providerRef}; settle by hand`);
      return { ok: false };
    }

    await db.transaction(async (tx) => {
      await tx.insert(refunds).values(refundRows(rows, reason));
      await tx
        .update(payments)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(inArray(payments.id, rows.map((r) => r.id)));
    });

    // She did not ask for this one, and a card refund takes days to show — so
    // she is told, or she sees money gone and nothing to show for it.
    if (AUTOMATIC.has(reason)) await emailRefund(rows[0], total, reason);

    return { ok: true, amountHalalas: total };
  } catch (err) {
    // Money may or may not have moved. Loud, because a human has to look.
    console.error(`[payments] refund failed for ${label}`, err);
    return { ok: false };
  }
}

/** Refunds the system made on its own — the customer did not press anything. */
const AUTOMATIC = new Set(["late-payment", "not-delivered", "wrong-amount", "duplicate-payment"]);

type RefundedRow = { raw: unknown; bookingId: string | null; treatBookingId: string | null };

/** Never throws: the money has already gone back; this only says so. */
async function emailRefund(row: RefundedRow, halalas: number, reason: string): Promise<void> {
  try {
    const to = await refundRecipient(row);
    if (!to) return;
    const amount = formatSAR(halalas);
    const days = {
      en: "Card refunds usually reach your account within 5–14 working days, depending on your bank.",
      ar: "يصل المبلغ المسترد عادةً إلى حسابك خلال ٥–١٤ يوم عمل حسب البنك.",
    };
    const texts: Record<"ar" | "en", [string, string]> =
      reason === "duplicate-payment"
        ? {
            en: [
              "Your extra payment has been refunded — Red or Nude",
              `You paid twice for the same booking. Your booking is confirmed, and the extra payment of ${amount} SAR has been refunded. ${days.en}`,
            ],
            ar: [
              "تم استرداد الدفعة الإضافية — Red or Nude",
              `تم الدفع مرتين لنفس الحجز. حجزك مؤكد، وتم استرداد الدفعة الإضافية بمبلغ ${amount} ريال. ${days.ar}`,
            ],
          }
        : {
            en: [
              "Your payment has been refunded — Red or Nude",
              `We could not complete your order, so your payment of ${amount} SAR has been refunded in full. ${days.en}`,
            ],
            ar: [
              "تم استرداد مبلغك — Red or Nude",
              `لم نتمكن من إتمام طلبك، لذلك تم استرداد مبلغ ${amount} ريال بالكامل. ${days.ar}`,
            ],
          };
    const [subject, text] = texts[to.lang];
    await sendMail({
      to: to.email,
      subject,
      text,
      html: `<p dir="${to.lang === "en" ? "ltr" : "rtl"}">${esc(text)}</p>`,
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

/**
 * StreamPay says money went back on this payment (the PAYMENT_REFUNDED and
 * PAYMENT_PARTIALLY_REFUNDED webhooks). Our own refunds are already recorded;
 * one made from their dashboard was not, and left the booking confirmed and a
 * refunded gift card still spendable.
 *
 * Fully refunded: the payment is recorded as refunded and a gift card it bought
 * is frozen. A booking or membership is left to the owner, who is told either
 * way — what a refund from the dashboard means for an appointment is a person's
 * call. Never throws.
 */
export async function refundedOutside(ref: string): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(payments)
      .where(and(eq(payments.providerRef, ref), holdsMoney));
    // Refunded already (ours, recorded), or never paid.
    if (rows.length === 0) return;
    const duplicate = rows.every((r) => (r.raw as { paidOnOldAttempt?: number } | null)?.paidOnOldAttempt);
    // Our own refund, still being recorded.
    const refundingAt = (rows[0].raw as { refundingAt?: string } | null)?.refundingAt;
    if (refundingAt && Date.now() - Date.parse(refundingAt) < 10 * 60_000) return;

    // What she paid, which is what a whole refund sends back.
    const total = paidOn(rows);
    const back = await getDriver().refundedHalalas(rows[0].raw);
    if (back <= 0) return;
    const full = back >= total;

    if (full) {
      await db.transaction(async (tx) => {
        const claimed = await tx
          .update(payments)
          .set({ status: "refunded", updatedAt: new Date() })
          .where(and(inArray(payments.id, rows.map((r) => r.id)), inArray(payments.status, ["paid", "failed"])))
          .returning({ id: payments.id });
        if (claimed.length === 0) return;
        await tx.insert(refunds).values(refundRows(rows, "outside-app"));
        const cards = rows.map((r) => r.giftCardId).filter((id): id is string => Boolean(id));
        if (cards.length > 0) {
          await tx.update(giftCards).set({ status: "cancelled", updatedAt: new Date() }).where(inArray(giftCards.id, cards));
        }
      });
    }

    const codesOf = async (ids: (string | null)[]) => {
      const some = ids.filter((id): id is string => Boolean(id));
      return some.length
        ? (await db.select({ code: bookings.code }).from(bookings).where(inArray(bookings.id, some))).map((b) => b.code)
        : [];
    };
    const codes = await codesOf(rows.map((r) => r.bookingId));
    const served = await codesOf(rows.map((r) => r.treatBookingId));
    const unserved = rows.some((r) => (r.raw as { intent?: Intent } | null)?.intent?.kind === "treat" && !r.treatBookingId);
    if (duplicate && full) {
      await alertOwner(
        `refunded:${ref}`,
        "A duplicate payment was refunded",
        `Payment ${ref}: ${formatSAR(back)} SAR went back. It was a second payment for bookings ${codes.join(", ")}, ` +
          "which stand on the other payment. Recorded; nothing more to do.",
      );
      return;
    }
    // A membership has no undo in the admin yet, so the owner is told it stands.
    const what = [
      codes.length ? `bookings ${codes.join(", ")} (still booked: cancel them in the admin if they should not stand)` : null,
      served.length ? `a chair purchase on booking ${served.join(", ")} (already served: nothing to undo)` : null,
      unserved ? "a chair purchase that was never served (nothing to undo)" : null,
      rows.some((r) => r.giftCardId) ? (full ? "a gift card, now frozen" : "a gift card, still active") : null,
      rows.some((r) => r.customerPackId) ? "a membership (still active: she keeps it unless you arrange otherwise with her)" : null,
    ].filter(Boolean);
    await alertOwner(
      `refunded:${ref}`,
      full ? "A payment was refunded outside the app" : "A payment was partly refunded outside the app",
      `Payment ${ref}: ${formatSAR(back)} of ${formatSAR(total)} SAR went back through StreamPay's dashboard.
` +
        `It paid for ${what.join("; ") || "nothing we can find"}.`,
    );
  } catch (err) {
    console.error(`[payments] could not record the outside refund of ${ref}`, err);
  }
}
