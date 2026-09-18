// What a reward is worth — for display only (brief §2.8).
//
// The sibling of ../../promo/quote/route.ts, and the same disclaimer applies:
// this decides nothing. POST /api/bookings re-reads the balance and re-prices
// the rung against totals it computed from the catalogue itself, and that is
// what gets charged. The amount posted here is whatever the browser thinks the
// bill is, which is exactly as trustworthy as it sounds.
//
// The customer is resolved from the session cookie and **never from the body**.
// A customer id in a request is a customer id someone can change, and the thing
// on the other side of it is a wallet.

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentCustomer } from "@/lib/account/guard";
import { loyaltyBalance, loyaltyRules, quoteReward } from "@/lib/loyalty";

export const dynamic = "force-dynamic";

const body = z.object({
  /** How many points to spend. Validated against the step and the balance in
   *  quoteReward, not merely against being a positive number here. */
  points: z.number().int().positive(),
  /** The bill as the checkout currently shows it, in halalas. */
  totalHalalas: z.number().int().min(0).max(100_000_00),
});

export async function GET() {
  // Where the customer stands, **and the rules themselves**.
  //
  // The rules used to be a module constant the checkout imported directly, so
  // this only had to send a balance. They are four settings rows now — the
  // salon retunes them without a deploy — and the checkout cannot read the
  // database, so they come over the wire. The functions that price them are
  // still imported directly from lib/rewards.ts, which is what keeps the figure
  // shown and the figure charged computed the same way.
  //
  // None of it is a secret: it is the offer, and it is printed on the page.
  const customer = await currentCustomer();
  const [rules, balance] = await Promise.all([
    loyaltyRules(),
    customer ? loyaltyBalance(customer.id) : Promise.resolve(0),
  ]);
  return NextResponse.json({ balance, signedIn: Boolean(customer), rules });
}

export async function POST(request: Request) {
  const customer = await currentCustomer();
  // Not throttled by IP the way the promo route is: this needs a valid session
  // cookie, which is a far better rate limit than an address, and a customer
  // asking about their own balance repeatedly is not an attack.
  if (!customer) return NextResponse.json({ error: "signed-out" }, { status: 401 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const quote = await quoteReward(customer.id, parsed.data.points, parsed.data.totalHalalas);

  if (!quote.ok) {
    // 200 for the same reason the promo route uses one: the request was fine
    // and the answer is "you can't spend that yet".
    return NextResponse.json({ ok: false, reason: quote.reason, balance: quote.balance });
  }

  return NextResponse.json({
    ok: true,
    points: quote.points,
    valueHalalas: quote.valueHalalas,
    discountHalalas: quote.discountHalalas,
    totalHalalas: parsed.data.totalHalalas - quote.discountHalalas,
  });
}
