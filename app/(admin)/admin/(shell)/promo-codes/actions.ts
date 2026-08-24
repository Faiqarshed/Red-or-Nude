"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { promoCodes } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { sarToHalalas } from "@/lib/money";
import { normalizePromoCode } from "@/lib/promo";

export type Result = { ok: true } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/admin/promo-codes");
}

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  // Letters and digits only: these get read out over the phone and printed on
  // posters, and a code with a space or a dash in it is a support call.
  code: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[A-Za-z0-9]+$/, "code-format"),
  type: z.enum(["percent", "fixed"]),
  /** Percent points, or riyals when fixed — converted to halalas below. */
  value: z.coerce.number().positive().max(100_000),
  minTotalSar: z.coerce.number().min(0).max(100_000).default(0),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  maxUses: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  active: z.boolean(),
});

export type PromoInput = z.input<typeof saveSchema>;

/**
 * Create or edit a code. Money-adjacent, so every write leaves an audit row —
 * "who made a 90% code" is a question someone will eventually ask.
 *
 * Editing a live code changes what *future* bookings get and nothing else: the
 * discount already given is frozen in `bookings.discount_halalas`, so raising or
 * lowering a percentage never rewrites what a customer was charged last week.
 */
export async function savePromoCode(input: PromoInput): Promise<Result> {
  const actor = await requireCan("marketing.manage");
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  const d = parsed.data;

  if (d.type === "percent" && d.value > 100) return { ok: false, error: "percent-range" };

  const startsAt = d.startsAt ? new Date(d.startsAt) : null;
  const endsAt = d.endsAt ? new Date(d.endsAt) : null;
  // A window that closes before it opens accepts nothing — better refused here
  // than debugged later as "the code doesn't work".
  if (startsAt && endsAt && endsAt <= startsAt) return { ok: false, error: "bad-window" };

  const values = {
    code: normalizePromoCode(d.code),
    type: d.type,
    // Percent stays percent points; a fixed amount is entered in riyals and
    // stored in halalas like every other amount in the schema.
    value: d.type === "percent" ? Math.round(d.value) : sarToHalalas(d.value),
    minTotalHalalas: sarToHalalas(d.minTotalSar),
    startsAt,
    endsAt,
    maxUses: d.maxUses ?? null,
    active: d.active,
    updatedAt: new Date(),
  };

  try {
    if (d.id) {
      const [before] = await db
        .select()
        .from(promoCodes)
        .where(eq(promoCodes.id, d.id))
        .limit(1);
      if (!before) return { ok: false, error: "not-found" };

      await db.update(promoCodes).set(values).where(eq(promoCodes.id, d.id));
      await recordAudit(actor, {
        action: "update",
        entity: "promo_codes",
        entityId: d.id,
        diff: {
          code: { from: before.code, to: values.code },
          value: { from: before.value, to: values.value },
          active: { from: before.active, to: values.active },
        },
      });
    } else {
      const [row] = await db
        .insert(promoCodes)
        .values(values)
        .returning({ id: promoCodes.id });
      await recordAudit(actor, {
        action: "create",
        entity: "promo_codes",
        entityId: row.id,
        diff: { code: { from: null, to: values.code } },
      });
    }
  } catch (err) {
    // The unique index on `code` is the only thing that can realistically fail
    // here, and "that code already exists" is something the form can act on.
    if (err instanceof Error && err.message.includes("promo_codes_code_unique")) {
      return { ok: false, error: "duplicate" };
    }
    console.error("[promo] save failed", err);
    return { ok: false, error: "failed" };
  }

  revalidate();
  return { ok: true };
}

/**
 * Switch a code off. Deliberately not a delete: bookings point at it, the
 * invoice names it, and `uses` is the record of a campaign that happened.
 */
export async function setPromoActive(id: string, active: boolean): Promise<Result> {
  const actor = await requireCan("marketing.manage");

  const [row] = await db
    .update(promoCodes)
    .set({ active, updatedAt: new Date() })
    .where(eq(promoCodes.id, id))
    .returning({ id: promoCodes.id });
  if (!row) return { ok: false, error: "not-found" };

  await recordAudit(actor, {
    action: active ? "update" : "deactivate",
    entity: "promo_codes",
    entityId: id,
    diff: { active: { from: !active, to: active } },
  });

  revalidate();
  return { ok: true };
}
