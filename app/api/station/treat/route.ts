// Ordering a treat from the chair (brief §2.7).
//
// The rules live in lib/station-treat.ts so they can be asserted without a
// route; this is the trust boundary and nothing else. Every field is parsed
// before it reaches the database, and the reply says only whether it worked —
// the QR token proves presence at a table, which is not a reason to hand out
// anything about the booking sitting at it.

import { NextResponse } from "next/server";
import { z } from "zod";
import { buyStationItems, type TreatRefusal } from "@/lib/station-treat";

export const dynamic = "force-dynamic";
// The receipt it may send waits up to 20 s for StreamPay's invoice PDF.
export const maxDuration = 60;

const body = z.object({
  /** The sticker. A uuid column, so anything else cannot match a chair. */
  token: z.string().uuid(),
  /** A basket: treats and add-ons for the visit in progress, paid once. */
  addonIds: z.array(z.string().uuid()).min(1).max(20),
  /** Dev-only, to exercise the decline path. Stripped in production below. */
  simulate: z.literal("decline").optional(),
});

/** What each refusal means to the caller, and how hard it is to retry. */
const STATUS: Record<TreatRefusal, number> = {
  "unknown-station": 404,
  "not-in-service": 409,
  "unknown-treat": 404,
  "already-added": 409,
  "no-time": 409,
  declined: 402,
  // Charged and not delivered. A 500 so nothing treats it as retryable.
  "paid-not-added": 500,
};

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const result = await buyStationItems({
    token: d.token,
    addonIds: d.addonIds,
    simulate: d.simulate,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: STATUS[result.reason] });
  }
  if ("checkout" in result) return NextResponse.json({ ok: true, checkout: result.checkout });
  return NextResponse.json({ ok: true, names: result.names });
}
