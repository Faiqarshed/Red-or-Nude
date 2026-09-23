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

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { emailField, nameField } from "@/lib/account/fields";
import { db } from "@/lib/db";
import { giftCardDesigns, giftCardValues, payments } from "@/lib/db/schema";
import { clientIp, throttled } from "@/lib/throttle";
import { startPurchase } from "@/lib/payments/purchase";
import { giftCardLine } from "@/lib/payments/lines";

export const dynamic = "force-dynamic";
// The receipt it may send waits up to 20 s for StreamPay's invoice PDF.
export const maxDuration = 60;

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
  /** This attempt, made by the page (lib/giftcard-selection.ts); see GiftIntent. */
  attemptId: z.string().uuid().optional(),
  /** Dev-only, to exercise the decline path. Stripped in production. */
  simulate: z.literal("decline").optional(),
});

/**
 * New gift card checkouts allowed per IP, and per buyer email, in an hour.
 *
 * The page needs no account and a card is worth money the moment it is issued,
 * which is what people testing stolen cards look for: every decline they cause
 * counts against the salon's StreamPay account. A reload or a double tap resumes
 * the same checkout (attemptId), so it does not count as a new one.
 */
const GIFT_TRIES_PER_HOUR = 5;

export async function POST(request: Request) {
  const ip = clientIp(request);
  // Cheap first line, per server instance. The count below is the real limit.
  if (throttled(`gift-card:${ip}`, { windowMs: 3_600_000, max: GIFT_TRIES_PER_HOUR * 2 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

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

  // Counted in the database, so it holds across server instances.
  const email = d.buyerEmail?.trim().toLowerCase() || null;
  const [{ tries }] = await db
    .select({ tries: sql<number>`count(*)::int` })
    .from(payments)
    .where(
      sql`${payments.raw} -> 'intent' ->> 'kind' = 'gift_card'
        and ${payments.createdAt} > now() - interval '1 hour'
        and (${payments.raw} ->> 'ip' = ${ip}
          ${email ? sql`or lower(${payments.raw} -> 'intent' ->> 'buyerEmail') = ${email}` : sql``})`,
    );
  if (tries >= GIFT_TRIES_PER_HOUR) return NextResponse.json({ error: "too-many" }, { status: 429 });

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
      // Missing, the purchase simply never resumes an earlier checkout.
      attemptId: d.attemptId ?? randomUUID(),
    },
    amountHalalas: d.amountSar * 100,
    lines: [giftCardLine(d.amountSar)],
    title: "Gift card",
    back: "/gift-card/payment",
    ip,
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
