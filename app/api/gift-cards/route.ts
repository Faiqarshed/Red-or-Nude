// Public gift-card purchase. Charges for the card, then issues it.
//
// The charge is not decoration: without it this endpoint mints spendable balance
// to anyone who can POST to it. Same driver and the same `payments` row shape as
// a booking (lib/payments/), so gift-card revenue shows up in exactly the same
// place as every other sale.
//
// Order matters — money first, card second. A card issued before a declined
// charge is free money; a charge that succeeds and then fails to issue is a
// refund we can see in the log and settle, which is the recoverable direction.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { giftCardDesigns, payments } from "@/lib/db/schema";
import { issueGiftCard } from "@/lib/giftcards";
import { notify } from "@/lib/notify";
import { getDriver } from "@/lib/payments";
import { sarToHalalas } from "@/lib/money";

export const dynamic = "force-dynamic";

const body = z.object({
  // The preset denominations live in gift_card_values and are admin-managed, but
  // the builder also offers a custom amount, so the bound is what's enforced.
  amountSar: z.coerce.number().min(50).max(2000),
  designId: z.string().uuid().nullable().optional(),
  method: z.enum(["card", "mada", "stc", "apple"]),
  buyerName: z.string().trim().max(120).optional(),
  buyerEmail: z.string().trim().email().optional().or(z.literal("")),
  recipientName: z.string().trim().max(120).optional(),
  recipientEmail: z.string().trim().email().optional().or(z.literal("")),
  recipientPhone: z
    .string()
    .trim()
    .regex(/^(\+?966|0)?5\d{8}$/, "invalid-phone")
    .optional()
    .or(z.literal("")),
  message: z.string().max(500).optional(),
  lang: z.enum(["ar", "en"]).optional(),
  /** Dev-only, to exercise the decline path. Stripped in production. */
  simulate: z.literal("decline").optional(),
});

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }
  const d = parsed.data;

  // Nobody to give it to.
  if (!d.recipientEmail && !d.recipientPhone) {
    return NextResponse.json({ error: "no-recipient" }, { status: 400 });
  }

  // Only offer designs the salon has actually published.
  let designId: string | null = null;
  if (d.designId) {
    const [design] = await db
      .select({ id: giftCardDesigns.id })
      .from(giftCardDesigns)
      .where(and(eq(giftCardDesigns.id, d.designId), eq(giftCardDesigns.active, true)))
      .limit(1);
    designId = design?.id ?? null;
  }

  const amountHalalas = sarToHalalas(d.amountSar);
  const driver = getDriver();
  const ref = randomUUID();

  let charge;
  try {
    charge = await driver.charge({
      ref,
      amountHalalas,
      method: d.method,
      simulate: process.env.NODE_ENV === "production" ? undefined : d.simulate,
    });
  } catch (err) {
    console.error("[giftcards] charge threw", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }

  if (charge.status !== "paid") {
    return NextResponse.json({ error: "payment-declined" }, { status: 402 });
  }

  const result = await issueGiftCard({
    amountHalalas,
    designId,
    buyerName: d.buyerName || null,
    buyerEmail: d.buyerEmail || null,
    recipientName: d.recipientName || null,
    recipientEmail: d.recipientEmail || null,
    recipientPhone: d.recipientPhone || null,
    message: d.message || null,
    expiresInMonths: 12,
  });

  if (!result.ok) {
    // Paid for, but no card exists. Loud, because someone is owed a refund.
    console.error(`[giftcards] charged ${ref} but could not issue; refund owed`, result.error);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }

  // The sale, recorded where every other sale is recorded.
  await db.insert(payments).values({
    giftCardId: result.id,
    provider: driver.name,
    providerRef: charge.providerRef,
    method: d.method,
    amountHalalas,
    status: "paid",
    raw: charge.raw,
  });

  // Delivery. The buyer still gets a WhatsApp share button on the success
  // screen — this is the automatic half, and it's a no-op until a driver exists.
  const lang = d.lang ?? "ar";
  const data = {
    code: result.code,
    amountSar: d.amountSar,
    senderName: d.buyerName ?? null,
    recipientName: d.recipientName ?? null,
    message: d.message ?? null,
    cardUrl: `/gift/${result.code}`,
  };
  if (d.recipientEmail) {
    await notify({ channel: "email", to: d.recipientEmail, template: "gift-card", lang, data });
  }
  if (d.recipientPhone) {
    await notify({ channel: "whatsapp", to: d.recipientPhone, template: "gift-card", lang, data });
  }

  return NextResponse.json({ id: result.id, code: result.code }, { status: 201 });
}
