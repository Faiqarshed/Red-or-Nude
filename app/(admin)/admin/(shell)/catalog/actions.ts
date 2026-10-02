"use server";

// Catalog CRUD for the three priced tables. They share a shape, so they share
// one action set keyed by `kind` rather than three near-identical files.
//
// Every mutation: validate → requireCan → write → recordAudit → revalidate.
// The revalidate calls include the public routes, because these rows are what
// the customer-facing booking page now reads.

import { revalidatePath } from "next/cache";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { violatedConstraint } from "@/lib/db/errors";
import { addons, designs, removalTypes, services, type Localized } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { diffOf, recordAudit } from "@/lib/audit";
import { sarToHalalas } from "@/lib/money";
import { reorderBySort } from "@/lib/admin/reorder";
import { DESC_MAX, NAME_MAX } from "@/lib/admin/validate";
import { retireProduct, syncProductQuietly } from "@/lib/payments/streampay";
import { productName } from "@/lib/payments/lines";

/** The StreamPay product key for a catalogue row. Add-ons and upsells share a table. */
const productKey = (kind: CatalogKind, id: string) =>
  `product:${kind === "upsell" ? "addon" : kind}:${id}`;

/** Mirror a saved row to StreamPay. Never fails the save — see syncProductQuietly. */
async function syncToStreampay(kind: CatalogKind, id: string) {
  const table = TABLES[kind];
  const [row] = await db
    .select({ name: table.name, priceHalalas: table.priceHalalas, active: table.active })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (row) await syncProductQuietly(productKey(kind, id), { ...row, name: productName(row.name) });
}

/**
 * `upsell` is the coffee-and-cookie kind. Same `addons` table as `addon` — which
 * is what lets the booking engine price it with no new code — but a separate
 * kind here, because to the salon it is not an add-on: it is never offered
 * beside the services, only at checkout.
 */
export type CatalogKind = "service" | "addon" | "removal" | "upsell";

const TABLES = {
  service: services,
  addon: addons,
  removal: removalTypes,
  upsell: addons,
} as const;

const ENTITY: Record<CatalogKind, string> = {
  service: "services",
  addon: "addons",
  removal: "removal_types",
  upsell: "addons",
};

const localizedText = z.object({
  ar: z.string().trim().min(1).max(NAME_MAX),
  en: z.string().trim().min(1).max(NAME_MAX),
});

const itemSchema = z.object({
  kind: z.enum(["service", "addon", "removal", "upsell"]),
  id: z.string().uuid().optional(),
  name: localizedText,
  description: z
    .object({ ar: z.string().trim().max(DESC_MAX), en: z.string().trim().max(DESC_MAX) })
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
})
  // A zero-minute service books a slot that ends as it starts.
  .refine((d) => d.kind !== "service" || d.durationMin >= 5, {
    message: "service-duration",
    path: ["durationMin"],
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
        : data.kind === "upsell"
          ? {
              ...common,
              image: data.image ?? null,
              atCheckout: true,
              // Forced, not asked. A checkout upsell is picked after the chair
              // has been quoted, so any duration would move `ends_at` under a
              // booking that is already about to be held. The form does not
              // offer the field; this is what makes that a rule.
              durationMin: 0,
            }
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
      await syncToStreampay(data.kind, data.id);
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
    await syncToStreampay(data.kind, row.id);
    revalidateAll();
    return { ok: true, id: row.id };
  } catch (err) {
    if (isDuplicateName(err)) return { ok: false, error: "duplicate-name" };
    console.error("[catalog] save failed", err);
    return { ok: false, error: "save-failed" };
  }
}

/**
 * The `*_active_name_*_unique` indexes (drizzle/0025) refusing a second live
 * row under a name that is already taken.
 *
 * Matched on the index name rather than on SQLSTATE 23505: these tables carry
 * other unique constraints, and "that name is taken" is a different sentence
 * from "that save failed".
 */
function isDuplicateName(err: unknown): boolean {
  return /_active_name_(en|ar)_unique$/.test(violatedConstraint(err) ?? "");
}

export async function setCatalogActive(
  kind: CatalogKind,
  id: string,
  active: boolean,
): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");
  const table = TABLES[kind];

  // Switching one *on* is the other way to end up with two live rows under one
  // name — the drawer is not the only door — so the same refusal lands here.
  try {
    await db.update(table).set({ active, updatedAt: new Date() }).where(eq(table.id, id));
  } catch (err) {
    if (isDuplicateName(err)) return { ok: false, error: "duplicate-name" };
    console.error("[catalog] activate failed", err);
    return { ok: false, error: "save-failed" };
  }
  await recordAudit(actor, {
    action: "update",
    entity: ENTITY[kind],
    entityId: id,
    diff: { active: { from: !active, to: active } },
  });
  await syncToStreampay(kind, id);
  revalidateAll();
  return { ok: true, id };
}

export async function deleteCatalogItem(kind: CatalogKind, id: string): Promise<ActionResult> {
  const actor = await requireCan("catalog.manage");
  const table = TABLES[kind];
  let gone: { name: Localized } | undefined;
  try {
    [gone] = await db.delete(table).where(eq(table.id, id)).returning({ name: table.name });
  } catch (err) {
    // services/removal_types are referenced by bookings with onDelete: restrict —
    // deleting one that has history would erase what a customer actually bought.
    // Deactivating is the right move there, and the UI says so.
    console.error("[catalog] delete blocked", err);
    return { ok: false, error: "in-use" };
  }

  await recordAudit(actor, { action: "delete", entity: ENTITY[kind], entityId: id, label: gone?.name });
  // Archived there after an hour (RETIRE_AFTER_MIN), not deleted: a checkout
  // already open can still be paid, and past invoices still name it.
  await retireProduct(productKey(kind, id));
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

  // `addon` and `upsell` share one table, and the admin lists them as two tabs
  // with their own arrows. Scoped, or moving an upsell would swap places with an
  // ordinary add-on that is nowhere near it on screen.
  const within =
    kind === "addon" || kind === "upsell"
      ? eq(addons.atCheckout, kind === "upsell")
      : undefined;

  const moved = await reorderBySort(TABLES[kind], id, direction, within);
  if (!moved) return { ok: true, id };

  await recordAudit(actor, {
    action: "reorder",
    entity: ENTITY[kind],
    entityId: id,
    diff: { sort: { from: moved.from, to: moved.to } },
  });
  revalidateAll();
  return { ok: true, id };
}
