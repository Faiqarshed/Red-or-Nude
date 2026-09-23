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
import { redeliver, refundOrCredit, type Intent } from "./purchase";
import { refundedOutside, refundRef } from "./refund";
import { getDriver } from "./index";
import { revivePayment, settlePayment } from "./settle";

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

/** Pending with a checkout, whatever its age: the report's "no answer" list. */
const STUCK = sql`status = 'pending' and raw ->> 'linkId' is not null`;

/**
 * Marked failed, but money can still land on it: the link expired while she was
 * on her bank's page, or StreamPay reported something we did not know. Asked
 * again on a back-off — once its last check is older than a quarter of its age,
 * which comes to roughly 15 min, 1 h, 6 h, 24 h and 47 h.
 */
const WRITTEN_OFF = sql`status = 'failed' and raw ->> 'linkId' is not null
  and created_at > now() - interval '48 hours'
  and created_at < now() - make_interval(mins => ${PAY_WINDOW_MIN + 5})
  and coalesce((raw ->> 'checkedAt')::timestamptz, created_at) < now() - (now() - created_at) / 4`;

/** Paid for a booking that could not be confirmed, and the refund has not gone through. */
const OWED_BOOKING = sql`p.status = 'paid' and not p.raw ? 'amountMismatch' and not p.raw ? 'paidOnOldAttempt'
  and (b.status = 'pending' or (b.status = 'cancelled' and b.cancel_reason = 'payment-timeout'))`;

/** Paid for a gift card / pack / treat that was never handed over. */
const UNDELIVERED = sql`status = 'paid' and booking_id is null and raw ? 'intent' and not raw ? 'owedCredit'
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

  // Written off as failed, but the money may have landed since.
  const writtenOff = await db.execute<{ ref: string }>(sql`
    select distinct provider_ref as ref from payments where ${WRITTEN_OFF} limit 20
  `);
  for (const { ref } of writtenOff) {
    if (Date.now() - started > BUDGET_MS) break;
    if (await revivePayment(ref)) out.paid++;
    await db
      .update(payments)
      .set({ raw: mergeRaw(payments.raw, { checkedAt: new Date().toISOString() }) })
      .where(and(eq(payments.providerRef, ref), eq(payments.status, "failed")));
  }

  // Paid, and the process that should have delivered it died first. Delivered
  // again if it can be; otherwise given back.
  const undelivered = await db.execute<{ ref: string; amount: number; intent: Intent }>(sql`
    select provider_ref as ref, amount_halalas as amount, raw -> 'intent' as intent from payments
    where ${UNDELIVERED} and not raw ? 'amountMismatch'
      and updated_at > now() - make_interval(mins => ${UNDELIVERED_STOP_MIN})
    limit 10
  `);
  for (const { ref, amount, intent } of undelivered) {
    if (Date.now() - started > BUDGET_MS) break;
    if (await redeliver(ref)) {
      console.error(`[reconcile] ${ref} paid, delivered late`);
      continue;
    }
    const back = await refundOrCredit(ref, amount, intent);
    if (back) out.refunded++;
    console.error(`[reconcile] ${ref} paid, never delivered: ${back ? "refunded or owed as credit" : "REFUND OWED"}`);
  }

  // Paid for a booking that could not be confirmed, whose refund failed. The
  // refund asks StreamPay first, so one that went through is recorded, not sent twice.
  const owed = await db.execute<{ ref: string }>(sql`
    select distinct p.provider_ref as ref from payments p join bookings b on b.id = p.booking_id
    where ${OWED_BOOKING}
      and p.updated_at < now() - interval '15 minutes'
      and p.updated_at > now() - make_interval(mins => ${UNDELIVERED_STOP_MIN})
    limit 10
  `);
  for (const { ref } of owed) {
    if (Date.now() - started > BUDGET_MS) break;
    const back = await refundRef(ref, "late-payment");
    if (back.ok) out.refunded++;
    console.error(`[reconcile] ${ref} paid for a booking it could not confirm: ${back.ok ? "refunded" : "REFUND OWED"}`);
  }

  return out;
}

type Problem = { ref: string; amount_halalas: number; created_at: string };

/**
 * Everything a person has to look at: money we hold for nothing, and checkouts
 * the reconciler could not get an answer for. Empty on a good day.
 */
export async function paymentProblems() {
  const [owedBookings, undelivered, stuck, oldAttempts, owedCredit] = await Promise.all([
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
    // StreamPay has not given an answer for an hour — listed however old, so a
    // payment stuck longer than the settle job looks back never drops off.
    db.execute<Problem>(sql`
      select provider_ref as ref, sum(amount_halalas)::int as amount_halalas, min(created_at)::text as created_at
      from payments where ${STUCK} and created_at < now() - interval '1 hour'
      group by provider_ref
    `),
    // Paid on an old attempt after a newer one had paid for the same booking.
    db.execute<Problem>(sql`
      select provider_ref as ref, sum(amount_halalas)::int as amount_halalas, min(created_at)::text as created_at
      from payments where status = 'failed' and raw ? 'paidOnOldAttempt'
      group by provider_ref
    `),
    // A small chair purchase we could not deliver: owed as credit, for the desk
    // until the wallet ships. A week in the report is enough to act on it.
    db.execute<Problem>(sql`
      select provider_ref as ref, amount_halalas, created_at::text as created_at
      from payments where raw ? 'owedCredit' and updated_at > now() - interval '7 days'
    `),
  ]);
  return {
    owedBookings: [...owedBookings],
    undelivered: [...undelivered],
    stuck: [...stuck],
    oldAttempts: [...oldAttempts],
    owedCredit: [...owedCredit],
  };
}

/**
 * The last 30 days of StreamPay's payments, set against ours. The daily net
 * under the webhooks, which StreamPay stops retrying after about 20 hours:
 *
 *   - refunded there, still paid here: a refund from their dashboard, or a
 *     chargeback — recorded, and a gift card it bought is frozen
 *     (refundedOutside, the same as the PAYMENT_REFUNDED webhook);
 *   - taken there, not recorded here: money we do not know we have;
 *   - a different amount there than here.
 *
 * Never throws: it is one section of the report, not a reason to skip it.
 */
export async function compareWithGateway(now = new Date()): Promise<{ unknown: Problem[]; different: Problem[] }> {
  const unknown: Problem[] = [];
  const different: Problem[] = [];
  try {
    const theirs = await getDriver().listPayments(new Date(now.getTime() - 30 * 86_400_000), now);
    if (theirs.length === 0) return { unknown, different };
    const ours = await db.execute<{ id: string; ref: string; status: string; amount: number }>(sql`
      select raw ->> 'paymentId' as id, provider_ref as ref, status, sum(amount_halalas)::int as amount
      from payments where raw ->> 'paymentId' in (${sql.join(theirs.map((p) => sql`${p.id}`), sql`, `)})
      group by raw ->> 'paymentId', provider_ref, status
    `);
    const byId = new Map([...ours].map((o) => [o.id, o]));
    for (const p of theirs) {
      const mine = byId.get(p.id);
      if (!mine) {
        if (p.state !== "other") unknown.push({ ref: `StreamPay ${p.id}`, amount_halalas: p.amountHalalas, created_at: "" });
        continue;
      }
      if ((p.state === "refunded" || p.state === "partly-refunded") && mine.status === "paid") {
        await refundedOutside(mine.ref);
      } else if (p.state === "paid" && mine.amount !== p.amountHalalas) {
        different.push({ ref: mine.ref, amount_halalas: p.amountHalalas, created_at: `ours ${formatSAR(mine.amount)} SAR` });
      }
    }
  } catch (err) {
    console.error("[reconcile] could not compare with StreamPay", err);
  }
  return { unknown, different };
}

/** Mail the owner the problem list. Silent when there is nothing to say. */
export async function reportPaymentProblems(): Promise<number> {
  const gateway = await compareWithGateway();
  const p = await paymentProblems();
  const sections: [string, Problem[]][] = [
    ["Paid, booking not confirmed, not refunded — refund in StreamPay", p.owedBookings],
    ["Paid, nothing delivered, not refunded — refund in StreamPay", p.undelivered],
    ["No answer from StreamPay for over an hour — check in StreamPay", p.stuck],
    ["Paid twice for one booking (this is the older payment) — refund it in StreamPay", p.oldAttempts],
    ["Chair purchase not delivered, owed as credit — give it at her next visit", p.owedCredit],
    ["Paid at StreamPay, not recorded by us — check it in StreamPay", gateway.unknown],
    ["StreamPay has a different amount than we recorded", gateway.different],
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
