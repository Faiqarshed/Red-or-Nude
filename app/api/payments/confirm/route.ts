// Charge for a held booking and confirm it.
//
// Split from POST /api/bookings on purpose: that one reserves the chair, this one
// takes the money. A decline leaves the hold in place so the customer can retry
// the payment without losing their slot.

import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmBookingPayment } from "@/lib/payments/confirm";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(4).max(20),
  method: z.enum(["card", "mada", "stc", "apple"]),
  // Only honoured outside production — the way to exercise a declined card
  // without teaching the driver about test amounts.
  simulate: z.literal("decline").optional(),
});

const STATUS = {
  "not-found": 404,
  expired: 409,
  "payment-declined": 402,
  failed: 500,
} as const;

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const result = await confirmBookingPayment({
    code: parsed.data.code,
    method: parsed.data.method,
    simulate: process.env.NODE_ENV === "production" ? undefined : parsed.data.simulate,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS[result.error] });
  }

  return NextResponse.json({ tickets: result.tickets, totalHalalas: result.totalHalalas });
}
