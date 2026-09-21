import "server-only";

// The safety net under the webhook (docs/PAYMENTS-STREAMPAY.md §3).
//
// The return page, the status poll and the webhook are the three ways a payment
// normally gets settled. All three can miss: she closes the tab on her bank's
// OTP page, and StreamPay gives up on a webhook after five failed deliveries.
// Left alone, that payment stays `pending` for ever and the money stays with us.
//
// So a clock (vercel.json, every two days — app/api/cron/settle-pending) asks
// StreamPay about every checkout nobody came back for. Two days is a Hobby-plan
// compromise, not a target: see docs/PAYMENTS-STATUS.md. It goes through the same settlePayment as everything else, so a run
// racing a late webhook is harmless, and a hold swept meanwhile is refunded by
// the late-payment path that already exists.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { sendMail } from "@/lib/email";
import { esc } from "@/lib/email/html";
import { formatSAR } from "@/lib/money";
import { mergeRaw, PAY_WINDOW_MIN } from "./index";
import { refundRef } from "./refund";
import { settlePayment } from "./settle";

/**
 * How far back an unanswered checkout is still worth asking about. Several
 * times the run interval, so a missed or late run cannot age one out unasked.
 */
const LOOKBACK = "7 days";

/**
 * A paid purchase that delivered nothing is refunded once it is this old (so the
 * process delivering it is certainly gone) and retried on each run until STOP,
 * after which it is left to the report rather than retried for ever.
 */
const UNDELIVERED_AFTER_MIN = 15;
const UNDELIVERED_STOP_MIN = 7 * 24 * 60;

/** Stop starting new work after this, to finish inside a short function limit. */
const BUDGET_MS = 40_000;

/** A checkout StreamPay has not answered for, still worth asking about. */
const UNANSWERED = sql`status = 'pending' and raw ->> 'linkId' is not null
  and created_at > now() - interval '${sql.raw(LOOKBACK)}'`;

/** Paid for a gift card / pack / treat that was never handed over. */
const UNDELIVERED = sql`status = 'paid' and booking_id is null and raw ? 'intent'
  and gift_card_id is null and customer_pack_id is null and treat_booking_id is null
  and amount_halalas > 0 and updated_at < now() - make_interval(mins => ${UNDELIVERED_AFTER_MIN})`;

export type ReconcileResult = { checked: number; paid: number; failed: number; refunded: number };

export async function reconcilePayments(): Promise<ReconcileResult> {
  const started = Date.now();
  const out: ReconcileResult = { checked: 0, paid: 0, failed: 0, refunded: 0 };

  // Least recently asked first. A row settle cannot resolve (StreamPay erroring,
  // its booking deleted) stays pending and is stamped, so it goes to the back
  // of the queue instead of blocking every row behind it; the report
  // names it once it has been stuck an hour.
  const stale = await db.execute<{ ref: string }>(sql`
    select provider_ref as ref from payments
    where ${UNANSWERED} and created_at < now() - make_interval(mins => ${PAY_WINDOW_MIN})
    group by provider_ref
    order by max(raw ->> 'checkedAt') nulls first, min(created_at)
    limit 50
  `);
  for (const { ref } of stale) {
    if (Date.now() - started > BUDGET_MS) break;
    out.checked++;
    try {
      const r = await settlePayment(ref);
      if (r.status === "paid") out.paid++;
      else if (r.status === "failed") out.failed++;
    } catch (err) {
      console.error(`[reconcile] could not settle ${ref}`, err);
    }
    await db
      .update(payments)
      .set({ raw: mergeRaw(payments.raw, { checkedAt: new Date().toISOString() }) })
      .where(and(eq(payments.providerRef, ref), eq(payments.status, "pending")));
  }

  // Paid, and the process that should have delivered it died first.
  const undelivered = await db.execute<{ ref: string }>(sql`
    select provider_ref as ref from payments
    where ${UNDELIVERED} and not raw ? 'amountMismatch'
      and updated_at > now() - make_interval(mins => ${UNDELIVERED_STOP_MIN})
    limit 10
  `);
  for (const { ref } of undelivered) {
    if (Date.now() - started > BUDGET_MS) break;
    const back = await refundRef(ref, "not-delivered");
    if (back.ok) out.refunded++;
    console.error(`[reconcile] ${ref} paid, never delivered: ${back.ok ? "refunded" : "REFUND OWED"}`);
  }

  return out;
}

type Problem = { ref: string; amount_halalas: number; created_at: string };

/**
 * Everything a person has to look at: money we hold for nothing, and checkouts
 * the reconciler could not get an answer for. Empty on a good day.
 */
export async function paymentProblems() {
  const [owedBookings, undelivered, stuck] = await Promise.all([
    // Paid for a hold we gave away (or a bill that did not match) and not refunded.
    db.execute<Problem>(sql`
      select p.provider_ref as ref, sum(p.amount_halalas)::int as amount_halalas, min(p.created_at)::text as created_at
      from payments p join bookings b on b.id = p.booking_id
      where p.status = 'paid'
        and (b.status = 'pending' or (b.status = 'cancelled' and b.cancel_reason = 'payment-timeout'))
        and p.updated_at < now() - interval '15 minutes'
      group by p.provider_ref
    `),
    db.execute<Problem>(sql`
      select provider_ref as ref, amount_halalas, created_at::text as created_at
      from payments where ${UNDELIVERED}
    `),
    // StreamPay has not given an answer for an hour.
    db.execute<Problem>(sql`
      select provider_ref as ref, sum(amount_halalas)::int as amount_halalas, min(created_at)::text as created_at
      from payments where ${UNANSWERED} and created_at < now() - interval '1 hour'
      group by provider_ref
    `),
  ]);
  return { owedBookings: [...owedBookings], undelivered: [...undelivered], stuck: [...stuck] };
}

/** Mail the owner the problem list. Silent when there is nothing to say. */
export async function reportPaymentProblems(): Promise<number> {
  const p = await paymentProblems();
  const sections: [string, Problem[]][] = [
    ["Paid, booking not confirmed, not refunded — refund in StreamPay", p.owedBookings],
    ["Paid, nothing delivered, not refunded — refund in StreamPay", p.undelivered],
    ["No answer from StreamPay for over an hour — check in StreamPay", p.stuck],
  ];
  const count = sections.reduce((n, [, rows]) => n + rows.length, 0);
  if (count === 0) return 0;

  const text = sections
    .filter(([, rows]) => rows.length)
    .map(
      ([title, rows]) =>
        `${title}\n` +
        rows.map((r) => `  ${r.ref}  ${formatSAR(r.amount_halalas)} SAR  ${r.created_at}`).join("\n"),
    )
    .join("\n\n");
  console.error(`[reconcile] ${count} payment problem(s)\n${text}`);

  const to = process.env.PAYMENTS_ALERT_EMAIL?.trim();
  if (to) {
    await sendMail({
      to,
      subject: `Payments need attention: ${count}`,
      text,
      html: `<pre>${esc(text)}</pre>`,
      tags: ["payments-alert"],
    });
  }
  return count;
}
