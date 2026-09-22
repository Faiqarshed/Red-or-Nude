// StreamPay's webhook — the safety net for a customer who paid and closed the
// tab before our return page loaded. Without it her money arrives and her hold
// is swept anyway.
//
// The body is only a nudge. Its signature is checked, but the verdict still
// comes from asking StreamPay about the payment (lib/payments/settle.ts), so a
// forged or replayed delivery can at most make us look something up.
//
// No queue: StreamPay retries a failed delivery five times over about a day,
// which covers a slow or failed handler. Do the work, answer 200.

import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/payments/streampay";
import { refForLink, settlePayment } from "@/lib/payments/settle";

export const dynamic = "force-dynamic";

type Event = {
  event_type?: string;
  data?: { metadata?: { ref?: string } | null; payment_link?: { id?: string } | null };
};

export async function POST(request: Request) {
  const raw = await request.text();
  if (process.env.STREAMPAY_DEBUG === "1") {
    console.log("[streampay:debug] webhook in", request.headers.get("x-webhook-event"), raw);
  }
  if (!verifyWebhookSignature(raw, request.headers.get("x-webhook-signature"))) {
    return NextResponse.json({ error: "bad-signature" }, { status: 401 });
  }

  let event: Event;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  // Only a success can move anything. A failure needs nothing from us: the
  // checkout stays open for another card, and expiry is found by the next ask.
  if (event.event_type !== "PAYMENT_SUCCEEDED") return NextResponse.json({ ok: true });

  const linkId = event.data?.payment_link?.id;
  const ref = event.data?.metadata?.ref ?? (linkId ? await refForLink(linkId) : null);
  // Not one of ours — a payment taken on a link made by hand in their dashboard.
  if (!ref) return NextResponse.json({ ok: true });

  try {
    const settled = await settlePayment(ref);
    return NextResponse.json({ ok: true, status: settled.status });
  } catch (err) {
    // Ours to fix, and theirs to retry: a 500 brings the delivery back later.
    console.error(`[streampay] webhook could not settle ${ref}`, err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
