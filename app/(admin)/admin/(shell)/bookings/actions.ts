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
import { assignIfToday, notifyTechnician, pickTechnician } from "@/lib/assign";
import { getSettings } from "@/lib/settings";

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

  // Not before her slot (brief §3.1, and `checkin_early_min` in lib/settings.ts).
  //
  // This lives here, on the shared write path, rather than only at the front
  // desk. checkInTicket used to be the only caller that checked, so the bookings
  // drawer — which offers confirmed → checked_in so an admin can unstick a
  // ticket — walked straight past the rule and took a technician off the floor
  // hours early. Same reasoning as the technician assignment below: one write
  // path for the status means a second caller cannot forget what it entails.
  if (entering("checked_in")) {
    const { checkin_early_min: earlyMin } = await getSettings(["checkin_early_min"]);
    if (now.getTime() < before.startsAt.getTime() - earlyMin * 60_000) {
      return { ok: false, error: "too-early" };
    }
  }

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
      // She is here, so the "starting soon" mail has been overtaken by events.
      // Stamping it here is what stops the reminder job sending a second one.
      techNotifiedAt: entering("checked_in") ? now : before.techNotifiedAt,
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
 * Gated on its own capability rather than bookings.manage. Brief §3.3 withheld
 * timing changes from admin while admin still needed everything else
 * bookings.manage carries, which is what forced the two apart. The salon has
 * since granted it to admin as well (see lib/auth/rbac.ts), so today the
 * capability separates technicians from everyone else — but keeping it separate
 * is what makes that a one-line decision either way.
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

  // Only an appointment that has not started yet.
  //
  // moveBooking empties `technician_id` so the automation can re-staff the new
  // time, and that automation (assignDay) only refills rows still reading
  // `confirmed`. So moving a `checked_in` booking strips the name off a
  // customer who is sitting in the chair and nothing ever puts it back; on a
  // `completed` one it also takes the attribution lib/reviews resolves by
  // joining this column.
  //
  // docs/LIVE-ASSIGNMENT.md §6 said to add this on the same commit as the
  // button that calls it. This is that commit. BookingDrawer stops offering
  // Change time past this point too — but the drawer is the courtesy and this
  // is the rule, which is the whole reason it lives here.
  if (before.status !== "pending" && before.status !== "confirmed") {
    return { ok: false, error: "not-movable" };
  }

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

  const [before] = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, parsed.data.id))
    .limit(1);
  if (!before) return { ok: false, error: "not-found" };

  // Closing the flag with a reason *is* the cancellation: she did not come, the
  // chair was given back hours ago, and leaving the row reading `no_show`
  // forever was the reason this queue only ever grew. The reason is written to
  // `cancel_reason` as well as `no_show_note` so the booking drawer shows it in
  // the place every other cancelled booking keeps its reason — one fact, not a
  // second one that only this screen knows about.
  //
  // Rescheduling instead is the other way out; see rescheduleNoShow.
  //
  // Guarded on "still unresolved" as well as the id, so two receptionists
  // clearing the same row do not overwrite each other's note.
  const [row] = await db
    .update(bookings)
    .set({
      status: "cancelled",
      cancelReason: note,
      noShowResolvedAt: new Date(),
      noShowNote: note,
      updatedAt: new Date(),
    })
    .where(and(eq(bookings.id, parsed.data.id), isNull(bookings.noShowResolvedAt)))
    .returning({ id: bookings.id });

  if (!row) return { ok: false, error: "already-resolved" };

  await recordAudit(actor, {
    action: "resolve-no-show",
    entity: "bookings",
    entityId: parsed.data.id,
    diff: {
      status: { from: before.status, to: "cancelled" },
      noShowNote: { from: null, to: note },
    },
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

/**
 * The other way out of the no-show queue: give her a new time.
 *
 * Deliberately not `rescheduleBooking` above, which refuses anything past
 * `confirmed` — and refuses it for a good reason, since moving a row the
 * automation will not re-staff strips a technician off a live appointment. This
 * one is that same move done safely: the booking goes back to `confirmed`
 * *before* the floor is re-dealt, so it is a row assignDay will actually fill.
 *
 * The flag is cleared rather than resolved-with-a-note. She has a real
 * appointment again, and it has to be able to be missed again — an unresolved
 * `no_show_at` left on the row would make sweepNoShows skip it for good
 * (`no_show_at is null` is what makes that job idempotent). What happened is
 * kept where history belongs, in the audit trail.
 */
export async function rescheduleNoShow(input: {
  id: string;
  startsAt: string;
}): Promise<Result> {
  const actor = await requireCan("bookings.reschedule");
  const parsed = rescheduleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const [before] = await db.select().from(bookings).where(eq(bookings.id, parsed.data.id)).limit(1);
  if (!before) return { ok: false, error: "not-found" };
  if (!before.noShowAt || before.noShowResolvedAt) {
    return { ok: false, error: "already-resolved" };
  }

  // Move first. It can refuse — the chair may have gone in the meantime — and
  // nothing above should have changed by then.
  const startsAt = new Date(parsed.data.startsAt);
  const moved = await moveBooking({ id: before.id, startsAt });
  if (!moved.ok) return { ok: false, error: moved.error };

  await db
    .update(bookings)
    .set({
      status: "confirmed",
      noShowAt: null,
      noShowResolvedAt: null,
      noShowNote: null,
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, before.id));

  // moveBooking emptied the technician and re-dealt the day, but the row was
  // still `no_show` at that moment and assignDay only fills confirmed ones. Now
  // that it is confirmed, ask again.
  await assignIfToday(before.branchId, startsAt);

  await recordAudit(actor, {
    action: "reschedule-no-show",
    entity: "bookings",
    entityId: before.id,
    diff: {
      status: { from: before.status, to: "confirmed" },
      startsAt: { from: before.startsAt.toISOString(), to: startsAt.toISOString() },
    },
  });

  revalidate();
  return { ok: true };
}
