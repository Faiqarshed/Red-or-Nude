"use server";

// Membership packs, from the admin side (docs/SCOPE-ENHANCEMENT.md §6).
//
// A pack is a catalogue row like a service is, so this sits under the same
// `catalog.manage` capability and keeps the same shape as the catalog actions
// next door — one save that replaces the whole thing, active as its own toggle,
// order as its own action.
//
// What is different is the lines: a pack is its services and their quantities,
// and a save rewrites them wholesale rather than diffing. Nothing downstream
// reads them after purchase — buyPack copies them into the ledger — so rewriting
// is safe in the one way that matters: it cannot change what somebody already
// bought.

import { revalidatePath } from "next/cache";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { packServices, packs } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { sarToHalalas } from "@/lib/money";

const localizedText = z.object({
  ar: z.string().trim().min(1).max(120),
  en: z.string().trim().min(1).max(120),
});

const packSchema = z.object({
  id: z.string().uuid().optional(),
  name: localizedText,
  description: z
    .object({ ar: z.string().trim().max(400), en: z.string().trim().max(400) })
    .optional(),
  priceSar: z.coerce.number().min(0).max(100_000),
  /** Three months is the client's answer; a pack may still differ. */
  validDays: z.coerce.number().int().min(1).max(730),
  image: z.string().max(400).nullable().optional(),
  active: z.boolean(),
  sort: z.coerce.number().int().min(0).max(9999),
  /**
   * What is in it. A quantity per service, because credits are not
   * interchangeable — see the note on pack_services in lib/db/schema.ts.
   */
  lines: z
    .array(z.object({ serviceId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(99) }))
    .min(1, "no-services")
    .max(30),
});

export type PackInput = z.input<typeof packSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

function revalidateAll() {
  revalidatePath("/admin/packs");
  revalidatePath("/packs");
  revalidatePath("/booking");
}

export async function savePack(input: PackInput): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");
  const parsed = packSchema.safeParse(input);
  if (!parsed.success) {
    const noServices = parsed.error.issues.some((i) => i.message === "no-services");
    return { ok: false, error: noServices ? "no-services" : "invalid" };
  }
  const d = parsed.data;

  // One service twice in one pack is two rows fighting over a primary key. The
  // last one typed wins, which is what the form's own list already shows.
  const lines = [...new Map(d.lines.map((l) => [l.serviceId, l])).values()];

  const values = {
    name: d.name,
    description: d.description ?? null,
    priceHalalas: sarToHalalas(d.priceSar),
    validDays: d.validDays,
    image: d.image ?? null,
    active: d.active,
    sort: d.sort,
    updatedAt: new Date(),
  };

  try {
    const id = await db.transaction(async (tx) => {
      let packId = d.id;

      if (packId) {
        const [before] = await tx.select().from(packs).where(eq(packs.id, packId)).limit(1);
        if (!before) throw new Error("not-found");
        await tx.update(packs).set(values).where(eq(packs.id, packId));
      } else {
        const [row] = await tx.insert(packs).values(values).returning({ id: packs.id });
        packId = row.id;
      }

      // Replaced rather than merged: the form is the whole truth about what is
      // in a pack, and a line removed there has to disappear here.
      await tx.delete(packServices).where(eq(packServices.packId, packId));
      await tx.insert(packServices).values(
        lines.map((l) => ({ packId: packId!, serviceId: l.serviceId, quantity: l.quantity })),
      );

      return packId;
    });

    await recordAudit(actor, {
      action: d.id ? "update" : "create",
      entity: "packs",
      entityId: id,
      diff: { priceHalalas: { from: null, to: values.priceHalalas }, lines: { from: null, to: lines.length } },
    });
    revalidateAll();
    return { ok: true, id };
  } catch (err) {
    if (err instanceof Error && err.message === "not-found") return { ok: false, error: "not-found" };
    console.error("[packs] save failed", err);
    return { ok: false, error: "save-failed" };
  }
}

export async function setPackActive(id: string, active: boolean): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");

  await db.update(packs).set({ active, updatedAt: new Date() }).where(eq(packs.id, id));
  await recordAudit(actor, {
    action: "update",
    entity: "packs",
    entityId: id,
    diff: { active: { from: !active, to: active } },
  });
  revalidateAll();
  return { ok: true, id };
}

/**
 * Delete a pack.
 *
 * Safe even after it has been sold: `customer_packs` snapshots the name and the
 * price and its `pack_id` goes null, and the credits themselves live in
 * `pack_txns` against the purchase. Removing a pack from the shelf therefore
 * takes nothing away from anyone who bought one — which is exactly why the
 * purchase snapshots rather than joins.
 *
 * And why there is nothing to catch here: `pack_services` cascades and
 * `customer_packs` sets null, so no foreign key can refuse this. The catalog
 * actions next door do guard their delete, because a service *is* restricted by
 * booking history.
 */
export async function deletePack(id: string): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");

  await db.delete(packs).where(eq(packs.id, id));
  await recordAudit(actor, { action: "delete", entity: "packs", entityId: id });
  revalidateAll();
  return { ok: true, id };
}

/** Swap sort order with the neighbour in `direction`. Drives the up/down buttons. */
export async function movePack(id: string, direction: "up" | "down"): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");

  const rows = await db
    .select({ id: packs.id, sort: packs.sort })
    .from(packs)
    .orderBy(asc(packs.sort), asc(packs.id));

  const index = rows.findIndex((r) => r.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= rows.length) return { ok: true, id };

  // Rewrite the whole column so pre-existing duplicate sort values can't make a
  // swap a no-op. Same reasoning as moveCatalogItem.
  const reordered = [...rows];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  await db.transaction(async (tx) => {
    for (const [position, row] of reordered.entries()) {
      await tx.update(packs).set({ sort: position }).where(eq(packs.id, row.id));
    }
  });

  await recordAudit(actor, { action: "reorder", entity: "packs", entityId: id });
  revalidateAll();
  return { ok: true, id };
}
