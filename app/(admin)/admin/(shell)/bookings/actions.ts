"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { createBooking, rescheduleBooking as moveBooking } from "@/lib/bookings";

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

/**
 * Staff-side reschedule. The move itself lives in lib/bookings.ts, shared with
 * the customer's own reschedule; this wrapper is the part that is specific to
 * staff — the permission, the audit trail, and refreshing the calendar.
 *
 * Note there is no 3-hour window here. That limit is the customer's
 * (lib/cancellation.ts); the salon can move an appointment whenever it needs to.
 */
export async function rescheduleBooking(input: {
  id: string;
  startsAt: string;
}): Promise<Result> {
  const actor = await requireCan("bookings.manage");
  const parsed = rescheduleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const [before] = await db.select().from(bookings).where(eq(bookings.id, parsed.data.id)).limit(1);
  if (!before) return { ok: false, error: "not-found" };

  const startsAt = new Date(parsed.data.startsAt);
  const moved = await moveBooking({ id: before.id, startsAt });
  if (!moved.ok) return { ok: false, error: moved.error };

  await recordAudit(actor, {
    action: "reschedule",
    entity: "bookings",
    entityId: before.id,
    diff: { startsAt: { from: before.startsAt.toISOString(), to: startsAt.toISOString() } },
  });

  revalidate();
  return { ok: true };
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

const grantRefillSchema = z.object({
  id: z.string().uuid(),
  /**
   * Days from today. `0` withdraws the grant, falling back to whatever the
   * service's own `refill_days` allows — which may still be an open window, so
   * withdrawing is not the same as refusing.
   */
  days: z.number().int().min(0).max(365),
});

/**
 * Grant, extend, shorten or withdraw a booking's refill window by hand.
 *
 * Stored as a deadline rather than a day count so it cannot drift when someone
 * edits the service's `refill_days` afterwards — a customer who was told "you
 * have until the 18th" keeps until the 18th.
 *
 * Counted from *now*, not from the appointment: this is used when a customer
 * asks for more time, and they mean more time from today.
 *
 * The grant only sets a deadline. Every other rule in refillDaysLeft() still
 * applies — a cancelled booking, one that has not happened yet, or one whose
 * refill was already claimed stays ineligible however long the window.
 */
export async function grantRefill(input: {
  id: string;
  days: number;
}): Promise<Result & { expiresAt?: string | null }> {
  const actor = await requireCan("bookings.manage");

  const parsed = grantRefillSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const [before] = await db
    .select({ id: bookings.id, refillExpiresAt: bookings.refillExpiresAt })
    .from(bookings)
    .where(eq(bookings.id, parsed.data.id))
    .limit(1);
  if (!before) return { ok: false, error: "not-found" };

  const expiresAt =
    parsed.data.days > 0
      ? new Date(Date.now() + parsed.data.days * 86_400_000)
      : null;

  await db
    .update(bookings)
    .set({ refillExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(bookings.id, parsed.data.id));

  // Money-adjacent: a refill is a discount, so who granted it is auditable.
  await recordAudit(actor, {
    action: expiresAt ? "grant-refill" : "revoke-refill",
    entity: "bookings",
    entityId: parsed.data.id,
    diff: {
      refillExpiresAt: {
        from: before.refillExpiresAt?.toISOString() ?? null,
        to: expiresAt?.toISOString() ?? null,
      },
    },
  });

  revalidate();
  return { ok: true, expiresAt: expiresAt?.toISOString() ?? null };
}
