"use server";

import { revalidatePath } from "next/cache";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings, stations } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { createBooking } from "@/lib/bookings";
import { findFreeStation } from "@/lib/availability";

export type Result = { ok: true } | { ok: false; error: string };

const STATUSES = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
] as const;

function revalidate() {
  revalidatePath("/admin/bookings");
  revalidatePath("/admin");
}

export async function setBookingStatus(
  id: string,
  status: (typeof STATUSES)[number],
  reason?: string,
): Promise<Result> {
  const actor = await requireCan("bookings.manage");
  if (!STATUSES.includes(status)) return { ok: false, error: "invalid-status" };

  const [before] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  if (!before) return { ok: false, error: "not-found" };

  await db
    .update(bookings)
    .set({
      status,
      cancelReason: status === "cancelled" ? (reason ?? null) : before.cancelReason,
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, id));

  await recordAudit(actor, {
    action: status === "cancelled" ? "cancel" : "update",
    entity: "bookings",
    entityId: id,
    diff: { status: { from: before.status, to: status } },
  });

  revalidate();
  return { ok: true };
}

const rescheduleSchema = z.object({
  id: z.string().uuid(),
  startsAt: z.string().datetime(),
});

export async function rescheduleBooking(input: {
  id: string;
  startsAt: string;
}): Promise<Result> {
  const actor = await requireCan("bookings.manage");
  const parsed = rescheduleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const [before] = await db.select().from(bookings).where(eq(bookings.id, parsed.data.id)).limit(1);
  if (!before) return { ok: false, error: "not-found" };

  // Keep the original duration — moving an appointment must not silently
  // shorten or lengthen it.
  const durationMs = before.endsAt.getTime() - before.startsAt.getTime();
  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(startsAt.getTime() + durationMs);

  // Its own chair is fair game; findFreeStation would otherwise see this very
  // booking as the conflict.
  const freeStation = await findFreeStationExcluding(before.branchId, startsAt, endsAt, before.id);
  if (!freeStation) return { ok: false, error: "slot-taken" };

  try {
    await db
      .update(bookings)
      .set({ startsAt, endsAt, stationId: freeStation, updatedAt: new Date() })
      .where(eq(bookings.id, before.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("bookings_station_slot_unique")) return { ok: false, error: "slot-taken" };
    console.error("[bookings] reschedule failed", err);
    return { ok: false, error: "failed" };
  }

  await recordAudit(actor, {
    action: "reschedule",
    entity: "bookings",
    entityId: before.id,
    diff: { startsAt: { from: before.startsAt.toISOString(), to: startsAt.toISOString() } },
  });

  revalidate();
  return { ok: true };
}

/** Like findFreeStation, but ignores one booking — used when moving it. */
async function findFreeStationExcluding(
  branchId: string,
  startsAt: Date,
  endsAt: Date,
  ignoreId: string,
): Promise<string | null> {
  const [stationRows, existing] = await Promise.all([
    db
      .select({ id: stations.id })
      .from(stations)
      .where(and(eq(stations.branchId, branchId), eq(stations.active, true))),
    db
      .select({ id: bookings.id, stationId: bookings.stationId, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(and(eq(bookings.branchId, branchId), ne(bookings.status, "cancelled"), ne(bookings.status, "no_show"))),
  ]);

  const taken = new Set(
    existing
      .filter((b) => b.id !== ignoreId && b.startsAt < endsAt && b.endsAt > startsAt)
      .map((b) => b.stationId)
      .filter(Boolean) as string[],
  );

  return stationRows.find((s) => !taken.has(s.id))?.id ?? null;
}

const walkInSchema = z.object({
  branchId: z.string().uuid(),
  serviceId: z.string().uuid(),
  addonIds: z.array(z.string().uuid()).default([]),
  removalTypeId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime(),
  name: z.string().trim().max(120).optional(),
  phone: z.string().trim().min(6).max(20),
  notes: z.string().max(500).optional(),
});

export type WalkInInput = z.input<typeof walkInSchema>;

export async function createWalkIn(input: WalkInInput): Promise<Result & { code?: string }> {
  const actor = await requireCan("bookings.manage");
  const parsed = walkInSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.path.join(".") ?? "invalid" };

  const data = parsed.data;
  const result = await createBooking({
    branchId: data.branchId,
    serviceId: data.serviceId,
    addonIds: data.addonIds,
    removalTypeId: data.removalTypeId ?? null,
    startsAt: data.startsAt,
    customer: { name: data.name, phone: data.phone },
    source: "walk_in",
    notes: data.notes,
  });

  if (!result.ok) return { ok: false, error: result.error };

  await recordAudit(actor, {
    action: "create",
    entity: "bookings",
    entityId: result.id,
    diff: { source: { from: null, to: "walk_in" } },
  });

  revalidate();
  return { ok: true, code: result.code };
}
