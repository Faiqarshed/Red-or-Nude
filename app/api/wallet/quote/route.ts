// What wallet credit and a gift card are worth at checkout — for display only
// (docs/WALLET-PLAN.md, step 4).
//
// The sibling of ../../loyalty/quote/route.ts, and the same disclaimer applies:
// this decides nothing. POST /api/bookings works the credit out again under the
// wallet's lock, claims the card there, and refuses when it differs from what
// the screen showed.
//
// Whose wallet is the session's, never the body's. A guest has proved no
// wallet, so she is told only what a card she typed would bring. GET is also
// the header's wallet menu, so signed in it carries the whole account view.

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentCustomer } from "@/lib/account/guard";
import { clientIp, throttled } from "@/lib/throttle";
import { accountWallet, giftCardValue } from "@/lib/wallet";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(1).max(40),
  /** The checkout's email. Ignored when signed in: the card must be hers. */
  email: z.string().trim().email().max(200).optional(),
});

export async function GET() {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ signedIn: false, available: 0 });
  return NextResponse.json({ signedIn: true, ...(await accountWallet(customer.email)) });
}

export async function POST(request: Request) {
  // Throttled like the promo route: a lookup that says what a code is worth is
  // one somebody could otherwise run through every code.
  if (throttled(`gift-card:${clientIp(request)}`, { max: 10 })) {
    return NextResponse.json({ error: "throttled" }, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const customer = await currentCustomer();
  const email = customer?.email ?? parsed.data.email;
  if (!email) return NextResponse.json({ ok: false, error: "gift-card-invalid" });

  // 200 either way, as the promo route: the request was fine, and the answer is
  // what the card brings or why it can't be used.
  return NextResponse.json(await giftCardValue(parsed.data.code, email, Boolean(customer)));
}
