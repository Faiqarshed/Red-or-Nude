// Buying a membership pack (docs/SCOPE-ENHANCEMENT.md §6).
//
// Signed in only, and that is the feature rather than a restriction: the credits
// are held against a customer account, so there is nowhere to put them for a
// guest. The loyalty wallet works the same way and for the same reason.
//
// Order matters, exactly as it does for a gift card — money first, credits
// second. Credits granted before a declined charge are free appointments; a
// charge that clears and then fails to grant is a refund we can see in the log
// and settle, which is the recoverable direction.
//
// The price charged is read from the pack here, never taken from the request.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { packs, payments } from "@/lib/db/schema";
import { currentCustomer } from "@/lib/account/guard";
import { buyPack } from "@/lib/packs";
import { getDriver } from "@/lib/payments";

export const dynamic = "force-dynamic";

const body = z.object({
  packId: z.string().uuid(),
  method: z.enum(["card", "mada", "stc", "apple"]),
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

  const driver = getDriver();
  const ref = randomUUID();

  let charge;
  try {
    charge = await driver.charge({
      ref,
      // From the catalogue, never from the browser.
      amountHalalas: pack.priceHalalas,
      method: d.method,
      simulate: process.env.NODE_ENV === "production" ? undefined : d.simulate,
    });
  } catch (err) {
    console.error("[packs] charge threw", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }

  if (charge.status !== "paid") {
    return NextResponse.json({ error: "payment-declined" }, { status: 402 });
  }

  // From here on the money has moved. Every failure below gets its own code
  // rather than `failed`, because `failed` tells the screen a retry is safe, and
  // a retry now is a second charge. A throw counts too: an unhandled 500 reached
  // the screen as `failed` just the same.
  try {
    const bought = await buyPack(customer.id, pack.id);
    if (!bought.ok) {
      // Paid for, and she has nothing. Loud, because someone is owed a refund.
      console.error(`[packs] charged ${ref} but could not grant; refund owed`, bought.reason);
      return NextResponse.json({ error: "paid-not-granted" }, { status: 500 });
    }

    // The sale, recorded where every other sale is recorded.
    await db.insert(payments).values({
      customerPackId: bought.customerPackId,
      provider: driver.name,
      providerRef: charge.providerRef,
      method: d.method,
      amountHalalas: pack.priceHalalas,
      status: "paid",
      raw: charge.raw,
    });

    return NextResponse.json({ ok: true, customerPackId: bought.customerPackId });
  } catch (err) {
    console.error(`[packs] charged ${ref} but the grant or the sale row threw; check both`, err);
    return NextResponse.json({ error: "paid-not-granted" }, { status: 500 });
  }
}
