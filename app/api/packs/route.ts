// Buying a membership pack (docs/SCOPE-ENHANCEMENT.md §6).
//
// Signed in only, and that is the feature rather than a restriction: the credits
// are held against a customer account, so there is nowhere to put them for a
// guest. The loyalty wallet works the same way and for the same reason.
//
// Credits are granted only once the payment is verified (lib/payments/purchase.ts).
// The price charged is read from the pack here, never taken from the request.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { packs } from "@/lib/db/schema";
import { currentCustomer } from "@/lib/account/guard";
import { startPurchase } from "@/lib/payments/purchase";
import { productName } from "@/lib/payments/lines";

export const dynamic = "force-dynamic";
// The receipt it may send waits up to 20 s for StreamPay's invoice PDF.
export const maxDuration = 60;

const body = z.object({
  packId: z.string().uuid(),
  /** Dev-only, to exercise the decline path. Stripped in production. */
  simulate: z.literal("decline").optional(),
});

export async function POST(request: Request) {
  // No account, no pack. Nothing to hold the credits against.
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "signed-out" }, { status: 401 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const [pack] = await db
    .select()
    .from(packs)
    .where(and(eq(packs.id, d.packId), eq(packs.active, true)))
    .limit(1);
  if (!pack) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const result = await startPurchase({
    intent: { kind: "pack", customerId: customer.id, packId: pack.id },
    // From the catalogue, never from the browser.
    amountHalalas: pack.priceHalalas,
    lines: [{ key: `product:pack:${pack.id}`, name: productName(pack.name), priceHalalas: pack.priceHalalas, qty: 1 }],
    title: "Membership",
    payer: { name: customer.name, phone: customer.phone, email: customer.email, customerId: customer.id },
    back: `/memberships/payment?pack=${pack.id}`,
    simulate: d.simulate,
  });

  if (!result.ok) {
    // `not-delivered` is paid-and-refunded; kept as its own code because the
    // screen must not offer a retry that reads like nothing happened.
    const error = result.error === "not-delivered" ? "paid-not-granted" : result.error;
    const status = result.error === "payment-declined" ? 402 : 500;
    return NextResponse.json({ error }, { status });
  }
  if ("checkout" in result) return NextResponse.json({ checkout: result.checkout });
  if (result.delivered.kind !== "pack") return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.json({ ok: true, customerPackId: result.delivered.customerPackId });
}
