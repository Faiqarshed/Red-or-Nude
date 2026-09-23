// "Did it go through?" — asked by a checkout page once StreamPay's embedded
// form hands control back, and polled while the answer is still `pending`.
//
// Settles as a side effect: if the webhook has not arrived yet, this asks
// StreamPay directly and confirms the booking or delivers the purchase itself.
//
// The ref is a random uuid only the paying browser was given, so it is the
// credential here — the same bearer model as a booking code, and far longer.

import { NextResponse } from "next/server";
import { z } from "zod";
import { settlePayment, type Settled } from "@/lib/payments/settle";
import { clientIp, throttled } from "@/lib/throttle";

/**
 * The last answer per payment, reused for a few seconds. Every open checkout
 * asks every 3 s and each unpaid ask can cost three StreamPay calls; enough of
 * them and StreamPay throttles us — for every customer at once.
 * ponytail: per server instance.
 */
const recent = new Map<string, { at: number; answer: Settled }>();
const REUSE_MS = 5_000;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // A page polls about 20 times a minute; three open tabs is still well inside.
  if (throttled(`pay-status:${clientIp(request)}`, { max: 60 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }
  const ref = z.string().uuid().safeParse(new URL(request.url).searchParams.get("ref"));
  if (!ref.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const hit = recent.get(ref.data);
  if (hit && Date.now() - hit.at < REUSE_MS) return NextResponse.json(hit.answer);
  const answer = await settlePayment(ref.data);
  // Only an undecided answer is worth reusing; a decided one is cheap to read again.
  if (answer.status === "pending") recent.set(ref.data, { at: Date.now(), answer });
  else recent.delete(ref.data);
  if (recent.size > 5_000) recent.clear();
  return NextResponse.json(answer);
}
