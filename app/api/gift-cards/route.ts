// Public gift-card purchase. Issues a real card with a redeemable code.
// Payment itself is still a stub — a gateway lands with the payments phase.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { giftCardDesigns } from "@/lib/db/schema";
import { issueGiftCard } from "@/lib/giftcards";
import { sarToHalalas } from "@/lib/money";

export const dynamic = "force-dynamic";

const body = z.object({
  amountSar: z.coerce.number().min(50).max(2000),
  designId: z.string().uuid().nullable().optional(),
  buyerName: z.string().trim().max(120).optional(),
  recipientName: z.string().trim().max(120).optional(),
  recipientEmail: z.string().email().optional().or(z.literal("")),
  message: z.string().max(500).optional(),
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

  const result = await issueGiftCard({
    amountHalalas: sarToHalalas(d.amountSar),
    designId,
    buyerName: d.buyerName || null,
    recipientName: d.recipientName || null,
    recipientEmail: d.recipientEmail || null,
    message: d.message || null,
    expiresInMonths: 12,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ id: result.id, code: result.code }, { status: 201 });
}
