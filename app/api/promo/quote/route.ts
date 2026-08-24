// What a discount code is worth — for display only (brief §2.10).
//
// This exists so the customer can see the code land before they hand over a
// card. It decides nothing: POST /api/bookings re-looks-up the same code and
// re-prices it against totals it computed from the catalogue itself, and that
// is the number charged. The amount posted here is whatever the browser says
// the bill is, which is exactly as trustworthy as it sounds — hence "preview".
//
// Throttled, because an unthrottled lookup that distinguishes "unknown" from
// "expired" is a way to enumerate the salon's unreleased campaign codes.

import { NextResponse } from "next/server";
import { z } from "zod";
import { quotePromo } from "@/lib/promo";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(1).max(40),
  /** The bill as the checkout currently shows it, in halalas. */
  totalHalalas: z.number().int().min(0).max(100_000_00),
});

export async function POST(request: Request) {
  if (throttled(`promo:${clientIp(request)}`, { max: 10 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const quote = await quotePromo(parsed.data.code, parsed.data.totalHalalas);

  if (!quote.ok) {
    // 200, not 4xx: the request was fine and the answer is "this code doesn't
    // apply". The checkout renders the reason either way, and a 4xx here would
    // show up as a network error in the console on every typo.
    return NextResponse.json({
      ok: false,
      reason: quote.reason,
      minTotalHalalas: quote.minTotalHalalas,
    });
  }

  return NextResponse.json({
    ok: true,
    code: quote.code,
    discountHalalas: quote.discountHalalas,
    totalHalalas: parsed.data.totalHalalas - quote.discountHalalas,
  });
}
