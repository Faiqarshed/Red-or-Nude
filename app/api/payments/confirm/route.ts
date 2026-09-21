// Pay for a held booking.
//
// Split from POST /api/bookings on purpose: that one reserves the chair, this one
// takes the money. A decline leaves the hold in place so the customer can retry
// the payment without losing their slot.
//
// Answers with the tickets when it is settled on the spot (the fake driver, a
// bill of zero), or with a checkout to embed. After that checkout, the page asks
// GET /api/payments/status — this route is never the one that learns it was paid.

import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmBookingPayment } from "@/lib/payments/confirm";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(4).max(20),
  // Honoured by the fake driver outside production only — the way to exercise a declined card
  // without teaching the driver about test amounts.
  simulate: z.literal("decline").optional(),
});

const STATUS = {
  "not-found": 404,
  expired: 409,
  // Another attempt already owns this party — the customer's other tab, or this
  // button a moment ago. 409 like `expired`, because both mean "the thing you
  // were looking at moved"; the body says which, and only this one is worth
  // waiting out rather than starting again.
  "in-progress": 409,
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
    simulate: parsed.data.simulate,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS[result.error] });
  }
  if ("checkout" in result) return NextResponse.json({ checkout: result.checkout });
  return NextResponse.json({ tickets: result.tickets, totalHalalas: result.totalHalalas });
}
