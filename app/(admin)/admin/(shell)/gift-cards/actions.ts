"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { giftCardDesigns, giftCardValues, giftCards, media, type Localized } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { diffOf, recordAudit } from "@/lib/audit";
import { halalasToSar, sarToHalalas } from "@/lib/money";
import { adjustGiftCardBalance, issueGiftCard } from "@/lib/giftcards";
import { adminStrings } from "@/lib/admin/strings";
import {
  ADJUST_MAX,
  ADJUST_REASON_MAX,
  ADJUST_TEXT,
  blockedChar,
  checkNote,
  checkPersonName,
  EMAIL_RE,
  GIFT_MESSAGE_MAX,
  NAME_MAX,
  rules,
} from "@/lib/admin/validate";

export type Result = { ok: true; code?: string } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/admin/gift-cards");
  revalidatePath("/gift-card");
}

const v = adminStrings.en.validation;
// The drawer's rules, checked again: a real name if one is given, a real message.
const personName = z
  .string()
  .trim()
  .refine((s) => !s || !checkPersonName(v, "Name", s), "name")
  .optional();

const issueSchema = z.object({
  amountSar: z.coerce.number().int().min(1).max(ADJUST_MAX),
  designId: z.string().uuid().nullable().optional(),
  buyerName: personName,
  buyerEmail: z.string().trim().regex(EMAIL_RE).optional().or(z.literal("")),
  recipientName: personName,
  recipientEmail: z.string().trim().regex(EMAIL_RE).optional().or(z.literal("")),
  message: z
    .string()
    .trim()
    .refine((s) => !s || !checkNote(v, "Message", s, { max: GIFT_MESSAGE_MAX }), "message")
    .optional(),
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
  amountSar: z.coerce
    .number()
    .min(-ADJUST_MAX)
    .max(ADJUST_MAX)
    .refine((n) => n !== 0, "zero"),
  reason: z
    .string()
    .trim()
    .max(ADJUST_REASON_MAX)
    // The same reason check as the form: letters, no keyboard mash, no stray symbols.
    .refine(
      (s) => !rules(adminStrings.en.validation).text("Reason", s, { min: 3, script: "any" }) && !blockedChar(s, ADJUST_TEXT),
      "reason",
    ),
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
    // What moved and why, not just where the balance landed.
    diff: {
      amount: { from: null, to: d.amountSar },
      reason: { from: null, to: d.reason },
      balance: { from: null, to: result.balanceHalalas },
    },
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
  if (!Number.isInteger(amountSar) || amountSar <= 0 || amountSar > ADJUST_MAX) {
    return { ok: false, error: "invalid" };
  }
  const halalas = sarToHalalas(amountSar);
  const [dupe] = await db
    .select({ id: giftCardValues.id })
    .from(giftCardValues)
    .where(eq(giftCardValues.amountHalalas, halalas))
    .limit(1);
  if (dupe) return { ok: false, error: "duplicate" };

  const [row] = await db
    .insert(giftCardValues)
    .values({ amountHalalas: halalas, sort: 99 })
    .returning({ id: giftCardValues.id });

  await recordAudit(actor, { action: "create", entity: "gift_card_values", entityId: row.id, label: `${amountSar} SAR` });
  revalidate();
  return { ok: true };
}

export async function deleteGiftValue(id: string): Promise<Result> {
  const actor = await requireCan("giftcards.adjust");
  const [gone] = await db
    .delete(giftCardValues)
    .where(eq(giftCardValues.id, id))
    .returning({ amount: giftCardValues.amountHalalas });
  await recordAudit(actor, {
    action: "delete",
    entity: "gift_card_values",
    entityId: id,
    label: gone ? `${halalasToSar(gone.amount)} SAR` : null,
  });
  revalidate();
  return { ok: true };
}

const designSchema = z.object({
  id: z.string().uuid().optional(),
  nameAr: z.string().trim().min(1).max(NAME_MAX),
  nameEn: z.string().trim().min(1).max(NAME_MAX),
  image: z.string().min(1).max(400),
  active: z.boolean(),
});

export async function saveGiftDesign(input: z.input<typeof designSchema>): Promise<Result> {
  const actor = await requireCan("giftcards.adjust");
  const parsed = designSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;

  // Only a path the media library actually holds. A bare filename that isn't a
  // library row resolves to /uploads/<name> and renders as a broken image on
  // both this screen and the public gift card page.
  const [known] = await db.select({ id: media.id }).from(media).where(eq(media.path, d.image)).limit(1);
  if (!known) return { ok: false, error: "bad-image" };

  const values = {
    name: { ar: d.nameAr, en: d.nameEn },
    image: d.image,
    active: d.active,
    updatedAt: new Date(),
  };

  if (d.id) {
    const [before] = await db.select().from(giftCardDesigns).where(eq(giftCardDesigns.id, d.id)).limit(1);
    await db.update(giftCardDesigns).set(values).where(eq(giftCardDesigns.id, d.id));
    await recordAudit(actor, {
      action: "update",
      entity: "gift_card_designs",
      entityId: d.id,
      diff: diffOf(before, values),
    });
  } else {
    const [row] = await db
      .insert(giftCardDesigns)
      .values({ ...values, sort: 99 })
      .returning({ id: giftCardDesigns.id });
    await recordAudit(actor, { action: "create", entity: "gift_card_designs", entityId: row.id, diff: diffOf(null, values) });
  }

  revalidate();
  return { ok: true };
}

export async function deleteGiftDesign(id: string): Promise<Result> {
  const actor = await requireCan("giftcards.adjust");
  let gone: { name: Localized } | undefined;
  try {
    [gone] = await db.delete(giftCardDesigns).where(eq(giftCardDesigns.id, id)).returning({ name: giftCardDesigns.name });
  } catch {
    return { ok: false, error: "in-use" };
  }
  await recordAudit(actor, { action: "delete", entity: "gift_card_designs", entityId: id, label: gone?.name });
  revalidate();
  return { ok: true };
}
