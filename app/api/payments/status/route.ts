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
import { settlePayment } from "@/lib/payments/settle";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ref = z.string().uuid().safeParse(new URL(request.url).searchParams.get("ref"));
  if (!ref.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  return NextResponse.json(await settlePayment(ref.data));
}
