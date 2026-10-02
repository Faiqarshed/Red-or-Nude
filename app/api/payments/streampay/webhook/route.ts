// StreamPay's webhook — the safety net for a customer who paid and closed the
// tab before our return page loaded. Without it her money arrives and her hold
// is swept anyway.
//
// The body is only a nudge. Its signature is checked, but the verdict still
// comes from asking StreamPay about the payment (lib/payments/settle.ts), so a
// forged or replayed delivery can at most make us look something up.
//
// No queue: StreamPay retries a failed delivery five times (after 5 min, 30 min,
// 2 h, 6 h and 12 h), which covers a slow or failed handler. Do the work, answer
// 200 — or 503 when StreamPay itself could not tell us what happened, so it asks
// again later.
//
// Events to register in their dashboard: PAYMENT_SUCCEEDED, PAYMENT_MARKED_AS_PAID,
// PAYMENT_REFUNDED, PAYMENT_PARTIALLY_REFUNDED. There is no chargeback event;
// the daily recheck against StreamPay covers those.

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { mergeRaw } from "@/lib/payments";
import { refundedOutside } from "@/lib/payments/refund";
import { alertOwner } from "@/lib/payments/alert";
import { logPaymentEvent } from "@/lib/payments/events";
import { verifyWebhookSignature } from "@/lib/payments/streampay";
import { refForLink, revivePayment, settlePayment } from "@/lib/payments/settle";

export const dynamic = "force-dynamic";
// The receipt it may send waits up to 20 s for StreamPay's invoice PDF.
export const maxDuration = 60;

const HANDLED = new Set(["PAYMENT_SUCCEEDED", "PAYMENT_MARKED_AS_PAID", "PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED"]);

type Event = {
  event_type?: string;
  data?: { metadata?: { ref?: string } | null; payment_link?: { id?: string } | null };
};

export async function POST(request: Request) {
  const raw = await request.text();
  if (process.env.STREAMPAY_DEBUG === "1" && process.env.NODE_ENV !== "production") {
    console.log("[streampay:debug] webhook in", request.headers.get("x-webhook-event"), raw);
  }
  if (!verifyWebhookSignature(raw, request.headers.get("x-webhook-signature"))) {
    // A wrong or missing STREAMPAY_WEBHOOK_SECRET refuses every real delivery
    // as well as forged ones. Told once an hour (and logged), not per request,
    // so a flood of forgeries is one line.
    await alertOwner(
      "webhook-signature",
      "A StreamPay webhook was refused: bad signature",
      "If StreamPay's deliveries are failing, STREAMPAY_WEBHOOK_SECRET does not match the secret in their dashboard. " +
        "Payments still confirm through the checkout page and the settle job, only later.",
    );
    return NextResponse.json({ error: "bad-signature" }, { status: 401 });
  }

  let event: Event;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  // A failure needs nothing from us: the checkout stays open for another card,
  // and expiry is found by the next ask.
  const type = event.event_type ?? "";
  const linkId = event.data?.payment_link?.id;
  const ref = event.data?.metadata?.ref ?? (linkId ? await refForLink(linkId) : null);
  // Every signed delivery, handled or not, is on record.
  await logPaymentEvent("webhook", { event: type, linkId: linkId ?? null, handled: HANDLED.has(type) }, ref);
  if (!HANDLED.has(type)) return NextResponse.json({ ok: true });
  // Not one of ours — a payment taken on a link made by hand in their dashboard.
  if (!ref) return NextResponse.json({ ok: true });

  try {
    if (type === "PAYMENT_REFUNDED" || type === "PAYMENT_PARTIALLY_REFUNDED") {
      await refundedOutside(ref);
      return NextResponse.json({ ok: true });
    }

    // A checkout our server never finished saving (it died mid-charge) has no
    // link on its row, and nothing could ask StreamPay about it. The event has it.
    if (linkId) {
      await db
        .update(payments)
        .set({ raw: mergeRaw(payments.raw, { linkId }) })
        .where(sql`${payments.providerRef} = ${ref} and ${payments.raw} ->> 'linkId' is null`);
    }

    // Already marked failed, and StreamPay says it succeeded: the money came in
    // after we wrote it off. Revived now rather than at the next job run. Asked
    // first: settle would answer a failed row with the tickets of the attempt
    // that did confirm her, and this money would go unnoticed.
    if (await revivePayment(ref)) return NextResponse.json({ ok: true, status: "revived" });

    const settled = await settlePayment(ref);
    if (settled.status === "pending" && settled.unverified) {
      return NextResponse.json({ error: "unverified" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, status: settled.status });
  } catch (err) {
    // Ours to fix, and theirs to retry: a 500 brings the delivery back later.
    console.error(`[streampay] webhook could not settle ${ref}`, err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
