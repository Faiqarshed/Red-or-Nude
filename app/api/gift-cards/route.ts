// Public gift-card purchase.
//
// The charge is not decoration: without it this endpoint mints spendable balance
// to anyone who can POST to it. Same driver and the same `payments` row shape as
// a booking (lib/payments/), so gift-card revenue shows up in exactly the same
// place as every other sale.
//
// Nothing is issued here. The request is recorded against a pending payment and
// the card is issued once that payment is verified (lib/payments/purchase.ts) —
// on the spot with the fake driver, after the embedded checkout with StreamPay.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { emailField, nameField } from "@/lib/account/fields";
import { db } from "@/lib/db";
import { giftCardDesigns, giftCardValues } from "@/lib/db/schema";
import { startPurchase } from "@/lib/payments/purchase";
import { giftCardLine } from "@/lib/payments/lines";

export const dynamic = "force-dynamic";

const body = z.object({
  // Whole riyals, and one of the salon's active amounts (checked below).
  amountSar: z.coerce.number().int().positive(),
  designId: z.string().uuid().nullable().optional(),
  // The builder's own checks (lib/account/fields.ts), so the page and the API agree.
  buyerName: nameField.optional().or(z.literal("")),
  buyerEmail: emailField.optional().or(z.literal("")),
  recipientName: nameField,
  recipientEmail: emailField.optional().or(z.literal("")),
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

  // Only the amounts the salon sells (/admin/gift-cards). There is no custom
  // amount: each amount is its own StreamPay product, see giftCardLine.
  const [value] = await db
    .select({ id: giftCardValues.id })
    .from(giftCardValues)
    .where(and(eq(giftCardValues.amountHalalas, d.amountSar * 100), eq(giftCardValues.active, true)))
    .limit(1);
  if (!value) return NextResponse.json({ error: "invalid-amount" }, { status: 400 });

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

  const result = await startPurchase({
    intent: {
      kind: "gift_card",
      amountSar: d.amountSar,
      designId,
      buyerName: d.buyerName || null,
      buyerEmail: d.buyerEmail || null,
      recipientName: d.recipientName || null,
      recipientEmail: d.recipientEmail || null,
      message: d.message || null,
      lang: d.lang ?? "ar",
    },
    amountHalalas: d.amountSar * 100,
    lines: [giftCardLine(d.amountSar)],
    title: "Gift card",
    back: "/gift-card/payment",
    payer: { name: d.buyerName || null, email: d.buyerEmail || null },
    simulate: d.simulate,
  });

  if (!result.ok) {
    const status = result.error === "payment-declined" ? 402 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  if ("checkout" in result) return NextResponse.json({ checkout: result.checkout });
  if (result.delivered.kind !== "gift_card") return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.json({ code: result.delivered.code }, { status: 201 });
}
