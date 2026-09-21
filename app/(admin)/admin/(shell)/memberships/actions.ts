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
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { packServices, packs } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { diffOf, recordAudit } from "@/lib/audit";
import { sarToHalalas } from "@/lib/money";
import { reorderBySort } from "@/lib/admin/reorder";
import { DESC_MAX, NAME_MAX } from "@/lib/admin/validate";
import { setProductActive, syncProductQuietly } from "@/lib/payments/streampay";
import { productName } from "@/lib/payments/lines";

/** Mirror a saved pack to StreamPay. Never fails the save — see syncProductQuietly. */
async function syncToStreampay(id: string) {
  const [row] = await db
    .select({ name: packs.name, priceHalalas: packs.priceHalalas, active: packs.active })
    .from(packs)
    .where(eq(packs.id, id))
    .limit(1);
  if (row) await syncProductQuietly(`product:pack:${id}`, { ...row, name: productName(row.name) });
}

const localizedText = z.object({
  ar: z.string().trim().min(1).max(NAME_MAX),
  en: z.string().trim().min(1).max(NAME_MAX),
});

const packSchema = z.object({
  id: z.string().uuid().optional(),
  name: localizedText,
  description: z
    .object({ ar: z.string().trim().max(DESC_MAX), en: z.string().trim().max(DESC_MAX) })
    .optional(),
  // Above zero: a free pack would hand out service credits through checkout.
  priceSar: z.coerce.number().positive().max(100_000),
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
  revalidatePath("/admin/memberships");
  revalidatePath("/memberships");
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

  // What it was, for the audit below. Kept rather than discarded: a log that
  // records only the new price cannot answer "what did this pack cost last
  // week?", which is the one question anybody opens it for.
  let before: Record<string, unknown> | null = null;

  try {
    const id = await db.transaction(async (tx) => {
      let packId = d.id;

      if (packId) {
        const [row] = await tx.select().from(packs).where(eq(packs.id, packId)).limit(1);
        if (!row) throw new Error("not-found");
        const had = await tx.select().from(packServices).where(eq(packServices.packId, packId));
        before = { ...row, lines: had.length };
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
      diff: diffOf(before, { ...values, lines: lines.length }),
    });
    await syncToStreampay(id);
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
  await syncToStreampay(id);
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

  const [gone] = await db.delete(packs).where(eq(packs.id, id)).returning({ name: packs.name });
  await recordAudit(actor, { action: "delete", entity: "packs", entityId: id, label: gone?.name });
  // Archived there rather than deleted: past invoices still name it.
  await setProductActive(`product:pack:${id}`, false);
  revalidateAll();
  return { ok: true, id };
}

/** Swap sort order with the neighbour in `direction`. Drives the up/down buttons. */
export async function movePack(id: string, direction: "up" | "down"): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");

  const moved = await reorderBySort(packs, id, direction);
  if (!moved) return { ok: true, id };

  await recordAudit(actor, {
    action: "reorder",
    entity: "packs",
    entityId: id,
    diff: { sort: { from: moved.from, to: moved.to } },
  });
  revalidateAll();
  return { ok: true, id };
}
