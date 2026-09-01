"use server";

// Catalog CRUD for the three priced tables. They share a shape, so they share
// one action set keyed by `kind` rather than three near-identical files.
//
// Every mutation: validate → requireCan → write → recordAudit → revalidate.
// The revalidate calls include the public routes, because these rows are what
// the customer-facing booking page now reads.

import { revalidatePath } from "next/cache";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { addons, designs, removalTypes, services } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { diffOf, recordAudit } from "@/lib/audit";
import { sarToHalalas } from "@/lib/money";

export type CatalogKind = "service" | "addon" | "removal";

const TABLES = {
  service: services,
  addon: addons,
  removal: removalTypes,
} as const;

const ENTITY: Record<CatalogKind, string> = {
  service: "services",
  addon: "addons",
  removal: "removal_types",
};

const localizedText = z.object({
  ar: z.string().trim().min(1).max(120),
  en: z.string().trim().min(1).max(120),
});

const itemSchema = z.object({
  kind: z.enum(["service", "addon", "removal"]),
  id: z.string().uuid().optional(),
  name: localizedText,
  description: z
    .object({ ar: z.string().trim().max(400), en: z.string().trim().max(400) })
    .optional(),
  // Entered in riyals; stored in halalas.
  priceSar: z.coerce.number().min(0).max(100_000),
  durationMin: z.coerce.number().int().min(0).max(600),
  // Services only. Zero is how the form's "has a refill" tick stores "no" —
  // one number rather than a boolean and a length that could contradict it.
  refillDays: z.coerce.number().int().min(0).max(365).optional(),
  image: z.string().max(400).nullable().optional(),
  isSeasonal: z.boolean().optional(),
  // Add-ons that offer a choice. Absent means "leave them alone" — an empty
  // array means "there are none", and the two must not be confused or every
  // save from a screen that does not edit them would wipe them.
  designs: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: localizedText,
        image: z.string().max(400).nullable().optional(),
      }),
    )
    .max(60)
    .optional(),
  active: z.boolean(),
  sort: z.coerce.number().int().min(0).max(9999),
});

export type CatalogInput = z.input<typeof itemSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

function revalidateAll() {
  revalidatePath("/admin/catalog");
  revalidatePath("/booking");
  revalidatePath("/");
}

/**
 * Make the add-on's design pictures match what the drawer was showing.
 *
 * Undefined means the caller was not editing them and they are left alone —
 * only an add-on that offers a picker sends this at all. An empty array is a
 * real answer, "there are none", and clears them.
 *
 * Rows keep their ids across a save so a booking that already points at a
 * design still points at the same one. Only the ones actually dropped from the
 * list are deleted, and `bookings.design_id` is `on delete set null`, so a
 * finished appointment loses the picture and nothing else.
 */
async function syncDesigns(
  addonId: string,
  wanted: { id?: string; name: { ar: string; en: string }; image?: string | null }[] | undefined,
): Promise<void> {
  if (!wanted) return;

  const keep = wanted.map((d) => d.id).filter(Boolean) as string[];
  await db
    .delete(designs)
    .where(
      keep.length
        ? and(eq(designs.addonId, addonId), notInArray(designs.id, keep))
        : eq(designs.addonId, addonId),
    );

  // Sequential rather than one statement: the list is a handful of rows typed
  // by hand, and the order they were dragged into is the order they render in.
  for (const [i, d] of wanted.entries()) {
    const row = { addonId, name: d.name, image: d.image ?? null, sort: i, updatedAt: new Date() };
    if (d.id) await db.update(designs).set(row).where(eq(designs.id, d.id));
    else await db.insert(designs).values(row);
  }
}

export async function saveCatalogItem(input: CatalogInput): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");

  const parsed = itemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  const data = parsed.data;
  const table = TABLES[data.kind];

  // Columns differ slightly per table — description and isSeasonal don't exist
  // everywhere, so build the payload per kind rather than casting it away.
  const common = {
    name: data.name,
    priceHalalas: sarToHalalas(data.priceSar),
    durationMin: data.durationMin,
    active: data.active,
    sort: data.sort,
    updatedAt: new Date(),
  };

  const values =
    data.kind === "service"
      ? {
          ...common,
          description: data.description ?? null,
          image: data.image ?? null,
          refillDays: data.refillDays ?? 0,
        }
      : data.kind === "addon"
        ? { ...common, image: data.image ?? null, isSeasonal: data.isSeasonal ?? false }
        : common;

  try {
    if (data.id) {
      const [before] = await db.select().from(table).where(eq(table.id, data.id)).limit(1);
      if (!before) return { ok: false, error: "not-found" };

      await db.update(table).set(values).where(eq(table.id, data.id));
      await syncDesigns(data.id, data.designs);
      await recordAudit(actor, {
        action: "update",
        entity: ENTITY[data.kind],
        entityId: data.id,
        diff: diffOf(before as Record<string, unknown>, values),
      });
      revalidateAll();
      return { ok: true, id: data.id };
    }

    const [row] = await db.insert(table).values(values).returning({ id: table.id });
    await syncDesigns(row.id, data.designs);
    await recordAudit(actor, {
      action: "create",
      entity: ENTITY[data.kind],
      entityId: row.id,
      diff: diffOf(null, values),
    });
    revalidateAll();
    return { ok: true, id: row.id };
  } catch (err) {
    console.error("[catalog] save failed", err);
    return { ok: false, error: "save-failed" };
  }
}

export async function setCatalogActive(
  kind: CatalogKind,
  id: string,
  active: boolean,
): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");
  const table = TABLES[kind];

  await db.update(table).set({ active, updatedAt: new Date() }).where(eq(table.id, id));
  await recordAudit(actor, {
    action: "update",
    entity: ENTITY[kind],
    entityId: id,
    diff: { active: { from: !active, to: active } },
  });
  revalidateAll();
  return { ok: true, id };
}

export async function deleteCatalogItem(kind: CatalogKind, id: string): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");
  const table = TABLES[kind];

  try {
    await db.delete(table).where(eq(table.id, id));
  } catch (err) {
    // services/removal_types are referenced by bookings with onDelete: restrict —
    // deleting one that has history would erase what a customer actually bought.
    // Deactivating is the right move there, and the UI says so.
    console.error("[catalog] delete blocked", err);
    return { ok: false, error: "in-use" };
  }

  await recordAudit(actor, { action: "delete", entity: ENTITY[kind], entityId: id });
  revalidateAll();
  return { ok: true, id };
}

/** Swap sort order with the neighbour in `direction`. Drives the up/down buttons. */
export async function moveCatalogItem(
  kind: CatalogKind,
  id: string,
  direction: "up" | "down",
): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");
  const table = TABLES[kind];

  const rows = await db
    .select({ id: table.id, sort: table.sort })
    .from(table)
    .orderBy(asc(table.sort), asc(table.id));

  const index = rows.findIndex((r) => r.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= rows.length) return { ok: true, id };

  // Rewrite the whole column so pre-existing duplicate sort values can't make
  // a swap a no-op.
  const reordered = [...rows];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  await db.transaction(async (tx) => {
    for (const [position, row] of reordered.entries()) {
      await tx.update(table).set({ sort: position }).where(eq(table.id, row.id));
    }
  });

  await recordAudit(actor, {
    action: "reorder",
    entity: ENTITY[kind],
    entityId: id,
    diff: { sort: { from: index, to: target } },
  });
  revalidateAll();
  return { ok: true, id };
}
