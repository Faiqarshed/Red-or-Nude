"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { branchHours, closures, stations } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { BRANCHES_TAG } from "@/lib/catalog";

export type Result = { ok: true } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/admin/availability");
  revalidatePath("/admin/bookings");
  revalidatePath("/booking");
  revalidateTag(BRANCHES_TAG);
}

const time = z.string().regex(/^\d{2}:\d{2}$/);

const hoursSchema = z.object({
  branchId: z.string().uuid(),
  weekday: z.number().int().min(0).max(6),
  opens: time,
  closes: time,
  closed: z.boolean(),
});

export async function saveBranchHours(input: z.input<typeof hoursSchema>): Promise<Result> {
  const actor = await requireCan("availability.manage");
  const parsed = hoursSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;

  // An open day that closes before it opens would generate no slots at all and
  // look like a mysterious empty calendar — reject it here instead.
  if (!d.closed && d.closes <= d.opens) return { ok: false, error: "closes-before-opens" };

  await db
    .insert(branchHours)
    .values({
      branchId: d.branchId,
      weekday: d.weekday,
      opens: `${d.opens}:00`,
      closes: `${d.closes}:00`,
      closed: d.closed,
    })
    .onConflictDoUpdate({
      target: [branchHours.branchId, branchHours.weekday],
      set: { opens: `${d.opens}:00`, closes: `${d.closes}:00`, closed: d.closed },
    });

  await recordAudit(actor, {
    action: "update",
    entity: "branch_hours",
    entityId: `${d.branchId}:${d.weekday}`,
    diff: { hours: { from: null, to: d.closed ? "closed" : `${d.opens}–${d.closes}` } },
  });

  revalidate();
  return { ok: true };
}

export async function addStation(branchId: string, label: string): Promise<Result> {
  const actor = await requireCan("availability.manage");
  const clean = label.trim().slice(0, 40);
  if (!clean) return { ok: false, error: "invalid" };

  const [row] = await db
    .insert(stations)
    .values({ branchId, label: clean, sort: 99 })
    .returning({ id: stations.id });

  await recordAudit(actor, { action: "create", entity: "stations", entityId: row.id });
  revalidate();
  return { ok: true };
}

export async function setStationActive(id: string, active: boolean): Promise<Result> {
  const actor = await requireCan("availability.manage");
  await db.update(stations).set({ active }).where(eq(stations.id, id));
  await recordAudit(actor, {
    action: "update",
    entity: "stations",
    entityId: id,
    diff: { active: { from: !active, to: active } },
  });
  revalidate();
  return { ok: true };
}

export async function deleteStation(id: string): Promise<Result> {
  const actor = await requireCan("availability.manage");
  try {
    await db.delete(stations).where(eq(stations.id, id));
  } catch {
    // Bookings reference stations with onDelete: set null, so this normally
    // succeeds; if a constraint ever blocks it, deactivating is the fallback.
    return { ok: false, error: "in-use" };
  }
  await recordAudit(actor, { action: "delete", entity: "stations", entityId: id });
  revalidate();
  return { ok: true };
}

const closureSchema = z.object({
  branchId: z.string().uuid().nullable(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reasonAr: z.string().max(120).optional(),
  reasonEn: z.string().max(120).optional(),
});

export async function addClosure(input: z.input<typeof closureSchema>): Promise<Result> {
  const actor = await requireCan("availability.manage");
  const parsed = closureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;
  if (d.to < d.from) return { ok: false, error: "to-before-from" };

  // Riyadh is UTC+3 with no DST; a closure covers whole local days.
  const startsAt = new Date(`${d.from}T00:00:00+03:00`);
  const endsAt = new Date(`${d.to}T00:00:00+03:00`);
  endsAt.setUTCDate(endsAt.getUTCDate() + 1);

  const [row] = await db
    .insert(closures)
    .values({
      branchId: d.branchId,
      startsAt,
      endsAt,
      reason: { ar: d.reasonAr ?? "", en: d.reasonEn ?? d.reasonAr ?? "" },
    })
    .returning({ id: closures.id });

  await recordAudit(actor, { action: "create", entity: "closures", entityId: row.id });
  revalidate();
  return { ok: true };
}

export async function deleteClosure(id: string): Promise<Result> {
  const actor = await requireCan("availability.manage");
  await db.delete(closures).where(eq(closures.id, id));
  await recordAudit(actor, { action: "delete", entity: "closures", entityId: id });
  revalidate();
  return { ok: true };
}
