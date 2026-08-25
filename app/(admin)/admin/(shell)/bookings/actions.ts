"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { createBooking, rescheduleBooking as moveBooking } from "@/lib/bookings";
import { inviteReview } from "@/lib/reviews/invite";
import { notifyTechnician, pickTechnician } from "@/lib/assign";

export type Result = { ok: true } | { ok: false; error: string };

const STATUSES = [
  "pending",
  "confirmed",
  "checked_in",
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

  // Entering a status stamps its moment (brief §3.2). Guarded on the transition
  // so re-saving the same status doesn't reset a clock the commission figures
  // are read from, and written here rather than derived from `updated_at`, which
  // moves on every unrelated edit.
  const entering = (to: (typeof STATUSES)[number]) => status === to && before.status !== to;
  const now = new Date();

  // Someone has to take her. Only picked when the booking doesn't already name a
  // technician, so a receptionist's override — or an assignment made in advance
  // — is never quietly overwritten.
  const technicianId =
    entering("checked_in") && !before.technicianId
      ? await pickTechnician(before.branchId)
      : before.technicianId;

  await db
    .update(bookings)
    .set({
      status,
      technicianId,
      checkedInAt: entering("checked_in") ? now : before.checkedInAt,
      startedAt: entering("in_progress") ? now : before.startedAt,
      cancelReason: status === "cancelled" ? (reason ?? null) : before.cancelReason,
      updatedAt: now,
    })
    .where(eq(bookings.id, id));

  await recordAudit(actor, {
    action: status === "cancelled" ? "cancel" : "update",
    entity: "bookings",
    entityId: id,
    diff: { status: { from: before.status, to: status } },
  });

  // Same bargain as inviteReview below: awaited, and never allowed to throw. The
  // customer is checked in and the work is already on the technician's screen —
  // this mail is the nudge, not the mechanism.
  if (entering("checked_in")) {
    await notifyTechnician(id);
  }

  // "End" is this, and nothing else (brief §2.9). Guarded on the *transition*
  // rather than the destination so re-saving a completed booking asks nobody
  // twice — though inviteReview would refuse anyway, since one invitation per
  // booking is a database constraint, not a check here.
  //
  // Awaited rather than fired and forgotten: on a serverless host the function
  // is frozen the moment this action returns, so a detached promise would never
  // finish. It never throws — the appointment is closed either way.
  if (status === "completed" && before.status !== "completed") {
    await inviteReview(id);
  }

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
 *
 * Gated on its own capability rather than bookings.manage, because brief §3.3
 * says an admin cannot change a booking's timing while still needing everything
 * else bookings.manage carries. See lib/auth/rbac.ts.
 */
export async function rescheduleBooking(input: {
  id: string;
  startsAt: string;
}): Promise<Result> {
  const actor = await requireCan("bookings.reschedule");
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

const resolveSchema = z.object({
  id: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});

/**
 * Clear a no-show flag once staff have dealt with the customer.
 *
 * Two states and an optional note, rather than a fixed list of outcomes. Nobody
 * knows yet how a missed customer actually gets settled — refunded, squeezed in
 * later, rebooked, or nothing at all — and a dropdown guessed now is a dropdown
 * everybody sets to "Other". Once there are real notes to read, the common
 * answers become buttons and this same column holds them.
 *
 * Touches nothing else: the status is already `no_show`, no money moves, and the
 * booking row is otherwise exactly as the sweep left it. The audit entry is the
 * record of who decided it was handled.
 */
export async function resolveNoShow(input: {
  id: string;
  note?: string;
}): Promise<Result> {
  const actor = await requireCan("bookings.manage");
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const note = parsed.data.note?.trim() || null;

  // Guarded on "still unresolved" as well as the id, so two receptionists
  // clearing the same row do not overwrite each other's note.
  const [row] = await db
    .update(bookings)
    .set({ noShowResolvedAt: new Date(), noShowNote: note, updatedAt: new Date() })
    .where(and(eq(bookings.id, parsed.data.id), isNull(bookings.noShowResolvedAt)))
    .returning({ id: bookings.id });

  if (!row) return { ok: false, error: "already-resolved" };

  await recordAudit(actor, {
    action: "resolve-no-show",
    entity: "bookings",
    entityId: parsed.data.id,
    diff: { noShowNote: { from: null, to: note } },
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
