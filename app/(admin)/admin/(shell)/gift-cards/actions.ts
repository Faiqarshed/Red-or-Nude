"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { giftCardDesigns, giftCardValues, giftCards } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { GIFT_OPTIONS_TAG } from "@/lib/catalog";
import { sarToHalalas } from "@/lib/money";
import { adjustGiftCardBalance, issueGiftCard } from "@/lib/giftcards";

export type Result = { ok: true; code?: string } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/admin/gift-cards");
  revalidatePath("/gift-card");
  revalidateTag(GIFT_OPTIONS_TAG);
}

const issueSchema = z.object({
  amountSar: z.coerce.number().min(1).max(20_000),
  designId: z.string().uuid().nullable().optional(),
  buyerName: z.string().trim().max(120).optional(),
  buyerEmail: z.string().email().optional().or(z.literal("")),
  recipientName: z.string().trim().max(120).optional(),
  recipientEmail: z.string().email().optional().or(z.literal("")),
  message: z.string().max(500).optional(),
  expiresInMonths: z.coerce.number().int().min(0).max(120).optional(),
});

export async function issueCard(input: z.input<typeof issueSchema>): Promise<Result> {
  const actor = await requireCan("giftcards.issue");
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;

  const result = await issueGiftCard({
    amountHalalas: sarToHalalas(d.amountSar),
    designId: d.designId ?? null,
    buyerName: d.buyerName || null,
    buyerEmail: d.buyerEmail || null,
    recipientName: d.recipientName || null,
    recipientEmail: d.recipientEmail || null,
    message: d.message || null,
    expiresInMonths: d.expiresInMonths || null,
    actorId: actor.id,
  });

  if (!result.ok) return { ok: false, error: result.error };

  await recordAudit(actor, {
    action: "create",
    entity: "gift_cards",
    entityId: result.id,
    diff: { amount: { from: null, to: d.amountSar } },
  });

  revalidate();
  return { ok: true, code: result.code };
}

const adjustSchema = z.object({
  id: z.string().uuid(),
  amountSar: z.coerce.number().refine((n) => n !== 0, "zero"),
  reason: z.string().trim().min(1).max(200),
});

export async function adjustCard(input: z.input<typeof adjustSchema>): Promise<Result> {
  // Issuing a card is a front-desk job; changing an existing balance is money
  // movement and needs the higher capability.
  const actor = await requireCan("giftcards.adjust");
  const parsed = adjustSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;

  const result = await adjustGiftCardBalance(
    d.id,
    sarToHalalas(d.amountSar),
    d.reason,
    actor.id,
  );
  if (!result.ok) return { ok: false, error: result.error };

  await recordAudit(actor, {
    action: "adjust",
    entity: "gift_cards",
    entityId: d.id,
    diff: { balance: { from: null, to: result.balanceHalalas } },
  });

  revalidate();
  return { ok: true };
}

export async function cancelCard(id: string): Promise<Result> {
  const actor = await requireCan("giftcards.adjust");
  await db
    .update(giftCards)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(giftCards.id, id));
  await recordAudit(actor, { action: "cancel", entity: "gift_cards", entityId: id });
  revalidate();
  return { ok: true };
}

// ---- setup: values and designs offered on the public page -------------------

export async function addGiftValue(amountSar: number): Promise<Result> {
  const actor = await requireCan("giftcards.adjust");
  if (!Number.isFinite(amountSar) || amountSar <= 0) return { ok: false, error: "invalid" };

  const [row] = await db
    .insert(giftCardValues)
    .values({ amountHalalas: sarToHalalas(amountSar), sort: 99 })
    .returning({ id: giftCardValues.id });

  await recordAudit(actor, { action: "create", entity: "gift_card_values", entityId: row.id });
  revalidate();
  return { ok: true };
}

export async function deleteGiftValue(id: string): Promise<Result> {
  const actor = await requireCan("giftcards.adjust");
  await db.delete(giftCardValues).where(eq(giftCardValues.id, id));
  await recordAudit(actor, { action: "delete", entity: "gift_card_values", entityId: id });
  revalidate();
  return { ok: true };
}

const designSchema = z.object({
  id: z.string().uuid().optional(),
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(120),
  image: z.string().max(400).nullable().optional(),
  active: z.boolean(),
});

export async function saveGiftDesign(input: z.input<typeof designSchema>): Promise<Result> {
  const actor = await requireCan("giftcards.adjust");
  const parsed = designSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;

  const values = {
    name: { ar: d.nameAr, en: d.nameEn },
    image: d.image ?? null,
    active: d.active,
    updatedAt: new Date(),
  };

  if (d.id) {
    await db.update(giftCardDesigns).set(values).where(eq(giftCardDesigns.id, d.id));
    await recordAudit(actor, { action: "update", entity: "gift_card_designs", entityId: d.id });
  } else {
    const [row] = await db
      .insert(giftCardDesigns)
      .values({ ...values, sort: 99 })
      .returning({ id: giftCardDesigns.id });
    await recordAudit(actor, { action: "create", entity: "gift_card_designs", entityId: row.id });
  }

  revalidate();
  return { ok: true };
}

export async function deleteGiftDesign(id: string): Promise<Result> {
  const actor = await requireCan("giftcards.adjust");
  try {
    await db.delete(giftCardDesigns).where(eq(giftCardDesigns.id, id));
  } catch {
    return { ok: false, error: "in-use" };
  }
  await recordAudit(actor, { action: "delete", entity: "gift_card_designs", entityId: id });
  revalidate();
  return { ok: true };
}
